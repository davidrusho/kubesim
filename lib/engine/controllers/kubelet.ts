// The kubelet: runs on every live Node. Mounts volumes, sets up Pod
// sandboxes, pulls images, resolves env, runs container Programs, probes
// containers (startup, liveness, readiness), restarts with CrashLoopBackOff,
// enforces memory limits, terminates deleted Pods, and writes Pod status.
// Timings follow the behaviour reference §2 and v2 §1.

import { isPodTerminal, type Cluster, type ContainerRuntime, type PodRuntime, type ProbeState } from "../cluster";
import { containerProgram, imageDigest, listenPorts, lookupImage, pullError, type ImageInfo, type Program } from "../images";
import { execEnv, runArgv, runRedirected } from "../exec";
import { projectVolume } from "../fs";
import { containerLimits, qosClass, milliCpu, bytes } from "../quantity";
import type { Condition, ConfigMap, Container, ContainerState, ContainerStatus, Node, PersistentVolumeClaim, Pod, PodPhase, PodStatus, Probe, Secret, Service } from "../types";
import { deepEqual, goDuration, unixDate } from "../util";
import { kubeletConditions } from "../nodes";
import { kubeletPosting } from "../hostservices";
import { staticPodFault } from "./staticpods";
import { containerMemory } from "./metrics";

export { goDuration, unixDate } from "../util";

const SANDBOX_MS = 600;
const CREATE_MS = 400;
const EXITED_VISIBLE_MS = 1000;
const INITIAL_BACKOFF = 10_000;
const MAX_BACKOFF = 300_000;
const HEARTBEAT_MS = 10_000;
const CONFIG_RETRY_MS = 10_000;
const MOUNT_RETRY_MS = 8_000;
/** kubelet sync period + ConfigMap cache TTL: projected volumes catch up within about a minute. */
const VOLUME_RESYNC_MS = 60_000;

function pullMs(sizeBytes: number): number {
  // ~40 MB/s plus registry round trips.
  return Math.round(800 + (sizeBytes / 40_000_000) * 1000);
}

export function runKubelets(cluster: Cluster): void {
  const now = cluster.now;
  for (const node of cluster.list<Node>("Node")) {
    const rt = cluster.state.nodes[node.metadata.name];
    // A Node with power but no running kubelet posts nothing; its containers carry on (ADR 0003, decision 2).
    if (!rt || !kubeletPosting(cluster, node.metadata.name)) continue;
    rt.lastHeartbeat = now;
    // Node status heartbeat.
    const ready = now >= rt.readyAt;
    const readyCond = node.status?.conditions.find((c) => c.type === "Ready");
    const wantReady = ready ? "True" : "False";
    if (!readyCond || readyCond.status !== wantReady || now - (readyCond.lastHeartbeatTime ?? 0) >= HEARTBEAT_MS) {
      cluster.update(node, (n) => {
        const fresh = kubeletConditions(now, ready);
        n.status!.conditions = fresh.map((c) => {
          const old = n.status!.conditions.find((o) => o.type === c.type);
          return old && old.status === c.status ? { ...c, lastTransitionTime: old.lastTransitionTime } : c;
        });
      });
      if (readyCond && readyCond.status !== "True" && wantReady === "True") {
        cluster.record(node, "Normal", "NodeReady", `Node ${node.metadata.name} status is now: NodeReady`, "kubelet", node.metadata.name);
      }
    }
  }

  for (const pod of cluster.list<Pod>("Pod")) {
    const nodeName = pod.spec?.nodeName;
    if (!nodeName) continue;
    const nrt = cluster.state.nodes[nodeName];
    if (!nrt || !kubeletPosting(cluster, nodeName)) continue;
    syncPod(cluster, pod, nodeName);
  }
}

/** Whether a container's main process exits promptly on SIGTERM (servers do; a shell as PID 1 doesn't). */
function handlesSigterm(c: Container, info: ImageInfo | undefined, crt: ContainerRuntime): boolean {
  if (!info) return true;
  if (info.repo.startsWith("registry.k8s.io/") && !info.shell) return true;
  if (c.command && c.command.some((w) => /(^|\/)(sh|bash|ash)$/.test(w))) return false;
  return info.termExit !== undefined && crt.program?.some((o) => o.op === "serve") === true && !c.command;
}

const newContainer = (image: string): ContainerRuntime => ({ phase: "pulling", until: 0, image, backoffMs: 0, pc: 0, wakeAt: 0, restarts: 0 });

type RestartPolicy = "Always" | "OnFailure" | "Never";

const isSidecar = (c: Container) => c.restartPolicy === "Always";

/** Every container the kubelet runs for a Pod: init containers (in order), then the app containers. */
function allContainers(pod: Pod): Container[] {
  return [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
}

/** Lowest free host address in the Node's /24 at or after the cursor (host-local IPAM: round-robin, freed IPs reused). */
function allocPodIp(cluster: Cluster, nodeName: string): string | undefined {
  const nrt = cluster.state.nodes[nodeName];
  const prefix = `10.244.${nrt.index}.`;
  const used = new Set<number>();
  for (const p of cluster.list<Pod>("Pod")) {
    const ip = p.status?.podIP;
    if (p.spec?.nodeName === nodeName && ip?.startsWith(prefix)) used.add(parseInt(ip.slice(prefix.length), 10));
  }
  const start = nrt.nextPodIp >= 2 && nrt.nextPodIp <= 254 ? nrt.nextPodIp : 2;
  for (let i = 0; i < 253; i++) {
    const n = 2 + ((start - 2 + i) % 253);
    if (used.has(n)) continue;
    nrt.nextPodIp = n === 254 ? 2 : n + 1;
    return prefix + n;
  }
  return undefined;
}

/** A container whose program threw (a bug, or input we can't model): it fails like a crashed process, without stopping the cluster. */
function crashContainer(cluster: Cluster, crt: ContainerRuntime, e: unknown): void {
  crt.exitCode = 1;
  crt.exitReason = "Error";
  crt.exitMessage = `kubesim: ${(e as Error)?.message ?? String(e)}`;
  crt.phase = "exited";
  crt.until = cluster.now + EXITED_VISIBLE_MS;
  crt.startedAt ??= cluster.now;
  crt.lastRunStart ??= cluster.now;
  cluster.markChanged();
}

function syncPod(cluster: Cluster, pod: Pod, nodeName: string): void {
  const now = cluster.now;
  const uid = pod.metadata.uid;
  const nrt = cluster.state.nodes[nodeName];
  let prt = cluster.state.pods[uid];

  // --- deletion ---
  if (pod.metadata.deletionTimestamp !== undefined) {
    if (!prt || isPodTerminal(pod)) {
      cluster.remove(pod);
      return;
    }
    if (prt.stoppingUntil === undefined) {
      let slow = false;
      for (const c of allContainers(pod)) {
        const crt = prt.containers[c.name];
        if (!crt || (crt.phase !== "running" && crt.phase !== "stopping")) continue;
        const { info } = lookupImage(c.image);
        if (!handlesSigterm(c, info, crt)) slow = true;
        crt.phase = "stopping";
        crt.killAt = undefined;
        crt.ready = false;
        cluster.record(pod, "Normal", "Killing", `Stopping container ${c.name}`, "kubelet", nodeName, `spec.containers{${c.name}}`);
      }
      prt.stoppingUntil = slow ? pod.metadata.deletionTimestamp : Math.min(now + 1000, pod.metadata.deletionTimestamp);
      cluster.markChanged();
    }
    if (now >= prt.stoppingUntil) {
      cluster.remove(pod);
      return;
    }
    writeStatus(cluster, pod, prt, nodeName);
    return;
  }

  if (isPodTerminal(pod) && prt && Object.values(prt.containers).every((c) => c.phase === "done")) return;

  // --- volumes: ConfigMaps, Secrets and PVCs must exist (and PVCs be bound) before the sandbox starts ---
  if (!prt || prt.mountedAt === undefined) {
    const missing = unmountable(cluster, pod);
    if (missing) {
      if (!prt) {
        prt = cluster.state.pods[uid] = { containers: {}, sandboxAt: Infinity };
        for (const c of allContainers(pod)) prt.containers[c.name] = newContainer(c.image);
      }
      if (missing.event && now >= (prt.mountRetryAt ?? 0)) {
        cluster.record(pod, "Warning", "FailedMount", missing.event, "kubelet", nodeName);
        prt.mountRetryAt = now + MOUNT_RETRY_MS;
      }
      writeStatus(cluster, pod, prt, nodeName);
      return;
    }
    if (!prt) {
      prt = cluster.state.pods[uid] = { containers: {}, sandboxAt: now + SANDBOX_MS };
      for (const c of allContainers(pod)) prt.containers[c.name] = newContainer(c.image);
    }
    if (prt.sandboxAt === Infinity) prt.sandboxAt = now + SANDBOX_MS;
    prt.mountedAt = now;
    projectAll(cluster, pod, prt);
    cluster.markChanged();
  }
  if (now < prt.sandboxAt) {
    writeStatus(cluster, pod, prt, nodeName);
    return;
  }
  if (!pod.status?.podIP) {
    const hostIp = `172.18.0.${nrt.index + 2}`;
    const hostNet = pod.spec?.hostNetwork;
    const ip = hostNet ? hostIp : allocPodIp(cluster, nodeName);
    if (!ip) {
      // No free address in the Node's Pod CIDR: the sandbox can't be set up yet.
      if (now >= (prt.mountRetryAt ?? 0)) {
        cluster.record(pod, "Warning", "FailedCreatePodSandBox", `Failed to create pod sandbox: rpc error: code = Unknown desc = failed to setup network for sandbox: plugin type="ptp" failed (add): failed to allocate for range 0: no IP addresses available in range set: 10.244.${nrt.index}.1-10.244.${nrt.index}.254`, "kubelet", nodeName);
        prt.mountRetryAt = now + MOUNT_RETRY_MS;
      }
      writeStatus(cluster, pod, prt, nodeName);
      return;
    }
    cluster.update(pod, (p) => {
      p.status = { ...(p.status as PodStatus), podIP: ip, podIPs: [{ ip }], hostIP: hostIp, startTime: now };
    });
    pod = cluster.get<Pod>("Pod", pod.metadata.namespace, pod.metadata.name);
  }

  // ConfigMap/Secret volumes catch up with edits on the kubelet's periodic sync.
  if (now - (prt.projectedAt ?? 0) >= VOLUME_RESYNC_MS) projectAll(cluster, pod, prt, true);

  // activeDeadlineSeconds: the kubelet kills the whole Pod and fails it.
  const ads = pod.spec?.activeDeadlineSeconds;
  if (ads !== undefined && pod.status?.startTime !== undefined && now - pod.status.startTime >= ads * 1000 && !isPodTerminal(pod)) {
    for (const c of allContainers(pod)) {
      const crt = prt.containers[c.name];
      if (!crt) continue;
      if (crt.phase === "running" || crt.phase === "stopping") {
        crt.exitCode = 137;
        crt.exitReason = "Error";
        crt.until = now;
      }
      crt.phase = "done";
    }
    prt.failedReason = { reason: "DeadlineExceeded", message: `Pod was active on the node longer than the specified deadline` };
    cluster.record(pod, "Normal", "DeadlineExceeded", "Pod was active on the node longer than the specified deadline", "kubelet", nodeName);
    cluster.markChanged();
    writeStatus(cluster, pod, prt, nodeName);
    return;
  }

  const podPolicy: RestartPolicy = pod.spec?.restartPolicy ?? "Always";
  const step = (c: Container, crt: ContainerRuntime, policy: RestartPolicy) => {
    try {
      stepContainer(cluster, pod, c, crt, nodeName, policy);
    } catch (e) {
      crashContainer(cluster, crt, e);
    }
  };

  // Init containers run one at a time, in order; each must exit 0 before the next starts.
  // Sidecars (restartPolicy: Always) only need to have started, and then keep running.
  let initialized = true;
  for (const c of pod.spec?.initContainers ?? []) {
    const crt = (prt.containers[c.name] ??= newContainer(c.image));
    if (isSidecar(c)) {
      step(c, crt, "Always");
      // Once the Pod is initialized, a sidecar restarting doesn't hold the app containers back.
      if (!(crt.phase === "running" && crt.started) && !prt.initialized) {
        initialized = false;
        break;
      }
      continue;
    }
    if (crt.phase === "done" && (crt.exitCode ?? 0) === 0) continue;
    step(c, crt, podPolicy === "Never" ? "Never" : "OnFailure");
    if (!(crt.phase === "done" && (crt.exitCode ?? 0) === 0)) {
      initialized = false;
      break;
    }
  }
  prt.initialized = initialized;
  if (!initialized) {
    writeStatus(cluster, pod, prt, nodeName);
    return;
  }

  for (const c of pod.spec!.containers) {
    let crt = prt.containers[c.name];
    if (!crt) crt = prt.containers[c.name] = newContainer(c.image);
    // Image changed (kubectl set image on a bare Pod): kill and restart with the new image.
    if (crt.image !== c.image && crt.phase !== "pulling") {
      if (crt.phase === "running") {
        cluster.record(pod, "Normal", "Killing", `Container ${c.name} definition changed, will be restarted`, "kubelet", nodeName, `spec.containers{${c.name}}`);
        crt.lastTerm = { exitCode: 0, reason: "Completed", startedAt: crt.startedAt, finishedAt: now };
        crt.restarts++;
      }
      crt.image = c.image;
      crt.phase = "pulling";
      crt.pullStartedAt = undefined;
      crt.backoffMs = 0;
      cluster.markChanged();
    }
    step(c, crt, podPolicy);
  }
  // When every app container has finished for good, the kubelet stops the sidecars too.
  if (pod.spec!.containers.every((c) => prt!.containers[c.name]?.phase === "done")) {
    for (const c of (pod.spec?.initContainers ?? []).filter(isSidecar)) {
      const crt = prt.containers[c.name];
      if (!crt || crt.phase === "done") continue;
      crt.exitCode = 0;
      crt.exitReason = "Completed";
      crt.until = now;
      crt.phase = "done";
      cluster.markChanged();
    }
  }
  writeStatus(cluster, pod, prt, nodeName);
}

/** Why a Pod's volumes can't be set up yet, or undefined if they can. */
function unmountable(cluster: Cluster, pod: Pod): { event?: string } | undefined {
  const ns = pod.metadata.namespace ?? "default";
  for (const v of pod.spec?.volumes ?? []) {
    if (v.configMap && !v.configMap.optional && !cluster.raw("ConfigMap", ns, v.configMap.name)) {
      return { event: `MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found` };
    }
    if (v.secret && !v.secret.optional && !cluster.raw("Secret", ns, v.secret.secretName)) {
      return { event: `MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found` };
    }
    if (v.persistentVolumeClaim) {
      const pvc = cluster.raw("PersistentVolumeClaim", ns, v.persistentVolumeClaim.claimName) as unknown as PersistentVolumeClaim | undefined;
      // The scheduler already refused Pods whose claims are missing; here we wait for binding.
      if (!pvc || pvc.status?.phase !== "Bound" || !pvc.spec?.volumeName) return {};
    }
  }
  return undefined;
}

function projectAll(cluster: Cluster, pod: Pod, prt: PodRuntime, refresh = false): void {
  const ns = pod.metadata.namespace ?? "default";
  prt.projected ??= {};
  prt.projectedAt = cluster.now;
  for (const v of pod.spec?.volumes ?? []) {
    if (!v.configMap && !v.secret) continue;
    const files = projectVolume(cluster, ns, v);
    if (files && !deepEqual(files, prt.projected[v.name])) {
      prt.projected[v.name] = files;
      cluster.markChanged();
    }
  }
  if (refresh) return;
  // subPath mounts copy one file at start and never update.
  prt.subPaths ??= {};
  for (const c of pod.spec?.containers ?? []) {
    for (const m of c.volumeMounts ?? []) {
      if (!m.subPath) continue;
      const files = prt.projected[m.name];
      if (files) prt.subPaths[`${c.name}/${m.mountPath}`] = { "": files[m.subPath] ?? "" };
    }
  }
}

// ---------- environment ----------

/** Any printable ASCII except '=' (RelaxedEnvironmentVariableValidation, GA). */
const ENV_NAME = /^[!-<>-~]+$/;

/** $(VAR) in command/args, expanded from env; $$ escapes; unknown references stay as written. */
function expandCommand(c: Container, env: Record<string, string>): Container {
  const x = (w: string) => w.replace(/\$\$|\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (m, n) => (m === "$$" ? "$" : (env[n] ?? m)));
  return { ...c, ...(c.command ? { command: c.command.map(x) } : {}), ...(c.args ? { args: c.args.map(x) } : {}) };
}

const b64 = (s: string) => {
  try {
    return typeof atob === "function" ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, "base64").toString("utf8");
  } catch {
    return s;
  }
};

/** Resolves a container's environment, as the kubelet does at container start. */
export function resolveEnv(cluster: Cluster, pod: Pod, c: Container): { env: Record<string, string> } | { error: string } {
  const ns = pod.metadata.namespace ?? "default";
  const env: Record<string, string> = {};
  // Service links: the Services that existed when the container started, plus `kubernetes`.
  const kube = cluster.raw("Service", "default", "kubernetes") as unknown as Service | undefined;
  const links = pod.spec?.enableServiceLinks === false ? [] : cluster.list<Service>("Service", ns).filter((s) => s.spec?.clusterIP && s.spec.clusterIP !== "None" && s !== (kube as unknown));
  for (const s of [...(kube ? [kube] : []), ...links.filter((s) => s.metadata.uid !== kube?.metadata.uid)]) {
    // Docker-links style variables (pkg/kubelet/envvars): one set per port, the first also as the default.
    const name = s.metadata.name.toUpperCase().replace(/-/g, "_");
    const ports = s.spec?.ports ?? [];
    if (!ports.length) continue;
    const ip = s.spec!.clusterIP!;
    const first = ports[0];
    env[`${name}_SERVICE_HOST`] = ip;
    env[`${name}_SERVICE_PORT`] = String(first.port);
    for (const p of ports) if (p.name) env[`${name}_SERVICE_PORT_${p.name.toUpperCase().replace(/-/g, "_")}`] = String(p.port);
    env[`${name}_PORT`] = `${(first.protocol ?? "TCP").toLowerCase()}://${ip}:${first.port}`;
    for (const p of ports) {
      const proto = (p.protocol ?? "TCP").toUpperCase();
      const pre = `${name}_PORT_${p.port}_${proto}`;
      env[pre] = `${proto.toLowerCase()}://${ip}:${p.port}`;
      env[`${pre}_PROTO`] = proto.toLowerCase();
      env[`${pre}_PORT`] = String(p.port);
      env[`${pre}_ADDR`] = ip;
    }
  }
  for (const src of c.envFrom ?? []) {
    const pre = src.prefix ?? "";
    if (src.configMapRef) {
      const cm = cluster.raw("ConfigMap", ns, src.configMapRef.name) as unknown as ConfigMap | undefined;
      if (!cm) {
        if (src.configMapRef.optional) continue;
        return { error: `configmap "${src.configMapRef.name}" not found` };
      }
      for (const [k, v] of Object.entries(cm.data ?? {})) if (ENV_NAME.test(pre + k)) env[pre + k] = v;
    }
    if (src.secretRef) {
      const s = cluster.raw("Secret", ns, src.secretRef.name) as unknown as Secret | undefined;
      if (!s) {
        if (src.secretRef.optional) continue;
        return { error: `secret "${src.secretRef.name}" not found` };
      }
      for (const [k, v] of Object.entries(s.data ?? {})) if (ENV_NAME.test(pre + k)) env[pre + k] = b64(v);
    }
  }
  for (const e of c.env ?? []) {
    if (e.value !== undefined || !e.valueFrom) {
      // $(VAR) refers to variables defined earlier in the list.
      env[e.name] = (e.value ?? "").replace(/\$\$|\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (m, n) => (m === "$$" ? "$" : (env[n] ?? m)));
      continue;
    }
    const vf = e.valueFrom;
    if (vf.configMapKeyRef) {
      const r = vf.configMapKeyRef;
      const cm = cluster.raw("ConfigMap", ns, r.name) as unknown as ConfigMap | undefined;
      if (!cm) {
        if (r.optional) continue;
        return { error: `configmap "${r.name}" not found` };
      }
      if (cm.data?.[r.key] === undefined) {
        if (r.optional) continue;
        return { error: `couldn't find key ${r.key} in ConfigMap ${ns}/${r.name}` };
      }
      env[e.name] = cm.data[r.key];
    } else if (vf.secretKeyRef) {
      const r = vf.secretKeyRef;
      const s = cluster.raw("Secret", ns, r.name) as unknown as Secret | undefined;
      if (!s) {
        if (r.optional) continue;
        return { error: `secret "${r.name}" not found` };
      }
      if (s.data?.[r.key] === undefined) {
        if (r.optional) continue;
        return { error: `couldn't find key ${r.key} in Secret ${ns}/${r.name}` };
      }
      env[e.name] = b64(s.data[r.key]);
    } else if (vf.fieldRef) {
      env[e.name] = fieldValue(pod, vf.fieldRef.fieldPath);
    } else if (vf.resourceFieldRef) {
      const target = pod.spec!.containers.find((x) => x.name === (vf.resourceFieldRef!.containerName || c.name)) ?? c;
      const [kind, res] = vf.resourceFieldRef.resource.split(".");
      const q = target.resources?.[kind as "limits" | "requests"]?.[res];
      if (res === "cpu") env[e.name] = String(Math.max(1, Math.ceil((q ? milliCpu(q) : 4000) / milliCpu(vf.resourceFieldRef.divisor ?? "1"))));
      else env[e.name] = String(Math.ceil((q ? bytes(q) : 8336990208) / (bytes(vf.resourceFieldRef.divisor ?? "1") || 1)));
    }
  }
  return { env };
}

function fieldValue(pod: Pod, path: string): string {
  const lab = path.match(/^metadata\.(labels|annotations)\['(.+)'\]$/);
  if (lab) return (lab[1] === "labels" ? pod.metadata.labels : pod.metadata.annotations)?.[lab[2]] ?? "";
  switch (path) {
    case "metadata.name":
      return pod.metadata.name;
    case "metadata.namespace":
      return pod.metadata.namespace ?? "default";
    case "metadata.uid":
      return pod.metadata.uid;
    case "spec.nodeName":
      return pod.spec?.nodeName ?? "";
    case "spec.serviceAccountName":
      return pod.spec?.serviceAccountName ?? "default";
    case "status.podIP":
      return pod.status?.podIP ?? "";
    case "status.hostIP":
      return pod.status?.hostIP ?? "";
  }
  return "";
}

// ---------- containers ----------

function stepContainer(cluster: Cluster, pod: Pod, c: Container, crt: ContainerRuntime, nodeName: string, policy: RestartPolicy): void {
  const now = cluster.now;
  const nrt = cluster.state.nodes[nodeName];
  const fp = `spec.containers{${c.name}}`;
  const ev = (type: "Normal" | "Warning", reason: string, msg: string) => cluster.record(pod, type, reason, msg, "kubelet", nodeName, fp);
  const { ref, info, tagOk } = lookupImage(c.image);
  const set = (phase: ContainerRuntime["phase"], until = 0) => {
    crt.phase = phase;
    crt.until = until;
    cluster.markChanged();
  };

  switch (crt.phase) {
    case "pulling": {
      const present = nrt.images.includes(ref.full);
      const policy = c.imagePullPolicy ?? "IfNotPresent";
      if (crt.pullStartedAt === undefined) {
        if (policy === "Never" || (present && policy === "IfNotPresent")) {
          if (!present) {
            // ErrImageNeverPull: stays waiting.
            if (crt.exitReason !== "ErrImageNeverPull") {
              crt.exitReason = "ErrImageNeverPull";
              ev("Warning", "ErrImageNeverPull", `Container image "${c.image}" is not present with pull policy of Never`);
              cluster.markChanged();
            }
            return;
          }
          ev("Normal", "Pulled", `Container image "${c.image}" already present on machine and can be verified`);
          set("creating", now + CREATE_MS);
          return;
        }
        crt.pullStartedAt = now;
        ev("Normal", "Pulling", `Pulling image "${c.image}"`);
        cluster.markChanged();
      }
      const dur = present ? 700 : pullMs(info?.sizeBytes ?? 20_000_000);
      if (now - crt.pullStartedAt < (tagOk ? dur : 1500)) return;
      if (!tagOk) {
        const err = pullError(ref, info);
        crt.exitMessage = err;
        ev("Warning", "Failed", `Failed to pull image "${c.image}": ${err}`);
        ev("Warning", "Failed", "Error: ErrImagePull");
        crt.backoffMs = crt.backoffMs ? Math.min(crt.backoffMs * 2, MAX_BACKOFF) : INITIAL_BACKOFF;
        crt.pullStartedAt = undefined;
        // ErrImagePull shows briefly, then ImagePullBackOff until the window ends.
        set("pullError", now + 1500);
        return;
      }
      if (!present) nrt.images.push(ref.full);
      const secs = (dur / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
      ev("Normal", "Pulled", `Successfully pulled image "${c.image}" in ${secs}s (${secs}s including waiting). Image size: ${info!.sizeBytes} bytes.`);
      crt.pullStartedAt = undefined;
      crt.backoffMs = 0;
      set("creating", now + CREATE_MS);
      return;
    }
    case "pullError":
      if (now >= crt.until) {
        ev("Normal", "BackOff", `Back-off pulling image "${c.image}"`);
        ev("Warning", "Failed", "Error: ImagePullBackOff");
        set("pullBackoff", now - 1500 + crt.backoffMs);
      }
      return;
    case "pullBackoff":
      if (now >= crt.until) set("pulling");
      return;
    case "configError":
      if (now >= crt.until) set("creating", now);
      return;
    case "creating": {
      if (now < crt.until) return;
      const envr = resolveEnv(cluster, pod, c);
      if ("error" in envr) {
        crt.exitMessage = envr.error;
        ev("Warning", "Failed", `Error: ${envr.error}`);
        set("configError", now + CONFIG_RETRY_MS);
        return;
      }
      const sc = { ...(pod.spec?.securityContext ?? {}), ...((c as { securityContext?: Record<string, unknown> }).securityContext ?? {}) } as { runAsNonRoot?: boolean; runAsUser?: number };
      if (sc.runAsNonRoot && !sc.runAsUser) {
        const why = sc.runAsUser === 0 ? `container's runAsUser breaks non-root policy (pod: "${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})", container: ${c.name})` : "container has runAsNonRoot and image will run as root " + `(pod: "${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})", container: ${c.name})`;
        crt.exitMessage = why;
        ev("Warning", "Failed", `Error: ${why}`);
        set("configError", now + CONFIG_RETRY_MS);
        return;
      }
      crt.env = envr.env;
      const hostname = pod.spec?.hostname ?? pod.metadata.name;
      // The kubelet expands $(VAR) in command and args from the container's env ($$ escapes).
      // A control-plane manifest with a wrong flag makes the process exit (or give up after a while) instead of serving.
      const fault = staticPodFault(cluster, pod, c, nodeName);
      const res = fault ? { ok: true as const, program: fault } : containerProgram(expandCommand(c, envr.env), info!, envr.env, hostname);
      if (!res.ok) {
        ev("Normal", "Created", "Container created");
        ev("Warning", "Failed", `Error: ${res.message}`);
        crt.startedAt = now;
        crt.lastRunStart = now;
        crt.exitCode = 128;
        crt.exitReason = "StartError";
        crt.exitMessage = res.message;
        set("exited", now + EXITED_VISIBLE_MS);
        return;
      }
      ev("Normal", "Created", "Container created");
      ev("Normal", "Started", "Container started");
      crt.program = res.program;
      crt.pc = 0;
      crt.loopVars = undefined;
      crt.loopIdx = undefined;
      crt.wakeAt = 0;
      crt.startedAt = now;
      crt.lastRunStart = now;
      crt.exitCode = undefined;
      crt.exitReason = undefined;
      crt.exitMessage = undefined;
      crt.lastCode = 0;
      crt.alloc = 0;
      crt.burn = 0;
      crt.reqs = [];
      crt.killAt = undefined;
      crt.ready = false;
      crt.started = !c.startupProbe;
      crt.probes = {};
      // A fresh writable layer from the image.
      crt.fs = { ...(info?.files ?? {}) };
      set("running");
      runProgram(cluster, pod, c, crt);
      return;
    }
    case "running":
      runProgram(cluster, pod, c, crt);
      if (crt.phase === "running") probe(cluster, pod, c, crt, nodeName);
      return;
    case "stopping": {
      // Killed by a failed liveness or startup probe: exits after SIGTERM (or SIGKILL at the grace period).
      if (crt.killAt === undefined || now < crt.killAt) return;
      const handles = handlesSigterm(c, info, crt);
      const code = handles ? (info?.termExit ?? 143) : 137;
      crt.exitCode = code;
      crt.exitReason = code === 0 ? "Completed" : "Error";
      crt.killAt = undefined;
      set("exited", now + EXITED_VISIBLE_MS);
      return;
    }
    case "exited": {
      if (now < crt.until) return;
      const restart = policy === "Always" || (policy === "OnFailure" && crt.exitCode !== 0);
      if (!restart) {
        set("done");
        return;
      }
      crt.lastTerm = { exitCode: crt.exitCode ?? 0, reason: crt.exitReason ?? "Error", startedAt: crt.startedAt, finishedAt: crt.until - EXITED_VISIBLE_MS, message: crt.exitMessage };
      const ranMs = crt.lastTerm.finishedAt - (crt.lastRunStart ?? 0);
      if (ranMs > 600_000) crt.backoffMs = 0;
      if (crt.backoffMs === 0) {
        // First failure: restart at once, then back off from 10s.
        crt.backoffMs = INITIAL_BACKOFF;
        crt.restarts++;
        set("creating", now + CREATE_MS);
      } else {
        ev("Warning", "BackOff", "Back-off restarting failed container " + c.name + " in pod " + `${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`);
        set("crashBackoff", crt.lastTerm.finishedAt + crt.backoffMs);
      }
      return;
    }
    case "crashBackoff":
      if (now >= crt.until) {
        crt.backoffMs = Math.min(crt.backoffMs * 2, MAX_BACKOFF);
        crt.restarts++;
        ev("Normal", "Pulled", `Container image "${c.image}" already present on machine and can be verified`);
        set("creating", now + CREATE_MS);
      }
      return;
    default:
      return;
  }
}

function runProgram(cluster: Cluster, pod: Pod, c: Container, crt: ContainerRuntime): void {
  const now = cluster.now;
  const prog = crt.program ?? [];
  if (crt.wakeAt > now) return;
  const log = (text: string) => {
    for (const line of text.split("\n")) cluster.log(pod.metadata.uid, c.name, crt.restarts, now, line);
    cluster.markChanged();
  };
  // `for` variables are placeholders in the compiled program; fill in the current items.
  const vars = (w: string) => (w.includes("\u0001") ? w.replace(/\u0001(\w+)\u0001/g, (_, n) => crt.loopVars?.[n] ?? "") : w);
  for (let guard = 0; guard < 200; guard++) {
    const op = prog[crt.pc];
    if (!op) {
      exit(cluster, crt, crt.lastCode ?? 0);
      return;
    }
    switch (op.op) {
      case "log":
        log(op.text.replace(/\u0000DATE\u0000/g, unixDate(now)));
        crt.pc++;
        break;
      case "run": {
        crt.pc++;
        if (op.when === "ok" && (crt.lastCode ?? 0) !== 0) break;
        if (op.when === "fail" && (crt.lastCode ?? 0) === 0) break;
        const ee = execEnv(cluster, pod, c, crt.env ?? {});
        const argv = op.argv.map((a) => vars(a).replace(/\u0000DATE\u0000/g, unixDate(now)));
        const r = op.redirect ? runRedirected(ee, argv, { ...op.redirect, path: vars(op.redirect.path) }) : runArgv(ee, argv);
        if (r.out) log(r.out);
        crt.lastCode = r.code;
        if (crt.phase !== "running") return;
        break;
      }
      case "sleep":
        crt.wakeAt = now + op.ms;
        crt.lastCode = 0;
        crt.pc++;
        return;
      case "forinit": {
        const n = op.items ? op.items.length : Math.max(0, (op.to ?? 0) - (op.from ?? 1) + 1);
        if (n === 0) {
          crt.pc = op.end;
          break;
        }
        (crt.loopIdx ??= {})[crt.pc] = 0;
        (crt.loopVars ??= {})[op.var] = op.items ? op.items[0] : String(op.from ?? 1);
        crt.pc++;
        break;
      }
      case "fornext": {
        const init = prog[op.init] as Extract<Program[number], { op: "forinit" }>;
        const n = init.items ? init.items.length : Math.max(0, (init.to ?? 0) - (init.from ?? 1) + 1);
        const i = ((crt.loopIdx ??= {})[op.init] ?? 0) + 1;
        if (i < n) {
          crt.loopIdx[op.init] = i;
          (crt.loopVars ??= {})[op.var] = init.items ? init.items[i] : String((init.from ?? 1) + i);
          crt.pc = op.to;
        } else crt.pc++;
        break;
      }
      case "jumpif":
        crt.pc = (op.when === "ok") === ((crt.lastCode ?? 0) === 0) ? op.to : crt.pc + 1;
        break;
      case "exit":
        exit(cluster, crt, op.code < 0 ? (crt.lastCode ?? 0) : op.code);
        return;
      case "alloc": {
        crt.alloc = (crt.alloc ?? 0) + op.bytes;
        crt.pc++;
        const limit = containerLimits(c).memory;
        if (limit && containerMemory(c, crt) > limit) {
          crt.exitCode = 137;
          crt.exitReason = "OOMKilled";
          crt.phase = "exited";
          crt.until = now + EXITED_VISIBLE_MS;
          cluster.markChanged();
          return;
        }
        break;
      }
      case "burn":
        crt.burn = op.millicores;
        crt.pc++;
        break;
      case "serve":
        return;
      case "jump":
        crt.pc = op.to;
        break;
    }
  }
}

function exit(cluster: Cluster, crt: ContainerRuntime, code: number): void {
  crt.exitCode = code;
  crt.exitReason = code === 0 ? "Completed" : "Error";
  crt.phase = "exited";
  crt.until = cluster.now + EXITED_VISIBLE_MS;
  cluster.markChanged();
}

// ---------- probes ----------

const probeDefaults = (p: Probe) => ({
  delay: (p.initialDelaySeconds ?? 0) * 1000,
  period: (p.periodSeconds ?? 10) * 1000,
  success: p.successThreshold ?? 1,
  failure: p.failureThreshold ?? 3,
});

/** Runs one probe against a container, as the kubelet's prober does. */
export function runProbe(cluster: Cluster, pod: Pod, c: Container, p: Probe): { ok: boolean; message: string } {
  const ip = pod.status?.podIP ?? "";
  const resolvePort = (port: number | string) =>
    typeof port === "number" ? port : /^\d+$/.test(port) ? parseInt(port, 10) : ((c.ports ?? []).find((x) => x.name === port)?.containerPort ?? NaN);
  if (p.exec) {
    const crt = cluster.state.pods[pod.metadata.uid]?.containers[c.name];
    const r = runArgv(execEnv(cluster, pod, c, crt?.env ?? {}, { quiet: true }), p.exec.command ?? []);
    return { ok: r.code === 0, message: r.out };
  }
  const port = resolvePort((p.httpGet ?? p.tcpSocket ?? p.grpc)?.port ?? NaN);
  const prt = cluster.state.pods[pod.metadata.uid];
  // Any container in the Pod listening on the port answers (they share the network namespace).
  const listener = [...(pod.spec?.initContainers ?? []).filter(isSidecar), ...(pod.spec?.containers ?? [])].find((x) => {
    const r = prt?.containers[x.name];
    if (!r || (r.phase !== "running" && r.phase !== "stopping") || r.program?.[r.pc]?.op !== "serve" || r.wakeAt > cluster.now) return false;
    return listenPorts(lookupImage(r.image).info, x).includes(port);
  });
  if (p.httpGet) {
    const path = p.httpGet.path ?? "/";
    const scheme = (p.httpGet.scheme ?? "HTTP").toLowerCase();
    const url = `${scheme}://${ip}:${port}${path}`;
    if (!listener) return { ok: false, message: `Get "${url}": dial tcp ${ip}:${port}: connect: connection refused` };
    const lr = prt!.containers[listener.name];
    const { info } = lookupImage(lr.image);
    if (!info?.http) return { ok: false, message: `Get "${url}": EOF` };
    const fs = execEnv(cluster, pod, listener, lr.env ?? {}).fs;
    const ctx = {
      podName: pod.spec?.hostname ?? pod.metadata.name,
      podIP: ip,
      port,
      path,
      query: {},
      clientIP: `10.244.${cluster.state.nodes[pod.spec?.nodeName ?? ""]?.index ?? 0}.1`,
      now: unixDate(cluster.now),
      args: [...(listener.command ?? []), ...(listener.args ?? [])],
      uptimeMs: cluster.now - (lr.startedAt ?? cluster.now),
      read: (f: string) => fs.read(f),
      isDir: (f: string) => fs.isDir(f),
    };
    const res = info.http(ctx);
    if (info.accessLog) cluster.log(pod.metadata.uid, listener.name, lr.restarts, cluster.now, info.accessLog(ctx, res).replace("curl/8.5.0", "kube-probe/1.37"));
    if (res.status >= 200 && res.status < 400) return { ok: true, message: "" };
    return { ok: false, message: `HTTP probe failed with statuscode: ${res.status}` };
  }
  if (!listener) return { ok: false, message: `dial tcp ${ip}:${port}: connect: connection refused` };
  return { ok: true, message: "" };
}

function probe(cluster: Cluster, pod: Pod, c: Container, crt: ContainerRuntime, nodeName: string): void {
  const now = cluster.now;
  const started = crt.startedAt ?? now;
  crt.probes ??= {};
  const due = (kind: "startup" | "liveness" | "readiness", p: Probe): ProbeState | undefined => {
    const d = probeDefaults(p);
    const st = (crt.probes![kind] ??= { next: Math.max(now, started + d.delay), ok: 0, fail: 0 });
    if (now < st.next) return undefined;
    st.next = now + d.period;
    return st;
  };
  const kill = (why: "liveness" | "startup", p: Probe) => {
    cluster.record(pod, "Normal", "Killing", `Container ${c.name} failed ${why} probe, will be restarted`, "kubelet", nodeName, `spec.containers{${c.name}}`);
    const { info } = lookupImage(c.image);
    const grace = (p.terminationGracePeriodSeconds ?? pod.spec?.terminationGracePeriodSeconds ?? 30) * 1000;
    crt.phase = "stopping";
    crt.killAt = now + (handlesSigterm(c, info, crt) ? 300 : grace);
    crt.ready = false;
    cluster.markChanged();
  };
  const warn = (kind: string, msg: string) => cluster.record(pod, "Warning", "Unhealthy", `${kind} probe failed: ${msg}`, "kubelet", nodeName, `spec.containers{${c.name}}`);

  if (!crt.started) {
    const p = c.startupProbe;
    if (!p) {
      crt.started = true;
    } else {
      const st = due("startup", p);
      if (!st) return;
      const r = runProbe(cluster, pod, c, p);
      if (r.ok) {
        crt.started = true;
        cluster.markChanged();
      } else {
        st.fail++;
        warn("Startup", r.message);
        if (st.fail >= probeDefaults(p).failure) kill("startup", p);
        return;
      }
    }
  }

  if (c.livenessProbe) {
    const p = c.livenessProbe;
    const st = due("liveness", p);
    if (st) {
      const r = runProbe(cluster, pod, c, p);
      if (r.ok) st.fail = 0;
      else {
        st.fail++;
        warn("Liveness", r.message);
        if (st.fail >= probeDefaults(p).failure) {
          kill("liveness", p);
          return;
        }
      }
    }
  }

  if (!c.readinessProbe) {
    if (!crt.ready) {
      crt.ready = true;
      cluster.markChanged();
    }
    return;
  }
  const p = c.readinessProbe;
  const st = due("readiness", p);
  if (!st) return;
  const r = runProbe(cluster, pod, c, p);
  const d = probeDefaults(p);
  if (r.ok) {
    st.fail = 0;
    st.ok++;
    if (!crt.ready && st.ok >= d.success) {
      crt.ready = true;
      cluster.markChanged();
    }
  } else {
    st.ok = 0;
    st.fail++;
    warn("Readiness", r.message);
    if (crt.ready && st.fail >= d.failure) {
      crt.ready = false;
      cluster.markChanged();
    }
  }
}

// ---------- status ----------

function containerState(pod: Pod, c: Container, crt: ContainerRuntime): { state: ContainerState; ready: boolean; started: boolean } {
  const waiting = (reason: string, message?: string) => ({ state: { waiting: { reason, ...(message ? { message } : {}) } }, ready: false, started: false });
  switch (crt.phase) {
    case "pulling":
      if (crt.exitReason === "ErrImageNeverPull") return waiting("ErrImageNeverPull", `Container image "${c.image}" is not present with pull policy of Never`);
      return crt.backoffMs ? waiting("ErrImagePull", crt.exitMessage) : waiting("ContainerCreating");
    case "creating":
      return crt.lastTerm ? { state: { terminated: termOf(crt.lastTerm) }, ready: false, started: false } : waiting("ContainerCreating");
    case "configError":
      return waiting("CreateContainerConfigError", crt.exitMessage);
    case "pullError":
      return waiting("ErrImagePull", crt.exitMessage);
    case "pullBackoff":
      return waiting("ImagePullBackOff", `Back-off pulling image "${c.image}": ErrImagePull: ${crt.exitMessage ?? ""}`);
    case "running":
    case "stopping":
    case "dead":
      return { state: { running: { startedAt: crt.startedAt ?? 0 } }, ready: crt.phase !== "stopping" && (crt.ready ?? true), started: crt.started ?? true };
    case "exited":
    case "done":
      return {
        state: { terminated: { exitCode: crt.exitCode ?? 0, reason: crt.exitReason ?? "Completed", startedAt: crt.startedAt, finishedAt: crt.phase === "exited" ? crt.until - EXITED_VISIBLE_MS : (crt.until || crt.startedAt || 0), ...(crt.exitMessage ? { message: crt.exitMessage } : {}) } },
        ready: false,
        started: false,
      };
    case "crashBackoff":
      return waiting(
        "CrashLoopBackOff",
        `back-off ${goDuration(crt.backoffMs)} restarting failed container=${c.name} pod=${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`,
      );
  }
}

function termOf(t: NonNullable<ContainerRuntime["lastTerm"]>) {
  return { exitCode: t.exitCode, reason: t.reason, ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}), finishedAt: t.finishedAt, ...(t.message ? { message: t.message } : {}) };
}

function writeStatus(cluster: Cluster, pod: Pod, prt: PodRuntime, nodeName: string): void {
  const now = cluster.now;
  void nodeName;
  const inits = pod.spec?.initContainers ?? [];
  const hasInit = inits.length > 0;
  const initDone = (c: Container) => {
    const crt = prt.containers[c.name];
    if (!crt) return false;
    return isSidecar(c) ? crt.started === true && crt.phase !== "pulling" && crt.startedAt !== undefined : crt.phase === "done" && (crt.exitCode ?? 0) === 0;
  };
  const initialized = !hasInit || prt.initialized === true || inits.every(initDone);
  const statusOf = (c: Container): ContainerStatus | undefined => {
    const crt = prt.containers[c.name];
    if (!crt) return undefined;
    const st = containerState(pod, c, crt);
    let state = st.state;
    // With init containers, a container the runtime hasn't created yet waits as PodInitializing.
    if (hasInit && state.waiting?.reason === "ContainerCreating") state = { waiting: { reason: "PodInitializing" } };
    const { ref } = lookupImage(crt.image);
    const hasRun = crt.startedAt !== undefined || crt.restarts > 0;
    return {
      name: c.name,
      image: ref.full,
      imageID: hasRun ? imageDigest(ref) : "",
      ...(hasRun ? { containerID: `containerd://${cluster_hash(pod.metadata.uid + c.name + crt.restarts)}` } : {}),
      ready: st.ready,
      started: st.started,
      restartCount: crt.restarts,
      state,
      lastState: crt.lastTerm ? { terminated: termOf(crt.lastTerm) } : {},
    };
  };
  const statuses: ContainerStatus[] = [];
  let anyNeverStarted = false;
  let allDone = true;
  let anyFailed = false;
  for (const c of pod.spec!.containers) {
    const s = statusOf(c);
    if (!s) continue;
    const crt = prt.containers[c.name];
    const hasRun = crt.startedAt !== undefined || crt.restarts > 0;
    if (s.state.waiting && !hasRun) anyNeverStarted = true;
    if (crt.phase !== "done") allDone = false;
    if (crt.phase === "done" && (crt.exitCode ?? 0) !== 0) anyFailed = true;
    statuses.push(s);
  }
  const initStatuses = inits.map(statusOf).filter((s): s is ContainerStatus => !!s);
  // A regular init container that failed for good (restartPolicy Never) fails the Pod.
  const initFailed = inits.some((c) => !isSidecar(c) && prt.containers[c.name]?.phase === "done" && (prt.containers[c.name]?.exitCode ?? 0) !== 0);
  let phase: PodPhase;
  if (prt.failedReason || initFailed) phase = "Failed";
  else if (allDone && statuses.length) phase = anyFailed ? "Failed" : "Succeeded";
  else if (!initialized || anyNeverStarted || now < prt.sandboxAt) phase = "Pending";
  else phase = "Running";

  // Started sidecars count toward readiness like app containers.
  const sidecarStatuses = initStatuses.filter((s) => isSidecar(inits.find((c) => c.name === s.name)!) && s.started);
  const readyPool = [...statuses, ...sidecarStatuses];
  const allReady = statuses.length > 0 && readyPool.every((s) => s.ready) && pod.metadata.deletionTimestamp === undefined;
  const unready = readyPool.filter((s) => !s.ready).map((s) => s.name);
  const prev = pod.status?.conditions ?? [];
  const cond = (type: string, ok: boolean, reason?: string, message?: string): Condition => {
    const old = prev.find((c) => c.type === type);
    const status = ok ? "True" : "False";
    return {
      type,
      status,
      lastProbeTime: null,
      lastTransitionTime: old && old.status === status ? old.lastTransitionTime : now,
      ...(ok ? {} : reason ? { reason, message } : {}),
    };
  };
  // readinessGates: the Pod is Ready only when each gate's condition (set by some other controller) is True.
  const gates = ((pod.spec as { readinessGates?: { conditionType: string }[] } | undefined)?.readinessGates ?? []).map((g) => g.conditionType);
  const gateProblem = gates
    .map((g) => {
      const c = prev.find((x) => x.type === g);
      if (!c) return `corresponding condition of pod readiness gate "${g}" does not exist.`;
      return c.status === "True" ? "" : `the status of pod readiness gate "${g}" is not "True", but ${c.status}`;
    })
    .filter(Boolean);
  const completed = phase === "Succeeded" || phase === "Failed";
  const notInit = inits.filter((c) => !initDone(c)).map((c) => c.name);
  const readyCond = completed
    ? { ...cond("Ready", false), reason: "PodCompleted" }
    : !allReady
      ? cond("Ready", false, "ContainersNotReady", `containers with unready status: [${unready.join(" ")}]`)
      : gateProblem.length
        ? cond("Ready", false, "ReadinessGatesNotReady", gateProblem.join(", "))
        : cond("Ready", true);
  const conditions: Condition[] = [
    cond("PodReadyToStartContainers", now >= prt.sandboxAt && !completed),
    initialized ? cond("Initialized", true) : cond("Initialized", false, "ContainersNotInitialized", `containers with incomplete status: [${notInit.join(" ")}]`),
    readyCond,
    completed ? { ...cond("ContainersReady", false), reason: "PodCompleted" } : cond("ContainersReady", allReady, "ContainersNotReady", `containers with unready status: [${unready.join(" ")}]`),
    ...prev.filter((c) => c.type === "PodScheduled" || c.type === "DisruptionTarget" || gates.includes(c.type)),
  ];
  const next: PodStatus = {
    ...(pod.status as PodStatus),
    phase,
    conditions,
    ...(hasInit ? { initContainerStatuses: initStatuses } : {}),
    containerStatuses: statuses,
    qosClass: qosClass(pod.spec),
    ...(prt.failedReason ? prt.failedReason : {}),
  };
  if (deepEqual(next, pod.status)) return; // most steps change nothing: skip the clone + store write
  cluster.put({ ...pod, status: next });
}

const idCache = new Map<string, string>();

export function cluster_hash(s: string): string {
  const hit = idCache.get(s);
  if (hit) return hit;
  const h = computeId(s);
  if (idCache.size > 2000) idCache.clear();
  idCache.set(s, h);
  return h;
}

function computeId(s: string): string {
  let h = "";
  let x = 0x811c9dc5;
  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0;
    x = Math.imul(x ^ r, 0x01000193) >>> 0;
    h += x.toString(16).padStart(8, "0");
  }
  return h;
}

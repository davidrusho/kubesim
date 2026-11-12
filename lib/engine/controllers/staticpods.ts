// Static Pods: the kubelet reads the manifests in its staticPodPath and keeps one mirror Pod
// per file (ADR 0003, decision 3). Behaviour from the capture's Scenarios 3 to 5: a file that
// does not parse leaves no Pod, a bad image tag gives ErrImagePull, a flag naming a missing
// file or an unknown flag makes the container exit (CrashLoopBackOff), and a manifest moved
// out of the directory removes the Pod within one scan.

import YAML from "yaml";
import { clone } from "../util";
import type { Cluster } from "../cluster";
import type { Container, Pod, Probe } from "../types";
import type { Program } from "../images";
import {
  COMPONENTS,
  MANIFEST_DIR,
  containerKlog,
  goYamlError,
  hexId,
  kubeletLog,
  nodeIp,
  manifestFor,
  normPath,
  listHostDir,
  type Component,
  type HostState,
  type StaticEntry,
} from "../host";
import { kubeletPosting } from "../hostservices";

/** How often the kubelet re-reads staticPodPath (the capture shows a change taking effect within 10 s). */
export const STATIC_SCAN_MS = 5000;
/** A changed manifest's old mirror Pod is deleted at the scan; the new one appears about this long after (capture 3b: ~t+15 s). */
export const MIRROR_RECREATE_MS = 10_000;
/** The kubelet repeats its complaint about an unparsable manifest this often. */
const BAD_LOG_MS = 20_000;

const SOURCE = "kubernetes.io/config.source";
const HASH = "kubernetes.io/config.hash";

export const isStaticPod = (p: Pod): boolean => p.metadata.annotations?.[SOURCE] === "file";

// ---------------------------------------------------------------- reading a manifest

interface Manifest {
  doc?: { metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; spec: Pod["spec"] & object };
  err?: string;
}

export function readManifest(text: string): Manifest {
  let v: Record<string, unknown> | null;
  try {
    const parsed = YAML.parseDocument(text);
    if (parsed.errors.length) return { err: goYamlError(parsed.errors[0]) };
    v = parsed.toJS() as Record<string, unknown> | null;
  } catch (e) {
    // Too many aliases (a "billion laughs" manifest) and the like: the kubelet cannot read the file, which is all the Learner sees.
    return { err: `yaml: ${(e as Error).message.split("\n")[0].slice(0, 120)}` };
  }
  if (!v || typeof v !== "object" || Array.isArray(v) || v.kind !== "Pod") return { err: `Object 'Kind' is missing in '${text.trim().slice(0, 30)}'` };
  const md = (v.metadata ?? {}) as { name?: string };
  const spec = v.spec as { containers?: unknown[] } | undefined;
  if (!md.name) return { err: "invalid pod: metadata.name: Required value: name is required" };
  if (!spec || !Array.isArray(spec.containers) || !spec.containers.length) return { err: "invalid pod: spec.containers: Required value" };
  return { doc: v as unknown as Manifest["doc"] };
}

// ---------------------------------------------------------------- the mirror Pod

/** A control-plane probe checked an HTTPS endpoint; here it checks that something listens on the port (the simulated container has no HTTP server). */
function asTcpProbe(p: Probe | undefined): Probe | undefined {
  if (!p?.httpGet) return p;
  const { httpGet, ...rest } = p;
  return { ...rest, tcpSocket: { port: httpGet.port } };
}

function containerFrom(c: Container, kubeadm: boolean): Container {
  const out: Container = { name: c.name, image: c.image };
  for (const k of ["imagePullPolicy", "command", "args", "ports", "env", "resources", "volumeMounts"] as const) if (c[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = c[k];
  for (const k of ["livenessProbe", "readinessProbe", "startupProbe"] as const) {
    const p = kubeadm ? asTcpProbe(c[k]) : c[k];
    if (p) out[k] = p;
  }
  return out;
}

function createMirror(cluster: Cluster, node: string, doc: NonNullable<Manifest["doc"]>, hash: string): Pod {
  const kubeadm = (doc.metadata.namespace ?? "default") === "kube-system" && COMPONENTS.some((c) => c === doc.metadata.name);
  const nodeObj = cluster.raw("Node", undefined, node)!;
  const spec = doc.spec;
  return cluster.create<Pod>({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `${doc.metadata.name}-${node}`,
      namespace: doc.metadata.namespace ?? "default",
      ...(doc.metadata.labels ? { labels: doc.metadata.labels } : {}),
      annotations: { ...(doc.metadata.annotations ?? {}), [SOURCE]: "file", [HASH]: hash, "kubernetes.io/config.mirror": hash },
      ownerReferences: [{ apiVersion: "v1", kind: "Node", name: node, uid: nodeObj.metadata.uid, controller: true }],
    },
    spec: {
      nodeName: node,
      ...(spec.hostNetwork ? { hostNetwork: true } : {}),
      ...(spec.priorityClassName ? { priorityClassName: spec.priorityClassName } : {}),
      automountServiceAccountToken: false,
      tolerations: [{ operator: "Exists", effect: "NoExecute" }],
      containers: spec.containers.map((c) => containerFrom(c, kubeadm)),
      ...(spec.volumes ? { volumes: spec.volumes } : {}),
      ...(spec.securityContext ? { securityContext: spec.securityContext } : {}),
    },
  });
}

/** The mirror Pod of a control-plane component on a Node, if there is one. */
export function mirrorPod(cluster: Cluster, node: string, comp: Component): Pod | undefined {
  const p = cluster.raw("Pod", "kube-system", `${comp}-${node}`) as unknown as Pod | undefined;
  return p && isStaticPod(p) ? p : undefined;
}

/**
 * `kubectl delete pod` on a mirror Pod removes only the API object: the kubelet still runs the static
 * container and puts a new mirror Pod (new UID, new AGE) in front of it. The container is not restarted.
 */
export function recreateMirror(cluster: Cluster, old: Pod): void {
  const uid = old.metadata.uid;
  const prt = cluster.state.pods[uid];
  const logs = Object.entries(cluster.state.logs).filter(([k]) => k.startsWith(`${uid}/`));
  const next = clone(old) as Pod;
  next.metadata.uid = cluster.uid();
  next.metadata.creationTimestamp = cluster.now;
  delete next.metadata.deletionTimestamp;
  delete next.metadata.deletionGracePeriodSeconds;
  cluster.remove(old);
  cluster.put(next);
  if (prt) cluster.state.pods[next.metadata.uid] = prt;
  for (const [k, v] of logs) cluster.state.logs[`${next.metadata.uid}${k.slice(uid.length)}`] = v;
  cluster.markChanged();
}

// ---------------------------------------------------------------- the scan

const staticFiles = (host: HostState, dir: string) => listHostDir(host, dir).filter((e) => !e.dir && !e.name.startsWith("."));

function podRef(doc: NonNullable<Manifest["doc"]>, node: string) {
  return `${doc.metadata.namespace ?? "default"}/${doc.metadata.name}-${node}`;
}

function removeMirror(cluster: Cluster, ref: string): Pod | undefined {
  const [ns, name] = ref.split("/");
  const p = cluster.raw("Pod", ns, name) as unknown as Pod | undefined;
  if (p && isStaticPod(p)) {
    cluster.remove(p);
    return p;
  }
  return undefined;
}

/** One pass of the kubelet's static-Pod source over a Node's manifest directory. */
export function syncStaticPods(cluster: Cluster, node: string): void {
  const host = cluster.state.hosts[node];
  const dir = host.services.kubelet.staticPodPath;
  const now = cluster.now;
  const files = dir ? staticFiles(host, dir) : [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = normPath(`${dir}/${f.name}`);
    seen.add(path);
    const text = f.file!.content;
    const hash = hexId(`${node}:${text}`, 32);
    const entry = host.static[path];
    // Unchanged and its mirror Pod is there: nothing to do. (A mirror Pod someone deleted is created again.)
    if (entry && entry.hash === hash && !entry.bad && !entry.createAt && entry.pod && cluster.raw("Pod", entry.pod.split("/")[0], entry.pod.split("/")[1])) continue;
    const m = readManifest(text);
    if (!m.doc) {
      // The file is not a Pod (any more): the mirror Pod goes with it, and the kubelet says why, now and every 20 s.
      if (entry?.pod) removeMirror(cluster, entry.pod);
      const e: StaticEntry = { hash, ...(entry && entry.hash === hash && entry.bad ? { bad: entry.bad } : {}) };
      host.static[path] = e;
      if (!e.bad || now - e.bad.loggedAt >= BAD_LOG_MS) {
        const err = `${path}: couldn't parse as pod(${m.err}), please check config file`;
        if (!e.bad) kubeletLog(cluster, node, "E", "file.go:107", `"Unable to process watch event" err="can't process config file \\"${path}\\": ${err}"`);
        kubeletLog(cluster, node, "E", "file.go:186", `"Could not process manifest file" err="${err}" path="${path}"`);
        e.bad = { err: m.err!, loggedAt: now };
      }
      continue;
    }
    const ref = podRef(m.doc, node);
    if (entry?.pod && entry.hash !== hash) {
      // The manifest changed: the kubelet deletes the mirror Pod that no longer matches and creates the new one a little later.
      const old = removeMirror(cluster, entry.pod);
      if (old) {
        kubeletLog(cluster, node, "I", "kubelet.go:3562", `"Trying to delete pod" pod="${entry.pod}" podUID="${old.metadata.uid}"`);
        kubeletLog(cluster, node, "I", "kubelet.go:3568", `"Deleted mirror pod as it didn't match the static Pod" pod="${entry.pod}"`);
      }
      host.static[path] = { hash, createAt: now + MIRROR_RECREATE_MS };
      continue;
    }
    if (entry?.createAt !== undefined && entry.hash === hash && now < entry.createAt) continue;
    try {
      kubeletLog(cluster, node, "I", "kubelet.go:3579", `"Creating a mirror pod for static pod" pod="${ref}"`);
      createMirror(cluster, node, m.doc, hash);
      host.static[path] = { hash, pod: ref };
    } catch (e) {
      kubeletLog(cluster, node, "E", "kubelet.go:3581", `"Failed creating a mirror pod" err="${(e as Error).message.replace(/"/g, '\\"')}" pod="${ref}"`);
      host.static[path] = { hash, createAt: now + STATIC_SCAN_MS };
    }
  }
  // A manifest that is gone (moved out, deleted, or the directory changed) takes its Pod with it.
  for (const [path, entry] of Object.entries(host.static)) {
    if (seen.has(path)) continue;
    if (entry.pod) removeMirror(cluster, entry.pod);
    delete host.static[path];
  }
  cluster.markChanged();
}

/** Writes a container's trouble to the kubelet's journal, once per state (capture: Scenario 3b, 3c, 4a, 4c). */
function logContainerTrouble(cluster: Cluster, node: string, host: HostState): void {
  for (const entry of Object.values(host.static)) {
    if (!entry.pod) continue;
    const [ns, name] = entry.pod.split("/");
    const pod = cluster.raw("Pod", ns, name) as unknown as Pod | undefined;
    const prt = pod && cluster.state.pods[pod.metadata.uid];
    if (!pod || !prt) continue;
    for (const c of pod.spec?.containers ?? []) {
      const crt = prt.containers[c.name];
      if (!crt) continue;
      const key = `${crt.phase}:${crt.restarts}:${crt.backoffMs}`;
      if (entry.logged === key) continue;
      const id = `${pod.metadata.name}_${ns}(${entry.hash})`;
      const sync = (reason: string, detail: string) =>
        kubeletLog(cluster, node, "E", "pod_workers.go:1338", `"Error syncing pod, skipping" err="failed to \\"StartContainer\\" for \\"${c.name}\\" with ${reason}: \\"${detail}\\"" pod="${entry.pod}" podUID="${entry.hash}"`);
      if (crt.phase === "pullError") {
        const msg = (crt.exitMessage ?? "").replace(/"/g, '\\"');
        kubeletLog(cluster, node, "E", "remote_image.go:334", `"PullImage from image service failed" err="${msg}" image="${c.image}"`);
        kubeletLog(cluster, node, "E", "kuberuntime_image.go:43", `"Failed to pull image" err="${msg}" image="${c.image}"`);
        kubeletLog(cluster, node, "E", "kuberuntime_manager.go:1854", `"Unhandled Error" err="container ${c.name} start failed in pod ${id}: ErrImagePull: ${msg}"`);
        sync("ErrImagePull", msg.replace(/"/g, '\\"'));
        entry.logged = key;
      } else if (crt.phase === "pullBackoff") {
        sync("ImagePullBackOff", `Back-off pulling image \\\\\\"${c.image}\\\\\\": ErrImagePull: ${(crt.exitMessage ?? "").replace(/"/g, '\\\\\\"')}`);
        entry.logged = key;
      } else if (crt.phase === "crashBackoff") {
        sync("CrashLoopBackOff", `back-off ${crt.backoffMs / 1000}s restarting failed container=${c.name} pod=${id}`);
        entry.logged = key;
      }
    }
  }
}

/** Runs every step: the scan of each kubelet that is posting, and the journal notes about its static Pods. */
export function runStaticPods(cluster: Cluster): void {
  const now = cluster.now;
  for (const [node, host] of Object.entries(cluster.state.hosts)) {
    if (!kubeletPosting(cluster, node)) continue;
    // A manifest the engine cannot make sense of is a fault on that node (the kubelet logs it and carries on), never an exception.
    try {
      if (now % STATIC_SCAN_MS === 0) syncStaticPods(cluster, node);
      if (now % 1000 === 0) logContainerTrouble(cluster, node, host);
    } catch (e) {
      if (now % STATIC_SCAN_MS === 0) kubeletLog(cluster, node, "E", "file.go:186", `"Could not process manifest file" err="${(e as Error).message.replace(/"/g, "'").slice(0, 160)}"`);
    }
  }
}

// ---------------------------------------------------------------- what each component does with its flags

interface ComponentFlags {
  /** Flags whose value names a file that must exist, with the error the process prints when it does not. */
  files: Record<string, "stat" | "open">;
  /** Real flags that are not in kubeadm's manifest, so a typo of one is still recognised. */
  extra: string[];
  /** Lines the process logs before it reads its flags' files. */
  preamble: (now: number, seq: number) => string[];
}

const serving = (now: number, seq: number) => [containerKlog(now, seq, "I", "serving.go:411", "Generated self-signed cert in-memory")];

/**
 * The flags checked, kept small and explicit. The wording of the error is verified only for
 * kube-scheduler --kubeconfig (`stat`) and kube-apiserver --tls-cert-file (`open`), from the capture;
 * the others reuse those two shapes.
 */
const FLAGS: Record<Component, ComponentFlags> = {
  "kube-scheduler": {
    files: { kubeconfig: "stat", "authentication-kubeconfig": "stat", "authorization-kubeconfig": "stat" },
    extra: ["config", "v", "feature-gates", "secure-port", "tls-cert-file", "tls-private-key-file", "profiling", "leader-elect-lease-duration"],
    preamble: serving,
  },
  "kube-controller-manager": {
    files: {
      kubeconfig: "stat",
      "authentication-kubeconfig": "stat",
      "authorization-kubeconfig": "stat",
      "client-ca-file": "open",
      "cluster-signing-cert-file": "open",
      "cluster-signing-key-file": "open",
      "requestheader-client-ca-file": "open",
      "root-ca-file": "open",
      "service-account-private-key-file": "open",
    },
    extra: ["v", "feature-gates", "secure-port", "node-monitor-grace-period", "terminated-pod-gc-threshold", "profiling"],
    preamble: serving,
  },
  "kube-apiserver": {
    files: {
      "tls-cert-file": "open",
      "tls-private-key-file": "open",
      "client-ca-file": "open",
      "etcd-cafile": "open",
      "etcd-certfile": "open",
      "etcd-keyfile": "open",
      "kubelet-client-certificate": "open",
      "kubelet-client-key": "open",
      "proxy-client-cert-file": "open",
      "proxy-client-key-file": "open",
      "requestheader-client-ca-file": "open",
      "service-account-key-file": "open",
      "service-account-signing-key-file": "open",
    },
    extra: ["v", "feature-gates", "audit-log-path", "audit-policy-file", "audit-log-maxage", "audit-log-maxbackup", "audit-log-maxsize", "encryption-provider-config", "runtime-config", "oidc-issuer-url", "oidc-client-id", "anonymous-auth", "profiling", "token-auth-file", "service-node-port-range", "bind-address", "advertise-address"],
    preamble: (now, seq) => [
      containerKlog(now, seq, "I", "options.go:261", "external host was not specified, using 172.18.0.2"),
      containerKlog(now, seq + 1, "I", "server.go:151", "Version: v1.37.0"),
      containerKlog(now, seq + 2, "I", "server.go:153", `"Golang settings" GOGC="" GOMAXPROCS="" GOTRACEBACK=""`),
    ],
  },
  etcd: {
    files: { "cert-file": "open", "key-file": "open", "trusted-ca-file": "open", "peer-cert-file": "open", "peer-key-file": "open", "peer-trusted-ca-file": "open" },
    extra: ["log-level", "logger", "quota-backend-bytes", "auto-compaction-retention", "heartbeat-interval", "election-timeout", "max-request-bytes"],
    preamble: () => [],
  },
};

const defaultFlagNames = new Map<Component, Set<string>>();
function knownFlags(comp: Component): Set<string> {
  let s = defaultFlagNames.get(comp);
  if (!s) {
    const m = readManifest(manifestFor(comp, "x", nodeIp(0)));
    const cmd = (m.doc?.spec.containers[0].command ?? []) as string[];
    s = new Set([...cmd.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")[0]), ...FLAGS[comp].extra, ...Object.keys(FLAGS[comp].files)]);
    defaultFlagNames.set(comp, s);
  }
  return s;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** An unknown flag is a typo of a known one (the simulator cannot list every flag the real binary accepts, so an unrelated new flag is let through). */
export function unknownFlag(comp: Component, name: string): boolean {
  const known = knownFlags(comp);
  if (known.has(name)) return false;
  return [...known].some((k) => editDistance(name, k) <= 2);
}

export function flagsOf(command: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const argv = (command ?? []).slice(1);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const eq = argv[i].indexOf("=");
    if (eq > 0) out.set(argv[i].slice(2, eq), argv[i].slice(eq + 1));
    else out.set(argv[i].slice(2), "");
  }
  return out;
}

const portsOf = (urls: string) => urls.split(",").map((u) => parseInt(/:(\d+)(?:\/|$)/.exec(u)?.[1] ?? "", 10)).filter((n) => !isNaN(n));

/** Listen-client ports by manifest text: the health check runs every step and must not parse YAML each time. */
const clientPortCache = new Map<string, number[]>();

/** The ports etcd listens on for clients, from its manifest on the same host. */
function etcdClientPorts(host: HostState): number[] {
  const dir = host.services.kubelet.staticPodPath ?? MANIFEST_DIR;
  for (const f of staticFiles(host, dir)) {
    const text = f.file!.content;
    let ports = clientPortCache.get(text);
    if (!ports) {
      const doc = readManifest(text).doc;
      ports = doc?.metadata.name === "etcd" ? portsOf(flagsOf(doc.spec.containers[0].command).get("listen-client-urls") ?? "") : [];
      if (clientPortCache.size > 64) clientPortCache.clear();
      clientPortCache.set(text, ports);
    }
    // A file that is etcd's has its ports; keep looking past the others (an empty result is also what a non-etcd file caches).
    if (ports.length) return ports;
  }
  return [];
}

/** The first port in the apiserver's --etcd-servers that etcd's manifest on the same host does not listen on (capture 4a), if any. */
function unreachableEtcdPort(host: HostState, flags: Map<string, string>): number | undefined {
  const have = etcdClientPorts(host);
  return portsOf(flags.get("etcd-servers") ?? "").find((p) => !have.includes(p));
}

const componentOf = (pod: Pod): Component | undefined => {
  if (pod.metadata.namespace !== "kube-system" || !isStaticPod(pod)) return undefined;
  return COMPONENTS.find((c) => pod.metadata.labels?.component === c && pod.spec?.containers[0]?.name === c);
};

/**
 * What a control-plane container does when it starts, when its manifest is wrong: log what the
 * real process logs and exit, or retry for a while and then exit. Undefined means it starts.
 */
export function staticPodFault(cluster: Cluster, pod: Pod, c: Container, node: string): Program | undefined {
  const comp = componentOf(pod);
  const host = cluster.state.hosts[node];
  if (!comp || !host) return undefined;
  const now = cluster.now;
  let seq = 100;
  const flags = flagsOf(c.command);
  const fail = (pre: string[], err: string): Program => [
    ...pre.map((text) => ({ op: "log" as const, text })),
    { op: "log", text: err },
    { op: "exit", code: 1 },
  ];
  const errLine = (msg: string) =>
    comp === "etcd"
      ? `{"level":"fatal","ts":"${new Date(Date.UTC(2026, 0, 1, 9) + now).toISOString().replace("Z", "+0000")}","caller":"etcdmain/etcd.go:204","msg":"discovery failed","error":"${msg}"}`
      : containerKlog(now, seq++, "E", "run.go:72", `"command failed" err="${msg}"`);

  for (const name of flags.keys()) {
    if (unknownFlag(comp, name)) return fail([], `Error: unknown flag: --${name}`);
  }
  for (const [name, kind] of Object.entries(FLAGS[comp].files)) {
    const path = flags.get(name);
    if (path === undefined || path === "") continue;
    if (!host.files[normPath(path)]) {
      const pre = FLAGS[comp].preamble(now, seq);
      seq += pre.length;
      return fail(pre, errLine(`${kind} ${path}: no such file or directory`));
    }
  }
  if (comp === "kube-apiserver") {
    const bad = unreachableEtcdPort(host, flags);
    if (bad !== undefined) {
      // The apiserver retries its connection to etcd for about 20 s and then gives up (capture 4a).
      const addr = (flags.get("etcd-servers") ?? "").split(",").find((u) => u.includes(`:${bad}`))?.replace(/^https?:\/\//, "") ?? `127.0.0.1:${bad}`;
      const warn = (t: number, ch: number) =>
        containerKlog(t, seq++, "W", "logging.go:55", `[core] [Channel #${ch} SubChannel #${ch + 2}] grpc: addrConn.createTransport failed to connect to {Addr: "${addr}", ServerName: "${addr}", }. Err: connection error: desc = "transport: Error while dialing: dial tcp ${addr}: connect: connection refused"`);
      const err = containerKlog(now + 20_000, seq++, "E", "run.go:72", `"command failed" err="error creating storage factory: etcd grpc connection not ready: context deadline exceeded"`);
      const pre = FLAGS[comp].preamble(now, seq);
      seq += pre.length;
      return [
        ...pre.map((text) => ({ op: "log" as const, text })),
        { op: "log", text: warn(now, 1) },
        { op: "sleep", ms: 5000 },
        { op: "log", text: warn(now + 5000, 5) },
        { op: "sleep", ms: 15_000 },
        { op: "log", text: err },
        { op: "exit", code: 1 },
      ];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- health, for the controllers to gate on (decisions 4 and 5)

/** Whether a control plane is simulated at all: system Pods are on and a Node runs one. A cluster without (a Lesson that turns system Pods off) has no component that could be down. */
export function controlPlaneModelled(cluster: Cluster): boolean {
  return cluster.state.config.systemPods && Object.values(cluster.state.hosts).some((h) => h.role === "control-plane");
}

/** When a control-plane component's healthy container started running, on the Node that runs it, or undefined if none is. */
function componentRunningSince(cluster: Cluster, comp: Component): number | undefined {
  for (const [node, host] of Object.entries(cluster.state.hosts)) {
    if (host.role !== "control-plane") continue;
    const pod = mirrorPod(cluster, node, comp);
    const crt = pod && cluster.state.pods[pod.metadata.uid]?.containers[comp];
    if (!pod || !crt || crt.phase !== "running") continue;
    const flags = flagsOf(pod.spec?.containers[0].command);
    if (comp === "kube-apiserver") {
      // A wrong --secure-port leaves the container running but nothing answers on 6443 (capture 4b).
      if ((flags.get("secure-port") ?? "6443") !== "6443") continue;
      // A wrong --etcd-servers port: it is retrying etcd and serves nothing until it gives up and exits (capture 4a).
      if (unreachableEtcdPort(host, flags) !== undefined) continue;
    }
    return crt.startedAt ?? Number.NEGATIVE_INFINITY;
  }
  return undefined;
}

/** Whether a control-plane component's container is up on the Node that runs it. */
export function componentUp(cluster: Cluster, comp: Component): boolean {
  return componentRunningSince(cluster, comp) !== undefined;
}

/**
 * How long after its container starts a component does its work. The scheduler binds the waiting
 * Pod within the first seconds (capture 3a: Pending at t+0 on restore, Running by t+6 s). The
 * controller-manager first wins its leader election and syncs its informers: Scenario 5 shows no
 * Pods until ~20 s after the manifest came back, ~16 s of it after the container is up. The
 * apiserver needs a few seconds before it answers (capture 4a, 4b: kubectl worked 15 to 22 s
 * after the fix). etcd has no work of its own to gate: it matters through the apiserver (`controlPlaneHealth`).
 */
export const SERVING_AFTER_MS: Record<Component, number> = { etcd: 0, "kube-apiserver": 4000, "kube-controller-manager": 16_000, "kube-scheduler": 1000 };

/** What the control plane can do right now. The kubelet's container lifecycle is not here: it runs whatever this says (ADR 0003, decision 4). */
export interface ControlPlaneHealth {
  /** Answers on 6443: kubectl, the Editor and the Cluster View's actions reach the cluster. */
  api: boolean;
  /** The controllers kube-controller-manager owns run. */
  kcm: boolean;
  /** Pending Pods get bound. */
  scheduler: boolean;
}

/** How long the apiserver rides out an etcd that is not there before it gives up (capture 4a: it retries ~20 s, then exits). */
export const ETCD_GRACE_MS = 20_000;

/** Whether etcd's container is running. */
function etcdUp(cluster: Cluster): boolean {
  for (const [node, host] of Object.entries(cluster.state.hosts)) {
    if (host.role !== "control-plane") continue;
    const pod = mirrorPod(cluster, node, "etcd");
    const crt = pod && cluster.state.pods[pod.metadata.uid]?.containers.etcd;
    if (crt && crt.phase === "running") return true;
  }
  return false;
}

/** Records when etcd went down, once a step: the apiserver survives that long without it. */
export function trackEtcd(cluster: Cluster): void {
  if (!controlPlaneModelled(cluster)) return;
  const st = cluster.state;
  if (etcdUp(cluster)) delete st.etcdDownSince;
  else if (typeof st.etcdDownSince !== "number") st.etcdDownSince = cluster.now;
}

export function controlPlaneHealth(cluster: Cluster): ControlPlaneHealth {
  if (!controlPlaneModelled(cluster)) return { api: true, kcm: true, scheduler: true };
  const now = cluster.now;
  const serving = (comp: Component) => {
    const since = componentRunningSince(cluster, comp);
    return since !== undefined && now - since >= SERVING_AFTER_MS[comp];
  };
  // The apiserver keeps only what etcd holds: with etcd down for longer than its retry window it serves nothing.
  const downSince = cluster.state.etcdDownSince;
  const etcdOk = typeof downSince !== "number" || now - downSince < ETCD_GRACE_MS;
  // Nothing reconciles without the apiserver: a controller that cannot read or write the API does nothing.
  const api = serving("kube-apiserver") && etcdOk;
  return { api, kcm: api && serving("kube-controller-manager"), scheduler: api && serving("kube-scheduler") };
}

/** The node name kubectl on the control plane reaches the apiserver by (the `server:` of admin.conf). */
const apiHost = (cluster: Cluster): string => Object.entries(cluster.state.hosts).find(([, h]) => h.role === "control-plane")?.[0] ?? "controlplane";

/**
 * What kubectl prints, from inside a node, while the apiserver does not answer on 6443 (capture 4a, 4b:
 * the in-node message, not kind's host-side `EOF`); undefined while it does. One line, no discovery
 * errors before it, as the kind capture shows for a kubeconfig that already has a server.
 */
export function apiServerRefusal(cluster: Cluster): string | undefined {
  return controlPlaneHealth(cluster).api ? undefined : `The connection to the server ${apiHost(cluster)}:6443 was refused - did you specify the right host or port?`;
}

/** A save from before hosts existed already holds the mirror Pods: record each as belonging to its manifest, so the first scan leaves them alone. */
export function adoptStaticPods(cluster: Cluster, node: string): void {
  const host = cluster.state.hosts[node];
  const dir = host.services.kubelet.staticPodPath;
  for (const f of dir ? staticFiles(host, dir) : []) {
    const m = readManifest(f.file!.content);
    if (!m.doc) continue;
    const ref = podRef(m.doc, node);
    const [ns, name] = ref.split("/");
    const pod = cluster.raw("Pod", ns, name) as unknown as Pod | undefined;
    if (pod && isStaticPod(pod)) host.static[normPath(`${dir}/${f.name}`)] = { hash: hexId(`${node}:${f.file!.content}`, 32), pod: ref };
  }
}

/** Creates the mirror Pods for every manifest on every host, without waiting for a scan (a new cluster has its control plane running). */
export function bootstrapStaticPods(cluster: Cluster): void {
  for (const node of Object.keys(cluster.state.hosts)) syncStaticPods(cluster, node);
}

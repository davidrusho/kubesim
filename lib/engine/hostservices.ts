// systemd on a Node's host: starting, stopping and restarting the kubelet and containerd, the
// unit the kubelet runs from, and what it reads at start (ADR 0003, decision 2). The journal
// lines follow the capture's Scenarios 1, 2 and 6.

import YAML from "yaml";
import type { Cluster } from "./cluster";
import type { Node } from "./types";
import {
  KUBELET_VERSION,
  hexId,
  journalPush,
  kubeletLog,
  systemdLog,
  unitPaths,
  basename,
  goYamlError,
  type HostState,
  type ServiceName,
  type ServiceState,
} from "./host";

/** systemd's RestartSec for the kubelet (kubeadm's unit says 10). */
export const RESTART_MS = 10_000;
/** The kubelet registers its Ready condition this long after it starts, when the Node was not Ready. */
export const KUBELET_READY_MS = 2000;

export const SERVICE_DESCRIPTION: Record<ServiceName, string> = {
  kubelet: "kubelet: The Kubernetes Node Agent",
  containerd: "containerd container runtime",
};
export const SERVICE_DOCS: Record<ServiceName, string> = { kubelet: "https://kubernetes.io/docs/", containerd: "https://containerd.io" };

/** A null-prototype table: `constructor`, `__proto__` and `toString` are not units, and a lookup must say so rather than find Object's members. */
export const UNIT_NAMES: Record<string, ServiceName> = Object.assign(Object.create(null) as Record<string, ServiceName>, { kubelet: "kubelet", "kubelet.service": "kubelet", containerd: "containerd", "containerd.service": "containerd" });

// ---------------------------------------------------------------- the unit and what it expands to

interface ExecPlan {
  /** Raw ExecStart= of the loaded unit. */
  execStart: string;
  /** What it expands to once the Environment= and EnvironmentFile= variables are filled in. */
  argv: string[];
}

function envTokens(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    const tok = m[1] ?? m[2];
    const eq = tok.indexOf("=");
    if (eq > 0) out.push([tok.slice(0, eq), tok.slice(eq + 1)]);
  }
  return out;
}

function parseEnvFile(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2].trim();
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    out.push([m[1], v]);
  }
  return out;
}

/** The ExecStart of a unit as systemd last loaded it: the unit file, then its drop-ins in file-name order. */
export function execPlan(host: HostState, unit: ServiceName): ExecPlan | undefined {
  const files = Object.keys(host.loaded).filter((p) => new RegExp(`/${unit}\\.service(\\.d/[^/]+\\.conf)?$`).test(p));
  const main = files.filter((p) => p.endsWith(`${unit}.service`)).sort((a, b) => (a.startsWith("/etc") ? 1 : 0) - (b.startsWith("/etc") ? 1 : 0));
  const dropins = files.filter((p) => !p.endsWith(`${unit}.service`)).sort((a, b) => (basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0));
  const env = new Map<string, string>();
  let exec: string | undefined;
  for (const p of [...main, ...dropins]) {
    for (const raw of host.loaded[p].split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const m = /^([A-Za-z]+)=(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === "Environment") for (const [k, v] of envTokens(m[2])) env.set(k, v);
      else if (m[1] === "EnvironmentFile") {
        // systemd reads the file when it starts the process, not when it loads the unit.
        const optional = m[2].startsWith("-");
        const f = host.files[m[2].replace(/^-/, "")];
        if (f) for (const [k, v] of parseEnvFile(f.content)) env.set(k, v);
        else if (!optional) env.set("__missing", m[2]);
      } else if (m[1] === "ExecStart") exec = m[2].trim() === "" ? undefined : m[2].trim();
    }
  }
  if (exec === undefined) return undefined;
  const expanded = exec.replace(/^[-@:+!]+/, "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a: string, b: string) => env.get(a ?? b) ?? "");
  return { execStart: exec, argv: expanded.split(/\s+/).filter(Boolean) };
}

/** Whether a unit or drop-in file changed on disk since systemd loaded it: it says so until `daemon-reload`. */
export function needsReload(host: HostState, unit: ServiceName): boolean {
  const re = new RegExp(`/${unit}\\.service(\\.d/[^/]+\\.conf)?$`);
  const now = unitPaths(host.files).filter((p) => re.test(p));
  const was = Object.keys(host.loaded).filter((p) => re.test(p));
  if (now.length !== was.length) return true;
  return now.some((p) => host.loaded[p] !== host.files[p].content);
}

export function daemonReload(cluster: Cluster, node: string): void {
  const host = cluster.state.hosts[node];
  host.loaded = {};
  for (const p of unitPaths(host.files)) host.loaded[p] = host.files[p].content;
  cluster.hostChanged();
}

// ---------------------------------------------------------------- what the kubelet needs at start

interface Klog {
  level: "I" | "W" | "E";
  src: string;
  msg: string;
}
export type StartOutcome =
  | { ok: true; staticPodPath?: string; plan: ExecPlan }
  /** `klog` lines are the kubelet's own (status 1); `systemd` lines are systemd's (status 203/EXEC: it never got to run the process). */
  | { ok: false; status: "1/FAILURE" | "203/EXEC"; plan?: ExecPlan; klog?: Klog[]; systemd?: string[] };

/** The container runtime endpoint the kubelet will use, as a socket path, if it names the containerd socket. */
const CONTAINERD_SOCKETS = ["/run/containerd/containerd.sock", "/var/run/containerd/containerd.sock"];

const flagValue = (argv: string[], name: string): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
};

/** Everything the kubelet checks when its process starts: the unit's ExecStart, then config.yaml, then the runtime endpoint (Scenario 6). */
export function evaluateKubeletStart(host: HostState): StartOutcome {
  try {
    return evaluateStart(host);
  } catch (e) {
    // Whatever the unit or config holds that the engine cannot read, the kubelet fails to start; the engine does not throw.
    return { ok: false, status: "1/FAILURE", klog: [{ level: "E", src: "run.go:72", msg: `"command failed" err="failed to load kubelet config file: ${(e as Error).message.replace(/"/g, "'").slice(0, 120)}"` }] };
  }
}

function evaluateStart(host: HostState): StartOutcome {
  const plan = execPlan(host, "kubelet");
  if (!plan) return { ok: false, status: "203/EXEC", systemd: ["Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing."] };
  const bin = plan.argv[0];
  if (!bin || !host.files[bin]) {
    return { ok: false, status: "203/EXEC", plan, systemd: [`Failed at step EXEC spawning ${bin ?? ""}: No such file or directory`] };
  }
  const cfgPath = flagValue(plan.argv, "config");
  let cfg: { containerRuntimeEndpoint?: string; staticPodPath?: string } = {};
  if (cfgPath !== undefined) {
    const f = host.files[cfgPath];
    const failed = (why: string): StartOutcome => ({
      ok: false,
      status: "1/FAILURE",
      plan,
      klog: [{ level: "E", src: "run.go:72", msg: `"command failed" err="failed to load kubelet config file, path: ${cfgPath}, error: failed to load Kubelet config file ${cfgPath}, error ${why}"` }],
    });
    if (!f) return failed(`failed to read kubelet config file \\"${cfgPath}\\", error: open ${cfgPath}: no such file or directory`);
    let doc: unknown;
    try {
      const parsed = YAML.parseDocument(f.content);
      if (parsed.errors.length) return failed(`error converting YAML to JSON: ${goYamlError(parsed.errors[0])}`);
      doc = parsed.toJS();
    } catch (e) {
      return failed(`error converting YAML to JSON: yaml: ${(e as Error).message.split("\n")[0].slice(0, 120)}`);
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || (doc as { kind?: string }).kind !== "KubeletConfiguration") {
      return failed(`failed to decode: no kind \\"${(doc as { kind?: string } | null)?.kind ?? ""}\\" is registered for version \\"kubelet.config.k8s.io/v1beta1\\"`);
    }
    cfg = doc as typeof cfg;
    // A field of the wrong type does not decode, as in Go's strict JSON.
    for (const field of ["containerRuntimeEndpoint", "staticPodPath"] as const) {
      const val: unknown = cfg[field];
      if (val !== undefined && typeof val !== "string") return failed(`error unmarshaling JSON: while decoding JSON: json: cannot unmarshal ${typeof val === "number" ? "number" : typeof val === "boolean" ? "bool" : "object"} into Go struct field KubeletConfiguration.${field} of type string`);
    }
  }
  const endpoint = flagValue(plan.argv, "container-runtime-endpoint") ?? cfg.containerRuntimeEndpoint ?? "unix:///run/containerd/containerd.sock";
  const sock = endpoint.replace(/^unix:\/\//, "");
  // /var/run is a symlink to /run.
  if (!CONTAINERD_SOCKETS.includes(sock) || !host.files[sock.replace(/^\/var\/run\//, "/run/")]) {
    return {
      ok: false,
      status: "1/FAILURE",
      plan,
      klog: [
        { level: "W", src: "logging.go:55", msg: `[core] [Channel #1 SubChannel #2] grpc: addrConn.createTransport failed to connect to {Addr: "${sock}", ServerName: "localhost", }. Err: connection error: desc = "transport: Error while dialing: dial unix ${sock}: connect: no such file or directory"` },
        { level: "E", src: "run.go:72", msg: `"command failed" err="failed to run Kubelet: validate service connection: validate CRI v1 runtime API for endpoint \\"${endpoint}\\": rpc error: code = Unavailable desc = connection error: desc = \\"transport: Error while dialing: dial unix ${sock}: connect: no such file or directory\\""` },
      ],
    };
  }
  return { ok: true, plan, staticPodPath: cfg.staticPodPath };
}

// ---------------------------------------------------------------- lifecycle

/** The tail of the kubelet's config dump, which it prints before it says why it failed (capture Scenario 6). The head line is a stand-in: the capture trimmed it. */
const CONFIG_DUMP = [
  "        registerNode: true",
  "        registryBurst: 10",
  "        registryPullQPS: 5",
  "        resolvConf: /etc/resolv.conf",
  "        rotateCertificates: true",
  "        runtimeRequestTimeout: 2m0s",
  "        seccompDefault: false",
  "        serializeImagePulls: true",
  "        shutdownGracePeriod: 0s",
  "        shutdownGracePeriodCriticalPods: 0s",
  "        staticPodPath: /etc/kubernetes/manifests",
  "        streamingConnectionIdleTimeout: 4h0m0s",
  "        syncFrequency: 1m0s",
  "        topologyManagerPolicy: none",
  "        topologyManagerScope: container",
  "        volumePluginDir: /usr/libexec/kubernetes/kubelet-plugins/volume/exec/",
  "        volumeStatsAggPeriod: 1m0s",
  " >",
];

function startupLines(cluster: Cluster, node: string, withDump: boolean): void {
  const host = cluster.state.hosts[node];
  const pid = host.services.kubelet.pid;
  if (withDump) {
    kubeletLog(cluster, node, "I", "server.go:253", `"Kubelet config" config=<`);
    for (const l of CONFIG_DUMP) journalPush(host, "kubelet", cluster.now, `kubelet[${pid}]: ${l}`);
  }
  kubeletLog(cluster, node, "I", "server.go:545", `"Kubelet version" kubeletVersion="${KUBELET_VERSION}"`);
  kubeletLog(cluster, node, "I", "server.go:547", `"Golang settings" GOGC="" GOMAXPROCS="" GOTRACEBACK=""`);
  kubeletLog(cluster, node, "I", "watchdog_linux.go:94", `"Systemd watchdog is not enabled"`);
  kubeletLog(cluster, node, "I", "watchdog_linux.go:137", `"Systemd watchdog is not enabled or the interval is invalid, so health checking will not be started."`);
  kubeletLog(cluster, node, "I", "server.go:1036", `"Client rotation is on, will bootstrap in background"`);
  kubeletLog(cluster, node, "I", "certificate_store.go:147", `"Loading cert/key pair from a file" filePath="/var/lib/kubelet/pki/kubelet-client-current.pem"`);
  kubeletLog(cluster, node, "I", "dynamic_cafile_content.go:161", `"Starting controller" name="client-ca-bundle::/etc/kubernetes/pki/ca.crt"`);
}

function newRun(host: HostState, node: string, unit: ServiceName, svc: ServiceState): void {
  svc.pid = host.nextPid;
  host.nextPid += 13;
  svc.invocation = hexId(`${node}/${unit}/${svc.pid}`, 32);
}

/** Writes the journal for a boot-time start of a Node's services, so `journalctl -u kubelet` has something to read from the first command. */
export function seedJournal(cluster: Cluster, node: string): void {
  const host = cluster.state.hosts[node];
  for (const unit of ["containerd", "kubelet"] as const) {
    systemdLog(cluster, node, unit, `Started ${unit}.service - ${SERVICE_DESCRIPTION[unit]}.`);
    if (unit === "kubelet") {
      const out = evaluateKubeletStart(host);
      if (out.ok) {
        host.services.kubelet.execStart = out.plan.execStart;
        host.services.kubelet.cmdline = out.plan.argv.join(" ");
        host.services.kubelet.staticPodPath = out.staticPodPath;
      }
      startupLines(cluster, node, false);
      kubeletLog(cluster, node, "I", "apiserver.go:51", `"Watching apiserver"`);
    }
  }
}

/** Whether the kubelet is up and posting: its service runs, the container runtime runs and the Node has power. */
export function kubeletPosting(cluster: Cluster, node: string): boolean {
  const rt = cluster.state.nodes[node];
  const svc = cluster.state.hosts[node]?.services.kubelet;
  // With the container runtime down the kubelet cannot report the Node healthy: it posts nothing that keeps it Ready, and the grace period runs out as for a stopped kubelet.
  const runtime = cluster.state.hosts[node]?.services.containerd;
  return !!rt && rt.up && (!svc || svc.active === "active") && (!runtime || runtime.active === "active");
}

/** A Node the control plane has already marked Unknown reports Ready a couple of seconds after its kubelet can report again (capture: Ready within ~3 s). */
function readyAgain(cluster: Cluster, node: string): void {
  const rt = cluster.state.nodes[node];
  const obj = cluster.raw("Node", undefined, node) as unknown as Node | undefined;
  if (rt && obj?.status?.conditions.find((c) => c.type === "Ready")?.status !== "True") rt.readyAt = cluster.now + KUBELET_READY_MS;
}

/** Starts a service; for the kubelet this is where config.yaml, the unit and the runtime endpoint are checked. */
export function startService(cluster: Cluster, node: string, unit: ServiceName): void {
  const host = cluster.state.hosts[node];
  const svc = host.services[unit];
  const now = cluster.now;
  if (svc.active === "active") return;
  newRun(host, node, unit, svc);
  svc.failure = undefined;
  svc.duration = undefined;
  if (unit === "containerd") {
    svc.active = "active";
    svc.since = now;
    systemdLog(cluster, node, unit, `Started ${unit}.service - ${SERVICE_DESCRIPTION[unit]}.`);
    cluster.hostChanged();
    return;
  }
  systemdLog(cluster, node, unit, `Started ${unit}.service - ${SERVICE_DESCRIPTION[unit]}.`);
  const out = evaluateKubeletStart(host);
  if (out.plan) {
    svc.execStart = out.plan.execStart;
    svc.cmdline = out.plan.argv.join(" ");
  }
  if (out.ok) {
    svc.active = "active";
    svc.since = now;
    svc.staticPodPath = out.staticPodPath;
    startupLines(cluster, node, false);
    kubeletLog(cluster, node, "I", "apiserver.go:51", `"Watching apiserver"`);
    readyAgain(cluster, node);
    cluster.hostChanged();
    return;
  }
  if (out.status === "1/FAILURE") {
    startupLines(cluster, node, true);
    for (const k of out.klog ?? []) kubeletLog(cluster, node, k.level, k.src, k.msg);
    systemdLog(cluster, node, unit, `${unit}.service: Main process exited, code=exited, status=1/FAILURE`);
  } else {
    for (const j of out.systemd ?? []) systemdLog(cluster, node, unit, `${unit}.service: ${j}`);
    systemdLog(cluster, node, unit, `${unit}.service: Main process exited, code=exited, status=203/EXEC`);
  }
  systemdLog(cluster, node, unit, `${unit}.service: Failed with result 'exit-code'.`);
  svc.active = "activating";
  svc.since = now;
  svc.failure = { status: out.status, retryAt: now + RESTART_MS };
  cluster.hostChanged();
}

/** Stops a service. The kubelet's containers keep running, as the capture shows. */
export function stopService(cluster: Cluster, node: string, unit: ServiceName): void {
  const host = cluster.state.hosts[node];
  const svc = host.services[unit];
  if (svc.active === "inactive") return;
  const now = cluster.now;
  if (svc.active === "active") {
    svc.duration = now - svc.since;
    if (unit === "kubelet") {
      kubeletLog(cluster, node, "I", "eviction_manager.go:224", `"Eviction manager: monitoring loop exiting" err="context canceled"`);
      kubeletLog(cluster, node, "I", "podcertificatemanager.go:351", `"podcertificate.IssuingManager shut down"`);
      kubeletLog(cluster, node, "I", "volume_manager.go:341", `"Shutting down Kubelet Volume Manager"`);
      kubeletLog(cluster, node, "I", "tlsconfig.go:258", `"Shutting down DynamicServingCertificateController"`);
      kubeletLog(cluster, node, "I", "server.go:302", `"Shutting down pods API server"`);
    }
  }
  systemdLog(cluster, node, unit, `Stopping ${unit}.service - ${SERVICE_DESCRIPTION[unit]}...`);
  systemdLog(cluster, node, unit, `${unit}.service: Deactivated successfully.`);
  systemdLog(cluster, node, unit, `Stopped ${unit}.service - ${SERVICE_DESCRIPTION[unit]}.`);
  svc.active = "inactive";
  svc.since = now;
  svc.failure = undefined;
  cluster.hostChanged();
}

export function restartService(cluster: Cluster, node: string, unit: ServiceName): void {
  stopService(cluster, node, unit);
  startService(cluster, node, unit);
}

export function setEnabled(cluster: Cluster, node: string, unit: ServiceName, enabled: boolean): void {
  cluster.state.hosts[node].services[unit].enabled = enabled;
  cluster.hostChanged();
}

/** Runs systemd's timers: a failed kubelet start is tried again after RestartSec (`activating (auto-restart)`). */
export function runServices(cluster: Cluster): void {
  const now = cluster.now;
  for (const [node, host] of Object.entries(cluster.state.hosts)) {
    const rt = cluster.state.nodes[node];
    if (!rt?.up) continue;
    const svc = host.services.kubelet;
    if (svc.active === "activating" && svc.failure && now >= svc.failure.retryAt) {
      svc.restarts++;
      systemdLog(cluster, node, "kubelet", `kubelet.service: Scheduled restart job, restart counter is at ${svc.restarts}.`);
      startService(cluster, node, "kubelet");
    }
  }
}

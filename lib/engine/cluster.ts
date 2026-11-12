// The Simulated Cluster: an in-memory API server (store + admission +
// validation), a simulated clock, and controllers that reconcile on each step.
// All state is plain JSON so a cluster can be snapshotted and restored.

import type { Program } from "./images";
import {
  API_VERSIONS,
  NAMESPACED_KINDS,
  type AnyObject,
  type KubeEvent,
  type KubeObject,
  type Node,
  type Pod,
  type NewObject,
} from "./types";
import { resourceName } from "./kinds";
import { admit } from "./admission";
import { validate } from "./validation";
import { clone, deepEqual, Rng, randSuffix, SIM_EPOCH } from "./util";
import { LAST_APPLIED, lastApplied, threeWayMerge } from "./apply";
import { KINDS } from "./kinds";
import { runKubelets } from "./controllers/kubelet";
import { adoptStaticPods, apiServerRefusal, controlPlaneHealth, isStaticPod, recreateMirror, runStaticPods, trackEtcd } from "./controllers/staticpods";
import { buildHost, type HostState } from "./host";
import { runServices, seedJournal } from "./hostservices";
import { runScheduler } from "./controllers/scheduler";
import { runReplicaSets } from "./controllers/replicaset";
import { runDeployments } from "./controllers/deployment";
import { runStatefulSets } from "./controllers/statefulset";
import { runDaemonSets } from "./controllers/daemonset";
import { runJobs } from "./controllers/job";
import { runCronJobs } from "./controllers/cronjob";
import { runHPAs } from "./controllers/hpa";
import { runMetrics, type MetricsState } from "./controllers/metrics";
import { runLoad, type ContainerFlow, type LoadState, type LoadStats } from "./controllers/load";
import { runStorage } from "./controllers/storage";
import { runNetworkControllers, ensureNamespaceDefaults } from "./controllers/network";
import { runNodeLifecycle } from "./controllers/node-lifecycle";
import { runEndpoints } from "./controllers/endpoints";
import { runEndpointSlices } from "./controllers/endpointslices";
import { runGarbageCollector } from "./controllers/gc";
import { checkQuota, runDisruptionController, runQuotaController } from "./policy";
import { bootstrap } from "./bootstrap";
import { checkEscalation, runClusterRoleAggregation, type UserInfo } from "./rbac";
import { unsupportedWarnings } from "./warnings";

export { resourceName };

export const STEP_MS = 100;

/** Most Pods a Simulated Cluster holds (also the share-link loader's limit), so the browser stays responsive. */
export const MAX_PODS = 600;

export interface NodeConfig {
  name: string;
  role: "control-plane" | "worker";
}

export interface ClusterConfig {
  seed: number;
  nodes: NodeConfig[];
  /** How long without heartbeats before a Node goes NotReady (kube default 50s). */
  nodeMonitorGracePeriodMs: number;
  /** Default tolerationSeconds for not-ready/unreachable taints (kube default 300s). */
  defaultTolerationSeconds: number;
  /** Include kube-system Pods (etcd, apiserver, coredns, kube-proxy…). */
  systemPods: boolean;
}

export const DEFAULT_CONFIG: ClusterConfig = {
  seed: 42,
  nodes: [
    { name: "control-plane", role: "control-plane" },
    { name: "worker-1", role: "worker" },
    { name: "worker-2", role: "worker" },
  ],
  nodeMonitorGracePeriodMs: 50_000,
  defaultTolerationSeconds: 300,
  systemPods: true,
};

/** The two Nodes the CKA exam environment has, for Incidents that work on hosts (ADR 0003, decision 7). The default cluster keeps kind's names. */
export const EXAM_NODES: NodeConfig[] = [
  { name: "controlplane", role: "control-plane" },
  { name: "node01", role: "worker" },
];

export type ContainerPhase =
  | "pulling"
  | "pullError" // shows ErrImagePull
  | "pullBackoff" // shows ImagePullBackOff
  | "configError" // shows CreateContainerConfigError
  | "creating"
  | "running"
  | "exited" // shows terminated (Error/Completed) briefly
  | "crashBackoff" // shows CrashLoopBackOff
  | "done" // terminated for good (restartPolicy says so)
  | "stopping"
  | "dead"; // killed with its Node; status is stale until the Node returns

export interface ContainerRuntime {
  phase: ContainerPhase;
  until: number;
  image: string;
  backoffMs: number;
  program?: Program;
  pc: number;
  wakeAt: number;
  startedAt?: number;
  exitCode?: number;
  exitReason?: string;
  exitMessage?: string;
  pullStartedAt?: number;
  /** Times this container has been restarted (status.restartCount). */
  restarts: number;
  /** Previous termination, shown as lastState. */
  lastTerm?: { exitCode: number; reason: string; startedAt?: number; finishedAt: number; message?: string };
  /** When the last container run started (for back-off reset). */
  lastRunStart?: number;
  /** Resolved environment for this run. */
  env?: Record<string, string>;
  /** The container's writable layer: path → content. Reset on every restart. */
  fs?: Record<string, string>;
  /** Exit code of the last command the program ran (for && and ||). */
  lastCode?: number;
  /** Memory the program allocated, CPU it burns (millicores), requests served recently (sim ms). */
  alloc?: number;
  burn?: number;
  reqs?: number[];
  /** Requests it answered with a 5xx (sim ms), for error rates. */
  errs?: number[];
  /** What the traffic control's flow of requests did here (controllers/load.ts). */
  flow?: ContainerFlow;
  /** Readiness as the prober sees it; startup probe passed. */
  ready?: boolean;
  started?: boolean;
  probes?: { startup?: ProbeState; liveness?: ProbeState; readiness?: ProbeState };
  /** Being killed by a failed probe: exits at this time. */
  killAt?: number;
  /** Current items of the program's `for` loops (variable → value), and each loop's position (forinit index → item index). */
  loopVars?: Record<string, string>;
  loopIdx?: Record<number, number>;
}

export interface ProbeState {
  next: number;
  ok: number;
  fail: number;
}

export interface PodRuntime {
  containers: Record<string, ContainerRuntime>;
  stoppingUntil?: number;
  /** Sandbox is ready (IP assigned) from this time. */
  sandboxAt: number;
  /** Volumes were mounted at this time. */
  mountedAt?: number;
  mountRetryAt?: number;
  /** ConfigMap/Secret volume contents as the kubelet last projected them. */
  projected?: Record<string, Record<string, string>>;
  projectedAt?: number;
  subPaths?: Record<string, Record<string, string>>;
  /** All init containers have completed (sidecars: started). Undefined for Pods saved before init containers ran. */
  initialized?: boolean;
  /** The kubelet failed the whole Pod (activeDeadlineSeconds): status.reason/message. */
  failedReason?: { reason: string; message: string };
}

export interface NodeRuntime {
  up: boolean;
  lastHeartbeat: number;
  images: string[];
  nextPodIp: number;
  index: number;
  /** When the kubelet first reports Ready after registering. */
  readyAt: number;
}

export interface LogLine {
  t: number;
  text: string;
}

export interface ClusterState {
  config: ClusterConfig;
  now: number;
  rng: number;
  rv: number;
  objects: Record<string, AnyObject>;
  pods: Record<string, PodRuntime>;
  nodes: Record<string, NodeRuntime>;
  /** The host behind each Node (ADR 0003): systemd services, files by absolute path, a journal. Saves from before it existed get default hosts. */
  hosts: Record<string, HostState>;
  /** Logs keyed by `${podUid}/${container}/${restartCount}`. */
  logs: Record<string, LogLine[]>;
  nextClusterIp: number;
  scheduleAttempts: Record<string, number>;
  accum: number;
  /** Data in volumes (emptyDir, PersistentVolumes, hostPath): store key → path → content. */
  volumes: Record<string, Record<string, string>>;
  /** metrics-server's last scrape. */
  metrics: MetricsState;
  /** HPA recommendation history, by HPA uid. */
  hpa: Record<string, { recs: { t: number; n: number }[]; events?: { t: number; delta: number }[] }>;
  /** Controller timers and one-shot markers: key → sim ms. */
  timers: Record<string, number>;
  /** Since when etcd has not been running, while the apiserver rides it out (ADR 0003, decision 4). Absent while etcd is up. */
  etcdDownSince?: number;
  lbNext: number;
  eventSeq: number;
  /** Separate generator for load-balancing picks, so curl traffic never shifts generated names. */
  trafficRng: number;
  /** Requests to a Service that had no ready endpoint to send them to (sim ms), by Service uid. */
  svcErrs?: Record<string, number[]>;
  /** Where the Learner dragged cards on the Cluster View (top-left, diagram units), by objKey. Not part of Kubernetes: kept so a saved or shared cluster looks the way it was left. */
  layout?: Record<string, { x: number; y: number }>;
  /** Bumped on every layout change (and traffic setting), so autosave notices. */
  layoutRev?: number;
  /** The traffic control: a steady flow of requests to one Service (controllers/load.ts). */
  load?: LoadState;
  loadStats?: LoadStats;
  /** Flow requests a Service had no ready endpoint for (counts per sample), by Service uid. */
  loadLost?: Record<string, { t: number[]; n: number[] }>;
}

export type ClusterSignal =
  | { type: "change" }
  | { type: "event"; event: KubeEvent }
  | { type: "traffic"; serviceUid?: string; ingressUid?: string; podUid: string; fromUid?: string; nodeName?: string; ok: boolean; blocked?: boolean; via: "clusterip" | "nodeport" | "lb" | "ingress" | "pod" };

export class ApiError extends Error {
  constructor(
    message: string,
    public reason: "NotFound" | "AlreadyExists" | "Invalid" | "BadRequest" | "Forbidden" | "Conflict" | "Unreachable",
  ) {
    super(message);
  }
}

export function objKey(kind: string, namespace: string | undefined, name: string): string {
  return `${kind}/${NAMESPACED_KINDS.has(kind) ? (namespace ?? "default") : ""}/${name}`;
}

/** Who is making an API call (kubectl --as). Without it the call is the cluster admin's. */
export interface RequestOptions {
  user?: UserInfo;
}

export interface DeleteOptions {
  gracePeriodSeconds?: number;
  force?: boolean;
  /** Orphan leaves dependents running with this owner's reference removed (kubectl delete --cascade=orphan). */
  propagationPolicy?: "Background" | "Foreground" | "Orphan";
}

export const FOREGROUND = "foregroundDeletion";

export class Cluster {
  state: ClusterState;
  rng: Rng;
  trafficRng: Rng;
  private listeners = new Set<(s: ClusterSignal) => void>();
  /** kind → store keys, so list() doesn't scan every object. Derived; not part of snapshots. */
  private byKind = new Map<string, Set<string>>();
  /** kind → store keys in list() order (by name). Derived cache, dropped when a key of that kind comes or goes. */
  private sorted = new Map<string, string[]>();
  /** Event dedupe key → store key, so record() needn't scan every Event. Derived; rebuilt on demand. */
  private eventIdx?: Map<string, string>;
  /** API warnings for the current user request (see drainWarnings). Not part of snapshots. */
  private warnings: string[] = [];
  /** True while controllers run: their API calls don't produce user-facing warnings. */
  private inStep = false;
  private index(): Map<string, Set<string>> {
    if (this.byKind.size === 0 && Object.keys(this.state.objects).length) {
      for (const [key, o] of Object.entries(this.state.objects)) (this.byKind.get(o.kind) ?? this.byKind.set(o.kind, new Set()).get(o.kind)!).add(key);
    }
    return this.byKind;
  }
  private changed = false;
  /** Bumped whenever anything observable changes; handy for React. */
  version = 0;
  /** Set when cluster changes may let unschedulable Pods fit; the scheduler retries at once. */
  schedulerWake = false;

  constructor(configOrState?: Partial<ClusterConfig> | ClusterState) {
    if (configOrState && "objects" in configOrState) {
      this.state = clone(configOrState);
      // Snapshots from before these fields existed.
      this.state.volumes ??= {};
      this.state.hosts ??= {};
      for (const [name, rt] of Object.entries(this.state.nodes)) {
        if (this.state.hosts[name]) continue;
        const role = this.state.config.nodes.find((n) => n.name === name)?.role ?? "worker";
        this.state.hosts[name] = buildHost(this, name, role, rt.index, this.state.config.systemPods);
        seedJournal(this, name);
        adoptStaticPods(this, name);
      }
      this.state.metrics ??= { at: 0, pods: {}, nodes: {} };
      this.state.hpa ??= {};
      this.state.timers ??= {};
      this.state.lbNext ??= 0;
      this.state.eventSeq ??= 0;
      this.state.trafficRng ??= (this.state.config.seed ^ 0x5bd1e995) | 0;
      this.rng = new Rng(this.state.rng);
      this.trafficRng = new Rng(this.state.trafficRng);
    } else {
      const config = { ...DEFAULT_CONFIG, ...(configOrState ?? {}) };
      this.state = {
        config,
        now: 0,
        rng: config.seed,
        rv: 1000,
        objects: {},
        pods: {},
        nodes: {},
        hosts: {},
        logs: {},
        nextClusterIp: 1,
        scheduleAttempts: {},
        accum: 0,
        volumes: {},
        metrics: { at: 0, pods: {}, nodes: {} },
        hpa: {},
        timers: {},
        lbNext: 0,
        eventSeq: 0,
        trafficRng: (config.seed ^ 0x5bd1e995) | 0,
      };
      this.rng = new Rng(config.seed);
      this.trafficRng = new Rng(this.state.trafficRng);
      this.inStep = true; // bootstrap isn't a user request
      bootstrap(this);
      this.inStep = false;
      // Let system Pods come up before the Learner arrives.
      this.advance(config.systemPods ? 30_000 : 5_000);
    }
  }

  get now(): number {
    return this.state.now;
  }

  // ---------- signals ----------

  subscribe(fn: (s: ClusterSignal) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(s: ClusterSignal): void {
    for (const l of this.listeners) l(s);
  }

  private flush(): void {
    if (this.changed) {
      this.changed = false;
      this.version++;
      this.emit({ type: "change" });
    }
  }

  // ---------- time ----------

  /** Advances simulated time by `ms`, running controllers every STEP_MS. */
  tick(ms: number): void {
    this.state.accum += ms;
    while (this.state.accum >= STEP_MS) {
      this.state.accum -= STEP_MS;
      this.step();
    }
    this.flush();
  }

  /** Advances time without emitting per-step signals (setup, tests). */
  advance(ms: number): void {
    const steps = Math.round(ms / STEP_MS);
    for (let i = 0; i < steps; i++) this.step();
    this.flush();
  }

  private step(): void {
    this.inStep = true;
    try {
      this.runControllers();
    } finally {
      this.inStep = false;
    }
  }

  private runControllers(): void {
    this.state.now += STEP_MS;
    // Each control-plane component gates what it owns (ADR 0003, decision 4). The node side below it
    // (services, static Pods, the kubelet's containers) runs whatever the control plane is doing.
    // kube-controller-manager owns the ReplicaSet, Deployment, StatefulSet, DaemonSet, Job, CronJob,
    // endpoints, endpointslice, node-lifecycle, HPA, disruption, resource-quota, garbage-collector, PV and
    // cluster-role-aggregation controllers: they are named in the `--controllers` list of
    // https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/
    // (replicaset-controller, deployment-controller, statefulset-controller, daemonset-controller, job-controller,
    // cronjob-controller, endpoints-controller, endpointslice-controller, node-lifecycle-controller,
    // horizontal-pod-autoscaler-controller, disruption-controller, resourcequota-controller,
    // garbage-collector-controller, persistentvolume-binder-controller, clusterrole-aggregation-controller,
    // serviceaccount-controller, root-ca-certificate-publisher-controller). Metrics and customers' traffic are not.
    runServices(this);
    runStaticPods(this);
    runKubelets(this);
    trackEtcd(this);
    const cp = controlPlaneHealth(this);
    if (cp.kcm) runNodeLifecycle(this);
    if (cp.kcm) runStorage(this);
    if (cp.scheduler) runScheduler(this);
    if (cp.kcm) {
      runEndpoints(this);
      runEndpointSlices(this);
      runReplicaSets(this);
      runDeployments(this);
      runStatefulSets(this);
      runDaemonSets(this);
      runJobs(this);
      runCronJobs(this);
    }
    // Customers' traffic and the metrics scrape do not go through the API.
    runLoad(this);
    runMetrics(this);
    if (cp.kcm) runHPAs(this);
    if (cp.api) runNetworkControllers(this, cp.kcm);
    if (cp.kcm) {
      runDisruptionController(this);
      runClusterRoleAggregation(this);
      if (this.state.now % 1000 === 0) runQuotaController(this);
      // The garbage collector works from an informer cache in real clusters; every 500ms is plenty.
      if (this.state.now % 500 === 0) runGarbageCollector(this);
    }
    this.state.rng = this.rng.state;
    this.state.trafficRng = this.trafficRng.state;
  }

  // ---------- API warnings ----------

  /** A warning for the user's current API request (like the apiserver's Warning: header). Ignored for controllers' own calls. */
  warn(message: string): void {
    if (this.inStep) return;
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** Returns and clears the warnings raised since the last call. kubectl prints each as `Warning: <text>`. */
  drainWarnings(): string[] {
    const w = this.warnings;
    this.warnings = [];
    return w;
  }

  // ---------- raw store ----------

  uid(): string {
    const h = () => this.rng.int(0x10000).toString(16).padStart(4, "0");
    return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
  }

  genName(prefix: string): string {
    return `${prefix}${randSuffix(this.rng)}`;
  }

  raw(kind: string, namespace: string | undefined, name: string): AnyObject | undefined {
    return this.state.objects[objKey(kind, namespace, name)];
  }

  list<T extends KubeObject = AnyObject>(kind: string, namespace?: string): T[] {
    let keys = this.sorted.get(kind);
    if (!keys) {
      keys = [...(this.index().get(kind) ?? [])].filter((k) => this.state.objects[k]);
      // Byte order of names, like Go's sort (stable, so same-named objects keep insertion order).
      const name = (k: string) => this.state.objects[k].metadata.name;
      keys.sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
      this.sorted.set(kind, keys);
    }
    const out: T[] = [];
    const filter = namespace !== undefined && NAMESPACED_KINDS.has(kind);
    for (const key of keys) {
      const o = this.state.objects[key];
      if (!o) continue;
      if (filter && o.metadata.namespace !== namespace) continue;
      out.push(o as unknown as T);
    }
    return out;
  }

  byUid(uid: string): AnyObject | undefined {
    for (const o of Object.values(this.state.objects)) if (o.metadata.uid === uid) return o;
    return undefined;
  }

  /** Stores an object if it differs from what's stored; bumps resourceVersion. */
  put<T extends KubeObject>(obj: T): T {
    const key = objKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    const prev = this.state.objects[key];
    if (prev && deepEqual({ ...prev, metadata: { ...prev.metadata, resourceVersion: "" } }, { ...obj, metadata: { ...obj.metadata, resourceVersion: "" } })) {
      return prev as unknown as T;
    }
    const next = { ...obj, metadata: { ...obj.metadata, resourceVersion: String(++this.state.rv) } } as T;
    if (!prev) {
      const idx = this.index();
      (idx.get(obj.kind) ?? idx.set(obj.kind, new Set()).get(obj.kind)!).add(key);
      this.sorted.delete(obj.kind);
    }
    this.state.objects[key] = next as unknown as AnyObject;
    if (obj.kind === "Node" || obj.kind === "PersistentVolumeClaim" || obj.kind === "PersistentVolume") this.schedulerWake = true;
    this.changed = true;
    return next;
  }

  /** Like update(), for status writers: only `status` is copied, so fn must change nothing else. Cheap when nothing changed. */
  updateStatus<T extends KubeObject>(obj: T, fn: (draft: T) => void): T {
    const draft = { ...obj, status: clone(obj.status) } as T;
    fn(draft);
    return this.put(draft);
  }

  /** Clone-modify-put in one call. */
  update<T extends KubeObject>(obj: T, fn: (draft: T) => void): T {
    const draft = clone(obj);
    fn(draft);
    return this.put(draft);
  }

  remove(obj: KubeObject): void {
    const key = objKey(obj.kind, obj.metadata.namespace, obj.metadata.name);
    const stored = this.state.objects[key];
    if (!stored) return;
    this.index().get(obj.kind)?.delete(key);
    this.sorted.delete(obj.kind);
    delete this.state.objects[key];
    this.schedulerWake = true;
    if (obj.kind === "Event" && this.eventIdx) {
      const k = eventKey(stored as unknown as KubeEvent);
      if (this.eventIdx.get(k) === key) this.eventIdx.delete(k);
    }
    if (obj.kind === "Pod") {
      const uid = obj.metadata.uid;
      delete this.state.pods[uid];
      delete this.state.scheduleAttempts[uid];
      for (const k of Object.keys(this.state.volumes)) if (k.startsWith(`emptydir/${uid}/`)) delete this.state.volumes[k];
      // The runtime garbage-collects a deleted Pod's container logs.
      for (const k of Object.keys(this.state.logs)) if (k.startsWith(`${uid}/`)) delete this.state.logs[k];
    }
    this.changed = true;
  }

  markChanged(): void {
    this.changed = true;
  }

  /** A host file or service changed: autosave must notice although no API object did (it compares the revision this bumps). */
  hostChanged(): void {
    this.state.layoutRev = (this.state.layoutRev ?? 0) + 1;
    this.changed = true;
  }

  // ---------- events ----------

  record(
    obj: KubeObject,
    type: "Normal" | "Warning",
    reason: string,
    message: string,
    component: string,
    host?: string,
    fieldPath?: string,
  ): void {
    const ns = obj.metadata.namespace ?? "default";
    if (!this.eventIdx) {
      this.eventIdx = new Map();
      for (const e of this.list<KubeEvent>("Event")) this.eventIdx.set(eventKey(e), objKey("Event", e.metadata.namespace, e.metadata.name));
    }
    const dedupe = `${ns}|${obj.metadata.uid}|${reason}|${message}`;
    const existingKey = this.eventIdx.get(dedupe);
    const existing = existingKey ? (this.state.objects[existingKey] as unknown as KubeEvent | undefined) : undefined;
    let ev: KubeEvent;
    if (existing) {
      ev = this.update(existing, (e) => {
        e.count += 1;
        e.lastTimestamp = this.now;
      });
    } else {
      ev = this.put<KubeEvent>({
        apiVersion: "v1",
        kind: "Event",
        metadata: {
          // <object>.<hex UnixNano>, like client-go's recorder: names sort in recording order.
          name: `${obj.metadata.name}.${(BigInt(SIM_EPOCH + this.now) * BigInt(1_000_000) + BigInt(this.state.eventSeq++ % 1_000_000)).toString(16)}`,
          namespace: ns,
          uid: this.uid(),
          resourceVersion: "",
          creationTimestamp: this.now,
        },
        involvedObject: {
          kind: obj.kind,
          name: obj.metadata.name,
          namespace: obj.metadata.namespace,
          uid: obj.metadata.uid,
          apiVersion: obj.apiVersion,
          ...(fieldPath ? { fieldPath } : {}),
        },
        reason,
        message,
        type,
        count: 1,
        firstTimestamp: this.now,
        lastTimestamp: this.now,
        source: { component, ...(host ? { host } : {}) },
        reportingComponent: component,
      });
      this.eventIdx.set(dedupe, objKey("Event", ns, ev.metadata.name));
    }
    this.emit({ type: "event", event: ev });
  }

  eventsFor(obj: KubeObject): KubeEvent[] {
    return this.list<KubeEvent>("Event", obj.metadata.namespace ?? "default")
      .filter((e) => e.involvedObject.uid === obj.metadata.uid)
      // Names end in hex nanoseconds, so same-tick events keep their recording order.
      .sort((a, b) => a.firstTimestamp - b.firstTimestamp || (a.metadata.name < b.metadata.name ? -1 : 1));
  }

  // ---------- API (what kubectl talks to) ----------

  get<T extends KubeObject = AnyObject>(kind: string, namespace: string | undefined, name: string): T {
    const o = this.raw(kind, namespace, name);
    if (!o) throw new ApiError(`Error from server (NotFound): ${resourceName(kind)} "${name}" not found`, "NotFound");
    return o as unknown as T;
  }

  private ensureNamespace(kind: string, ns: string | undefined, name = ""): void {
    if (!NAMESPACED_KINDS.has(kind)) return;
    const n = this.raw("Namespace", undefined, ns ?? "default");
    if (!n) throw new ApiError(`Error from server (NotFound): namespaces "${ns}" not found`, "NotFound");
    if (n.status && (n.status as { phase: string }).phase === "Terminating")
      throw new ApiError(
        `Error from server (Forbidden): ${resourceName(kind)} "${name}" is forbidden: unable to create new content in namespace ${ns} because it is being terminated`,
        "Forbidden",
      );
  }

  /** A write from the Learner while the apiserver does not answer fails as kubectl does (ADR 0003, decision 5); controllers' own calls never reach this. */
  private requireApi(): void {
    if (this.inStep) return;
    const refusal = apiServerRefusal(this);
    if (refusal) throw new ApiError(refusal, "Unreachable");
  }

  create<T extends KubeObject>(input: NewObject<T> | T, opts: RequestOptions = {}): T {
    this.requireApi();
    const obj = clone(input) as unknown as AnyObject;
    obj.apiVersion ??= API_VERSIONS[obj.kind];
    obj.metadata = { ...(obj.metadata ?? {}) } as AnyObject["metadata"];
    const meta = obj.metadata as AnyObject["metadata"] & { generateName?: string };
    if (obj.kind === "Pod" && (this.index().get("Pod")?.size ?? 0) >= MAX_PODS) {
      // Like a ResourceQuota denial it comes before name generation (so a controller's error names the
      // generateName prefix); controllers record it as a FailedCreate Event and retry on a later sync.
      throw new ApiError(`Error from server (Forbidden): pods "${meta.name || meta.generateName || ""}" is forbidden: kubesim limits a cluster to ${MAX_PODS} Pods so your browser stays responsive`, "Forbidden");
    }
    if (!meta.name && meta.generateName) meta.name = this.genName(meta.generateName);
    if (NAMESPACED_KINDS.has(obj.kind)) meta.namespace ??= "default";
    else delete meta.namespace;
    // Reject malformed input before admission plugins touch it (they assume the basic shape).
    validate(this, obj, undefined);
    this.ensureNamespace(obj.kind, meta.namespace, meta.name);
    if (this.raw(obj.kind, meta.namespace, meta.name)) {
      throw new ApiError(`Error from server (AlreadyExists): ${resourceName(obj.kind)} "${meta.name}" already exists`, "AlreadyExists");
    }
    if (opts.user) checkEscalation(this, opts.user, obj, undefined);
    meta.uid = this.uid();
    meta.creationTimestamp = this.now;
    delete (meta as { generateName?: string }).generateName;
    // Defaulting and mutating admission, then validation of the result (as the apiserver
    // orders them), then the validating admission plugins (ResourceQuota last).
    admit(this, obj, undefined);
    validate(this, obj, undefined);
    checkQuota(this, obj);
    for (const w of unsupportedWarnings(obj)) this.warn(w);
    const stored = this.put(obj);
    // The default ServiceAccount and kube-root-ca.crt are the controller-manager's work; with it down they appear when it returns.
    if (obj.kind === "Namespace" && (this.inStep || controlPlaneHealth(this).kcm)) ensureNamespaceDefaults(this, meta.name);
    this.flush();
    return stored as unknown as T;
  }

  /** Replaces an existing object's spec/metadata (like PUT). */
  replace<T extends KubeObject>(input: T, opts: RequestOptions = {}): T {
    this.requireApi();
    const prev = this.get(input.kind, input.metadata.namespace, input.metadata.name);
    const obj = clone(input) as unknown as AnyObject;
    obj.apiVersion ??= prev.apiVersion;
    obj.metadata = {
      ...obj.metadata,
      namespace: prev.metadata.namespace,
      uid: prev.metadata.uid,
      creationTimestamp: prev.metadata.creationTimestamp,
      generation: prev.metadata.generation,
      ownerReferences: obj.metadata.ownerReferences ?? prev.metadata.ownerReferences,
      deletionTimestamp: prev.metadata.deletionTimestamp,
      ...(prev.metadata.finalizers && !obj.metadata.finalizers ? { finalizers: prev.metadata.finalizers } : {}),
    };
    if (!NAMESPACED_KINDS.has(obj.kind)) delete obj.metadata.namespace;
    if (prev.status !== undefined || obj.status === undefined) obj.status = prev.status;
    // Defaulting and admission first, then validation sees the object as it would be stored.
    try {
      admit(this, obj, prev);
    } catch (e) {
      // Admission assumes a well-formed object: report malformed input as validation does.
      if (!(e instanceof ApiError)) validate(this, clone(input) as unknown as AnyObject, prev);
      throw e;
    }
    validate(this, obj, prev);
    if (opts.user) checkEscalation(this, opts.user, obj, prev);
    for (const w of unsupportedWarnings(obj)) this.warn(w);
    if (!deepEqual(obj.spec, prev.spec) && prev.metadata.generation !== undefined) {
      obj.metadata.generation = (prev.metadata.generation ?? 1) + 1;
    }
    const stored = this.put(obj);
    this.flush();
    return stored as unknown as T;
  }

  /**
   * kubectl apply (client-side): create, or a three-way merge of the last applied
   * configuration, this manifest and the live object (see apply.ts).
   */
  apply<T extends KubeObject>(input: NewObject<T> | T, opts: RequestOptions = {}): { obj: T; action: "created" | "configured" | "unchanged" } {
    const ns = NAMESPACED_KINDS.has(input.kind) ? (input.metadata?.namespace ?? "default") : undefined;
    const modified = clone(input) as unknown as Record<string, unknown> & { metadata?: Record<string, unknown> };
    delete modified.status;
    const annotated = clone(modified) as unknown as AnyObject;
    annotated.metadata = {
      ...(annotated.metadata ?? {}),
      annotations: { ...((annotated.metadata as AnyObject["metadata"] | undefined)?.annotations ?? {}), [LAST_APPLIED]: JSON.stringify(input) + "\n" },
    } as AnyObject["metadata"];
    const prev = this.raw(input.kind, ns, (input.metadata?.name as string | undefined) ?? "");
    if (!prev) return { obj: this.create(annotated as unknown as T, opts), action: "created" };
    const original = lastApplied(prev);
    if (!original) {
      this.warn(
        `resource ${KINDS[input.kind]?.plural ?? input.kind.toLowerCase() + "s"}/${prev.metadata.name} is missing the ${LAST_APPLIED} annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.`,
      );
    }
    const merged = threeWayMerge(prev, original, annotated as unknown as Record<string, unknown>);
    // Nothing to change after defaulting: kubectl reports "unchanged" and sends nothing.
    const probe = clone(merged);
    let same = false;
    try {
      admit(this, probe, prev);
      const strip = (o: AnyObject) => ({ ...o, status: undefined, metadata: { ...o.metadata, resourceVersion: "", generation: undefined } });
      same = deepEqual(strip(probe), strip(prev));
    } catch {
      same = false;
    }
    if (same) return { obj: prev as unknown as T, action: "unchanged" };
    return { obj: this.replace(merged, opts) as unknown as T, action: "configured" };
  }

  delete(kind: string, namespace: string | undefined, name: string, opts: DeleteOptions = {}): AnyObject {
    this.requireApi();
    const obj = this.get(kind, namespace, name);
    this.deleteObject(obj, opts);
    this.flush();
    return obj;
  }

  /** Objects whose ownerReferences point at this one. */
  dependentsOf(uid: string): AnyObject[] {
    const out: AnyObject[] = [];
    for (const o of Object.values(this.state.objects)) if (o.metadata.ownerReferences?.some((r) => r.uid === uid)) out.push(o);
    return out;
  }

  deleteObject(obj: KubeObject, opts: DeleteOptions = {}): void {
    if (opts.propagationPolicy === "Orphan") {
      const uid = obj.metadata.uid;
      for (const o of this.dependentsOf(uid)) {
        this.update(o, (d) => {
          d.metadata.ownerReferences = d.metadata.ownerReferences!.filter((r) => r.uid !== uid);
          if (d.metadata.ownerReferences.length === 0) delete d.metadata.ownerReferences;
        });
      }
    }
    if (obj.kind === "Pod") {
      const pod = obj as Pod;
      if (isStaticPod(pod)) {
        recreateMirror(this, pod);
        return;
      }
      if (opts.force || opts.gracePeriodSeconds === 0 || !pod.spec?.nodeName) {
        this.remove(pod);
        return;
      }
      if (pod.metadata.deletionTimestamp !== undefined) return;
      const grace = opts.gracePeriodSeconds ?? pod.spec?.terminationGracePeriodSeconds ?? 30;
      this.update(pod, (p) => {
        p.metadata.deletionTimestamp = this.now + grace * 1000;
        p.metadata.deletionGracePeriodSeconds = grace;
      });
      return;
    }
    if (obj.kind === "Namespace") {
      if (["default", "kube-system", "kube-public", "kube-node-lease"].includes(obj.metadata.name)) {
        throw new ApiError(`Error from server (Forbidden): namespaces "${obj.metadata.name}" is forbidden: this namespace may not be deleted`, "Forbidden");
      }
      this.update(obj, (n) => {
        n.metadata.deletionTimestamp = this.now;
        (n.status as { phase: string }) = { phase: "Terminating" };
      });
      return;
    }
    if (obj.kind === "Node") {
      for (const p of this.list<Pod>("Pod")) if (p.spec?.nodeName === obj.metadata.name) this.remove(p);
      delete this.state.nodes[obj.metadata.name];
      // The machine is still there, with its files and services: only the Node object is gone, so a terminal logged in to it keeps working.
    }
    // Foreground: the owner stays (with the foregroundDeletion finalizer) until the garbage
    // collector has deleted every dependent that blocks owner deletion.
    if (opts.propagationPolicy === "Foreground" && obj.metadata.deletionTimestamp === undefined && this.dependentsOf(obj.metadata.uid).length) {
      this.update(obj, (o) => {
        o.metadata.deletionTimestamp = this.now;
        o.metadata.finalizers = [...new Set([...(o.metadata.finalizers ?? []), FOREGROUND])];
      });
      return;
    }
    // Finalizers (pvc-protection, pv-protection…): mark for deletion; the owning controller finishes it.
    if (obj.metadata.finalizers?.length) {
      if (obj.metadata.deletionTimestamp === undefined) this.update(obj, (o) => void (o.metadata.deletionTimestamp = this.now));
      return;
    }
    this.remove(obj);
  }

  // ---------- Pod logs ----------

  log(podUid: string, container: string, restart: number, t: number, text: string): void {
    const key = `${podUid}/${container}/${restart}`;
    if (!this.state.logs[key]) {
      // The runtime keeps the current and the previous container's logs (logs --previous), no older ones.
      for (let r = restart - 2; r >= 0 && this.state.logs[`${podUid}/${container}/${r}`]; r--) delete this.state.logs[`${podUid}/${container}/${r}`];
    }
    const lines = (this.state.logs[key] ??= []);
    lines.push({ t, text });
    // Container runtimes rotate logs; keep the tail so busy Pods don't grow without bound.
    if (lines.length > 1200) lines.splice(0, lines.length - 1000);
  }

  logsFor(pod: Pod, container: string, previous = false): LogLine[] | undefined {
    const status = pod.status?.containerStatuses?.find((s) => s.name === container);
    const restart = (status?.restartCount ?? 0) - (previous ? 1 : 0);
    if (restart < 0) return undefined;
    return this.state.logs[`${pod.metadata.uid}/${container}/${restart}`] ?? [];
  }

  // ---------- helpers for controllers ----------

  nodeReady(node: Node): boolean {
    return node.status?.conditions.find((c) => c.type === "Ready")?.status === "True";
  }

  snapshot(): ClusterState {
    this.state.rng = this.rng.state;
    this.state.trafficRng = this.trafficRng.state;
    return clone(this.state);
  }
}

function eventKey(e: KubeEvent): string {
  return `${e.metadata.namespace ?? "default"}|${e.involvedObject.uid}|${e.reason}|${e.message}`;
}

export function isPodTerminal(p: Pod): boolean {
  return p.status?.phase === "Succeeded" || p.status?.phase === "Failed";
}

export function isPodReady(p: Pod): boolean {
  return p.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";
}

export function controllerOf(o: KubeObject): { kind: string; name: string; uid: string } | undefined {
  return o.metadata.ownerReferences?.find((r) => r.controller);
}

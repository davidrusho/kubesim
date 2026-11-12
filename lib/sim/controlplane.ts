// What the Cluster View says about the control plane and each Node's kubelet (ADR 0003).
//
// Practice mode (`narrate` off) shows only what a candidate would read from `kubectl get pods -n kube-system`
// and `kubectl get nodes`: a Pod's STATUS word, a Node's STATUS. Nothing there names a cause. With narration on,
// each unhealthy component also says what is wrong, from the same engine state the fault comes from.

import { controlPlaneHealth, controlPlaneModelled, componentUp, type Cluster, type Node, type Pod } from "@/lib/engine";
import { MANIFEST_DIR, basename, type Component, type HostState } from "@/lib/engine/host";
import { mirrorPod } from "@/lib/engine/controllers/staticpods";
import { podCategory, podStatus } from "./status";

export type HealthTone = "ok" | "warn" | "bad" | "muted";

export interface Health {
  /** The Pod's or Node's name as kubectl lists it (`kube-scheduler`, `node01`). */
  name: string;
  /** A shorter label for the small chips. */
  short: string;
  /** The STATUS column of `kubectl get pods` / `kubectl get nodes`; empty when kubectl would list no such Pod (narration says `no Pod`). */
  word: string;
  tone: HealthTone;
  /** Narration only: what is wrong. Never set in practice mode. */
  cause?: string;
}

export interface ControlPlaneStatus {
  /** In the order the Cluster View draws them; empty when no control plane is simulated. */
  components: Health[];
  /** By Node name. */
  kubelets: Record<string, Health>;
}

const SHORT: Record<Component, string> = { "kube-apiserver": "kube-apiserver", etcd: "etcd", "kube-scheduler": "scheduler", "kube-controller-manager": "controller-mgr" };
/** Left to right, top to bottom, as the Cluster View has always drawn them. */
export const COMPONENT_ORDER: Component[] = ["kube-apiserver", "etcd", "kube-scheduler", "kube-controller-manager"];

const toneOf = (p: Pod): HealthTone => {
  const c = podCategory(p);
  return c === "ok" ? "ok" : c === "starting" ? "warn" : c === "bad" ? "bad" : "muted";
};

function componentCause(c: Cluster, node: string, host: HostState, comp: Component, pod: Pod | undefined, word: string): string | undefined {
  if (!pod) {
    const path = `${MANIFEST_DIR}/${comp}.yaml`;
    if (!host.files[path]) return `no Pod: ${comp}.yaml is not in ${MANIFEST_DIR}, so the kubelet runs nothing`;
    const bad = Object.entries(host.static).find(([p, e]) => e.bad && basename(p) === `${comp}.yaml`);
    if (bad) return `no Pod: the kubelet cannot parse ${comp}.yaml (${bad[1].bad!.err})`;
    return "no Pod yet: the kubelet has not picked its manifest up";
  }
  if (word === "ErrImagePull" || word === "ImagePullBackOff") return "its image cannot be pulled: check the image tag in the manifest";
  if (word === "CrashLoopBackOff" || word === "Error") return "the container exits right after it starts: a flag, or a file a flag names, is wrong in the manifest";
  if (word === "Running" && !componentUp(c, comp)) return comp === "kube-apiserver" ? "the container runs but cannot serve: check --secure-port and --etcd-servers in its manifest" : "the container runs but is not doing its job";
  return undefined;
}

function kubeletHealth(c: Cluster, node: Node, narrate: boolean): Health {
  const name = node.metadata.name;
  const rt = c.state.nodes[name];
  const svc = c.state.hosts[name]?.services.kubelet;
  const ready = c.nodeReady(node);
  // `kubectl get nodes` prints Ready or NotReady; that is all practice mode shows.
  if (!narrate) return { name, short: "kubelet", word: ready ? "Ready" : "NotReady", tone: ready ? "ok" : "bad" };
  if (rt && !rt.up) return { name, short: "kubelet", word: "powered off", tone: "bad", cause: "the Node has no power, so its kubelet is not running" };
  if (svc?.active === "inactive") return { name, short: "kubelet", word: "stopped", tone: "bad", cause: "the kubelet service is stopped; its containers keep running, but it reports nothing to the control plane" };
  if (svc?.active === "activating" || svc?.active === "failed") return { name, short: "kubelet", word: "restarting", tone: "bad", cause: "the kubelet fails as it starts: its config.yaml or its container runtime endpoint is wrong" };
  if (!ready) return { name, short: "kubelet", word: "NotReady", tone: "warn", cause: "the control plane has not heard from the kubelet for a while" };
  return { name, short: "kubelet", word: "Ready", tone: "ok" };
}

export function controlPlaneStatus(c: Cluster, narrate: boolean): ControlPlaneStatus {
  const nodes = c.list<Node>("Node");
  const kubelets: Record<string, Health> = {};
  for (const n of nodes) kubelets[n.metadata.name] = kubeletHealth(c, n, narrate);
  if (!controlPlaneModelled(c)) return { components: [], kubelets };
  const cp = Object.entries(c.state.hosts).find(([, h]) => h.role === "control-plane");
  if (!cp) return { components: [], kubelets };
  const [node, host] = cp;
  const components = COMPONENT_ORDER.map((comp): Health => {
    const pod = mirrorPod(c, node, comp);
    // kubectl lists nothing for a component with no Pod, so practice mode labels nothing either; narration says so.
    const word = pod ? podStatus(pod) : narrate ? "no Pod" : "";
    const cause = narrate ? componentCause(c, node, host, comp, pod, word) : undefined;
    return { name: comp, short: SHORT[comp], word, tone: pod ? toneOf(pod) : "muted", ...(cause ? { cause } : {}) };
  });
  return { components, kubelets };
}

/**
 * The marking on a Cluster View that is showing the last picture it read, because the apiserver does not answer.
 * Practice mode says that and nothing more; narration says what is not answering.
 */
export function unreachableNote(live: Cluster, narrate: boolean): string | undefined {
  if (controlPlaneHealth(live).api) return undefined;
  if (!narrate) return "Cluster unreachable · showing the last state it read";
  const api = controlPlaneStatus(live, true).components.find((x) => x.name === "kube-apiserver");
  return `kube-apiserver is not answering on 6443${api?.cause ? `: ${api.cause}` : ""} · showing the last state it read`;
}

/** Narration: the first thing wrong in the control plane or a kubelet, for the one-line note over the canvas. */
export function controlPlaneNote(status: ControlPlaneStatus): string | undefined {
  const bad = status.components.find((x) => x.cause);
  if (bad) return `${bad.name}: ${bad.cause}`;
  const k = Object.values(status.kubelets).find((x) => x.cause);
  return k ? `kubelet on ${k.name}: ${k.cause}` : undefined;
}

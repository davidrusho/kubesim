// Node management and Chaos Actions: adding, killing, recovering and removing Nodes.

import type { Cluster } from "./cluster";
import type { Condition, Node, Pod } from "./types";
import { buildHost, nodeIp } from "./host";
import { seedJournal } from "./hostservices";

export { nodeIp };

const KUBE_VERSION = "v1.37.0";

export function kubeletConditions(now: number, ready: boolean): Condition[] {
  const c = (type: string, status: "True" | "False", reason: string, message: string): Condition => ({
    type,
    status,
    lastHeartbeatTime: now,
    lastTransitionTime: now,
    reason,
    message,
  });
  return [
    c("MemoryPressure", "False", "KubeletHasSufficientMemory", "kubelet has sufficient memory available"),
    c("DiskPressure", "False", "KubeletHasNoDiskPressure", "kubelet has no disk pressure"),
    c("PIDPressure", "False", "KubeletHasSufficientPID", "kubelet has sufficient PID available"),
    ready
      ? c("Ready", "True", "KubeletReady", "kubelet is posting ready status")
      : c("Ready", "False", "KubeletNotReady", "container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized"),
  ];
}

export function addNode(cluster: Cluster, name: string, role: "control-plane" | "worker" = "worker"): Node {
  const used = new Set(Object.values(cluster.state.nodes).map((n) => n.index));
  let index = 0;
  while (used.has(index)) index++;
  const labels: Record<string, string> = {
    "beta.kubernetes.io/arch": "amd64",
    "beta.kubernetes.io/os": "linux",
    "kubernetes.io/arch": "amd64",
    "kubernetes.io/hostname": name,
    "kubernetes.io/os": "linux",
  };
  if (role === "control-plane") labels["node-role.kubernetes.io/control-plane"] = "";
  const node = cluster.create<Node>({
    apiVersion: "v1",
    kind: "Node",
    metadata: { name, labels, annotations: { "node.alpha.kubernetes.io/ttl": "0", "volumes.kubernetes.io/controller-managed-attach-detach": "true" } },
    spec: {
      podCIDR: `10.244.${index}.0/24`,
      taints: role === "control-plane" ? [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] : [],
    },
    status: {
      conditions: kubeletConditions(cluster.now, false),
      addresses: [
        { type: "InternalIP", address: nodeIp(index) },
        { type: "Hostname", address: name },
      ],
      capacity: { cpu: "4", "ephemeral-storage": "102626232Ki", memory: "8141592Ki", pods: "110" },
      allocatable: { cpu: "4", "ephemeral-storage": "102626232Ki", memory: "8141592Ki", pods: "110" },
      nodeInfo: {
        architecture: "amd64",
        containerRuntimeVersion: "containerd://2.1.3",
        kernelVersion: "6.8.0-45-generic",
        kubeProxyVersion: "",
        kubeletVersion: KUBE_VERSION,
        operatingSystem: "linux",
        osImage: "Debian GNU/Linux 12 (bookworm)",
      },
    },
  });
  // The kubelet posts Ready ~2s after registering.
  cluster.state.nodes[name] = { up: true, lastHeartbeat: cluster.now, images: [], nextPodIp: 2, index, readyAt: cluster.now + 2000 };
  // The host behind the Node (ADR 0003): its files, services and journal. Manifests exist only where there are system Pods to run.
  cluster.state.hosts[name] = buildHost(cluster, name, role, index, cluster.state.config.systemPods);
  seedJournal(cluster, name);
  cluster.record(node, "Normal", "Starting", "", "kubelet", name);
  cluster.record(node, "Normal", "RegisteredNode", `Node ${name} event: Registered Node ${name} in Controller`, "node-controller");
  return node;
}

/** Chaos Action: the Node loses power. Its kubelet stops heartbeating. */
export function killNode(cluster: Cluster, name: string): void {
  const rt = cluster.state.nodes[name];
  if (!rt || !rt.up) return;
  rt.up = false;
  for (const p of cluster.list<Pod>("Pod")) {
    if (p.spec?.nodeName !== name) continue;
    const prt = cluster.state.pods[p.metadata.uid];
    if (!prt) continue;
    for (const c of Object.values(prt.containers)) c.phase = "dead";
  }
  cluster.markChanged();
  cluster.tick(0);
}

/** Chaos Action: the Node comes back. Deleted Pods are cleaned up; others restart their containers. */
export function recoverNode(cluster: Cluster, name: string): void {
  const rt = cluster.state.nodes[name];
  if (!rt || rt.up) return;
  rt.up = true;
  rt.lastHeartbeat = cluster.now;
  for (const p of cluster.list<Pod>("Pod")) {
    if (p.spec?.nodeName !== name) continue;
    if (p.metadata.deletionTimestamp !== undefined) {
      cluster.remove(p);
      continue;
    }
    const prt = cluster.state.pods[p.metadata.uid];
    if (!prt) continue;
    // A new sandbox runs the init containers again, in order, before the app containers.
    const inits = p.spec?.initContainers ?? [];
    if (inits.length) {
      prt.initialized = false;
      for (const ic of inits) {
        const c = prt.containers[ic.name];
        if (!c || ic.restartPolicy === "Always" || c.phase !== "done") continue;
        c.lastTerm = { exitCode: c.exitCode ?? 0, reason: c.exitReason ?? "Completed", startedAt: c.startedAt, finishedAt: c.until || cluster.now };
        c.restarts++;
        c.phase = "creating";
        c.until = cluster.now + 1000;
        c.program = undefined;
      }
    }
    for (const c of Object.values(prt.containers)) {
      if (c.phase !== "dead") continue;
      c.lastTerm = { exitCode: 255, reason: "Unknown", startedAt: c.startedAt, finishedAt: cluster.now };
      c.restarts++;
      c.phase = "creating";
      c.until = cluster.now + 1000;
      c.program = undefined;
    }
  }
  cluster.markChanged();
  cluster.tick(0);
}

/** Deletes the Node object (like `kubectl delete node`); its Pods are orphaned and removed. */
export function removeNode(cluster: Cluster, name: string): void {
  cluster.delete("Node", undefined, name);
}

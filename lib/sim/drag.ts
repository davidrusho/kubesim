// Drag-and-drop on the Cluster View. Every drop runs through the same Cluster
// API as kubectl and records the equivalent command, so dragging teaches the CLI.

import { ApiError, apiServerRefusal, type Cluster, type Deployment, type Node, type Pod, type Service } from "@/lib/engine";
import * as A from "./actions";
import { BLUEPRINTS } from "./blueprints";
import { RAW_KIND as KIND_OF, canDelete, deleteCommand, deleteNote, type ObjectKind } from "./objects";
import type { SimStore } from "./useSimulation";

export type DragItem =
  | { kind: "palette"; what: "deployment"; image: string; label: string }
  | { kind: "palette"; what: "pod"; image: string; label: string }
  | { kind: "palette"; what: "service" | "node"; label: string }
  | { kind: "blueprint"; id: string; label: string }
  | { kind: "tool"; what: "chaos" | "cordon"; label: string }
  | { kind: "object"; type: ObjectKind; ns: string; name: string; label: string };

/** Drop targets are encoded as strings on SVG elements: data-drop="node:worker-1", "deployment:default/web", … */
export type Target = { type: "canvas" | "trash" } | { type: "node"; name: string } | { type: "deployment" | "service" | "pod"; ns: string; name: string };

export function parseTarget(s: string | null | undefined): Target | null {
  if (!s) return null;
  if (s === "canvas" || s === "trash") return { type: s };
  const [type, rest] = [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)];
  if (type === "node") return { type, name: rest };
  if (type === "deployment" || type === "service" || type === "pod") {
    const [ns, name] = rest.split("/");
    return { type, ns, name };
  }
  return null;
}

/** Which target type an item is dropped on. Used to highlight only valid targets. */
export function canDrop(item: DragItem, t: Target | null): boolean {
  if (!t) return false;
  if (item.kind === "palette") {
    if (item.what === "service") return t.type === "deployment";
    if (item.what === "pod") return t.type === "canvas" || t.type === "node";
    return t.type === "canvas" || t.type === "node" || t.type === "deployment" || t.type === "service" || t.type === "pod";
  }
  if (item.kind === "blueprint") {
    const b = BLUEPRINTS.find((x) => x.id === item.id);
    // A Node is part of the canvas here: what you deploy is placed by the scheduler, not by where it lands.
    return b?.on === "service" ? t.type === "service" : t.type === "canvas" || t.type === "node";
  }
  if (item.kind === "tool") return item.what === "chaos" ? t.type === "node" || t.type === "pod" : t.type === "node";
  if (t.type === "trash") return true;
  if (item.type === "pod") return t.type === "node";
  if (item.type === "service") return t.type === "deployment";
  return false;
}

export interface DropResult {
  ok: boolean;
  /** Plain-English explanation of what Kubernetes did. */
  note: string;
  /** The manifest it applied, saved in the Editor. */
  file?: string;
}

function uniqueName(c: Cluster, kind: string, base: string, ns = "default"): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "app";
  if (!c.raw(kind, ns, clean)) return clean;
  for (let i = 2; ; i++) if (!c.raw(kind, ns, `${clean}-${i}`)) return `${clean}-${i}`;
}

const repoName = (image: string) => image.split("/").pop()!.split(":")[0];

/** A base name nothing in the namespace uses yet, either as itself or as the prefix of what a blueprint derives from it. */
function uniqueBase(c: Cluster, base: string, ns = "default"): string {
  const kinds = ["Deployment", "StatefulSet", "Service", "CronJob", "Ingress", "Secret"];
  const taken = (n: string) => kinds.some((k) => c.list(k, ns).some((o) => o.metadata.name === n || o.metadata.name.startsWith(`${n}-`)));
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

export function performDrop(sim: SimStore, item: DragItem, t: Target): DropResult {
  const c = sim.cluster!;
  const act = (cmd: string, fn: () => string, note: string): DropResult => {
    try {
      const out = fn();
      sim.run(() => ({ cmd, out, ok: true }));
      return { ok: true, note };
    } catch (e) {
      const msg = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      sim.run(() => ({ cmd, out: msg, ok: false }));
      return { ok: false, note: msg };
    }
  };

  if (!canDrop(item, t)) {
    const hint =
      item.kind === "blueprint"
        ? `Drop ${item.label} onto a Service: it needs something to point at.`
        : item.kind === "palette" && item.what === "service"
        ? "Drop a Service onto a Deployment: it will send traffic to that Deployment's Pods."
        : item.kind === "tool" && item.what === "cordon"
          ? "Drop Cordon onto a Node."
          : item.kind === "tool"
            ? "Drop Chaos onto a Node (simulate a failure, or bring it back) or a Pod (kill it). Nothing here is permanent: Start over rebuilds the cluster."
            : item.kind === "object" && item.type === "service"
              ? "Drop a Service onto a Deployment to point it at that Deployment's Pods, or onto the trash to delete it."
              : item.kind === "object" && item.type === "pod"
                ? "Drop a Pod onto another Node, or onto the trash to delete it."
                : "Drop it on the trash to delete it.";
    return { ok: false, note: hint };
  }

  // The apiserver does not answer: a drop that would write through the API fails as kubectl does, and nothing changes (ADR 0003, decision 5).
  // Chaos on a Node is the exception: it is power, not an API call.
  const refusal = apiServerRefusal(c);
  if (refusal && !(item.kind === "tool" && item.what === "chaos" && t.type === "node")) return { ok: false, note: refusal };

  // ---- blueprints: apply a manifest, saved in the Editor
  if (item.kind === "blueprint") {
    const b = BLUEPRINTS.find((x) => x.id === item.id)!;
    const target = t.type === "service" ? t.name : undefined;
    const name = uniqueBase(c, b.base);
    const r = sim.apply(b.yaml(name, target), `${name}.yaml`);
    if (!r) return { ok: false, note: "The cluster isn't running." };
    return { ok: r.ok, note: r.ok ? b.note(name, target) : r.out, file: `${name}.yaml` };
  }

  // ---- palette: create things
  if (item.kind === "palette") {
    if (item.what === "deployment") {
      const name = uniqueName(c, "Deployment", repoName(item.image));
      const r = A.createDeployment(c, name, item.image, 3);
      sim.run(() => r);
      const extra = t.type === "node" ? " You dropped it on a Node, but Deployments aren't placed by hand: the scheduler spreads its Pods across Nodes." : "";
      return { ok: r.ok, note: r.ok ? `Created Deployment ${name}. It made a ReplicaSet, which made 3 Pods; watch them get scheduled and start.${extra}` : r.out };
    }
    if (item.what === "pod") {
      const name = uniqueName(c, "Pod", repoName(item.image));
      const onNode = t.type === "node" ? t.name : undefined;
      return act(
        onNode ? `kubectl run ${name} --image=${item.image} --overrides='{"spec":{"nodeSelector":{"kubernetes.io/hostname":"${onNode}"}}}'` : `kubectl run ${name} --image=${item.image}`,
        () => {
          c.create({ apiVersion: "v1", kind: "Pod", metadata: { name, namespace: "default", labels: { run: name } }, spec: { ...(onNode ? { nodeSelector: { "kubernetes.io/hostname": onNode } } : {}), containers: [{ name, image: item.image }] } });
          return `pod/${name} created`;
        },
        onNode
          ? `Created Pod ${name} with nodeSelector kubernetes.io/hostname=${onNode}, so the scheduler may only place it there. (A bare Pod: if it dies, nothing replaces it.)`
          : `Created a bare Pod ${name}. The scheduler picks a Node. Nothing will replace it if it's deleted; that's what Deployments are for.`,
      );
    }
    if (item.what === "node") {
      const r = A.joinNode(c);
      sim.run(() => r);
      return { ok: r.ok, note: r.ok ? "A new worker Node joined. It's NotReady for a moment until its kubelet reports in; new Pods can then land on it." : r.out };
    }
    // service → deployment
    if (t.type !== "deployment") return { ok: false, note: "Drop a Service onto a Deployment." };
    const svcName = c.raw("Service", t.ns, t.name) ? uniqueName(c, "Service", `${t.name}-svc`, t.ns) : t.name;
    const d = c.get<Deployment>("Deployment", t.ns, t.name);
    const image = d.spec!.template.spec.containers[0].image;
    const target = image.includes("http-echo") ? 5678 : image.startsWith("redis") ? 6379 : 80;
    return act(
      `kubectl expose deployment ${t.name} --port=80${target !== 80 ? ` --target-port=${target}` : ""}${svcName !== t.name ? ` --name=${svcName}` : ""}${t.ns !== "default" ? ` -n ${t.ns}` : ""}`,
      () => {
        c.create<Service>({ apiVersion: "v1", kind: "Service", metadata: { name: svcName, namespace: t.ns, labels: d.metadata.labels }, spec: { selector: d.spec!.selector.matchLabels, ports: [{ port: 80, targetPort: target }] } });
        return `service/${svcName} exposed`;
      },
      `Service ${svcName} now load-balances across every ready Pod labelled ${Object.entries(d.spec!.selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",")}. Try curl http://${svcName}.`,
    );
  }

  // ---- tools
  if (item.kind === "tool") {
    if (item.what === "cordon" && t.type === "node") {
      const n = c.get<Node>("Node", undefined, t.name);
      const on = !n.spec?.unschedulable;
      const r = A.cordon(c, t.name, on);
      sim.run(() => r);
      return { ok: r.ok, note: on ? `${t.name} is cordoned: Pods already there keep running, but no new Pods will be scheduled on it.` : `${t.name} is schedulable again.` };
    }
    if (item.what === "chaos" && t.type === "node") {
      const up = c.state.nodes[t.name]?.up;
      const r = up ? A.chaosKill(c, t.name) : A.chaosRecover(c, t.name);
      sim.run(() => r);
      return { ok: r.ok, note: up ? `${t.name} has failed (simulated power loss). Kubernetes won't notice for ~50s (no heartbeats), then waits 5 min before evicting its Pods (removing them so they're replaced on healthy Nodes). Speed up time to watch, or drop Chaos on it again to bring it back.` : `${t.name} is back on. Its kubelet reports in and cleans up evicted Pods.` };
    }
    if (item.what === "chaos" && t.type === "pod") {
      const p = c.get<Pod>("Pod", t.ns, t.name);
      const owned = !!p.metadata.ownerReferences?.length;
      return act(
        `kubectl delete pod ${t.name}${t.ns !== "default" ? ` -n ${t.ns}` : ""}`,
        () => {
          c.delete("Pod", t.ns, t.name);
          return `pod "${t.name}" deleted from ${t.ns} namespace`;
        },
        owned ? "Pod killed. Its ReplicaSet notices it has one too few and creates a replacement: self-healing." : "Pod killed. It was a bare Pod, so nothing brings it back.",
      );
    }
  }

  // ---- existing objects
  if (item.kind === "object") {
    const nsFlag = item.ns !== "default" ? ` -n ${item.ns}` : "";
    if (t.type === "trash" && item.type !== "pod" && item.type !== "deployment" && item.type !== "service") {
      if (!c.raw(KIND_OF[item.type], item.type === "node" ? undefined : item.ns, item.name)) return { ok: false, note: `${item.label} is already gone.` };
      if (!canDelete(c, item.type, item.ns, item.name)) return { ok: false, note: "The control plane runs the cluster's own components, so it stays. Delete a worker Node instead." };
      const note = deleteNote(c, item.type, item.ns, item.name);
      const r = sim.exec(deleteCommand(item.type, item.ns, item.name));
      return r?.ok ? { ok: true, note: `Deleted. ${note}` } : { ok: false, note: r?.out ?? "The cluster isn't running." };
    }
    if (t.type === "trash") {
      const kind = item.type === "pod" ? "Pod" : item.type === "deployment" ? "Deployment" : "Service";
      const noun = item.type === "deployment" ? "deployment.apps" : item.type;
      const owned = item.type === "pod" && !!c.raw("Pod", item.ns, item.name)?.metadata.ownerReferences?.length;
      return act(
        `kubectl delete ${item.type} ${item.name}${nsFlag}`,
        () => {
          c.delete(kind, item.ns, item.name);
          return `${noun} "${item.name}" deleted from ${item.ns} namespace`;
        },
        item.type === "deployment"
          ? "Deleted. The garbage collector removes its ReplicaSets, then their Pods shut down gracefully."
          : item.type === "service"
            ? "Deleted. The Pods keep running; they just lose their stable address."
            : owned
              ? "Deleted, but its ReplicaSet immediately makes a replacement. To really remove Pods, scale or delete the Deployment."
              : "Deleted for good: a bare Pod has no controller to bring it back.",
      );
    }
    if (item.type === "pod" && t.type === "node") {
      const p = c.get<Pod>("Pod", item.ns, item.name);
      if (p.spec?.nodeName === t.name) return { ok: false, note: `${item.name} is already on ${t.name}.` };
      if (p.metadata.ownerReferences?.length) {
        return act(
          `kubectl delete pod ${item.name}${nsFlag}`,
          () => {
            c.delete("Pod", item.ns, item.name);
            return `pod "${item.name}" deleted from ${item.ns} namespace`;
          },
          `Pods can't move between Nodes. Kubernetes deleted it; its ReplicaSet made a new one, and the scheduler (not you) picks the Node, so it may not land on ${t.name}. To choose a Node, set nodeSelector in the Pod template.`,
        );
      }
      const spec = structuredClone(p.spec!);
      delete spec.nodeName;
      spec.nodeSelector = { ...(spec.nodeSelector ?? {}), "kubernetes.io/hostname": t.name };
      return act(
        `kubectl delete pod ${item.name} --force${nsFlag} && kubectl apply -f ${item.name}.yaml   # with nodeSelector ${t.name}`,
        () => {
          c.delete("Pod", item.ns, item.name, { force: true });
          c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: item.name, namespace: item.ns, labels: p.metadata.labels }, spec });
          return `pod "${item.name}" force deleted\npod/${item.name} created`;
        },
        `A running Pod can't be moved, so it was deleted and re-created with nodeSelector kubernetes.io/hostname=${t.name}. It starts from scratch on the new Node.`,
      );
    }
    if (item.type === "service" && t.type === "deployment") {
      const d = c.get<Deployment>("Deployment", t.ns, t.name);
      const sel = d.spec!.selector.matchLabels ?? {};
      const selStr = Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(",");
      return act(
        `kubectl set selector service ${item.name} ${selStr}${nsFlag}`,
        () => {
          const s = c.get<Service>("Service", item.ns, item.name);
          c.replace({ ...s, spec: { ...s.spec, selector: sel } });
          return `service/${item.name} selector updated`;
        },
        `Service ${item.name} now selects ${selStr}, so its Endpoints switch to ${t.name}'s Pods. Same address, different backends.`,
      );
    }
  }
  return { ok: false, note: "Nothing to do there." };
}

import { expect, test } from "bun:test";
import { Cluster, EXAM_NODES, type Pod, type Service } from "@/lib/engine";
import { hostWrite } from "@/lib/engine/host";
import { BLUEPRINTS } from "./blueprints";
import { canDrop, parseTarget, performDrop } from "./drag";
import { SimStore } from "./useSimulation";

function store() {
  const s = new SimStore();
  s.cluster = new Cluster({ systemPods: false });
  return s;
}

test("targets parse and validate", () => {
  expect(parseTarget("node:worker-1")).toEqual({ type: "node", name: "worker-1" });
  expect(parseTarget("deployment:default/web")).toEqual({ type: "deployment", ns: "default", name: "web" });
  expect(canDrop({ kind: "palette", what: "service", label: "" }, parseTarget("canvas"))).toBe(false);
  expect(canDrop({ kind: "palette", what: "service", label: "" }, parseTarget("deployment:default/web"))).toBe(true);
  expect(canDrop({ kind: "object", type: "pod", ns: "default", name: "x", label: "" }, parseTarget("trash"))).toBe(true);
});

test("drag to build: deployment, service, pinned pod, delete", () => {
  const s = store();
  const c = s.cluster!;
  expect(performDrop(s, { kind: "palette", what: "deployment", image: "nginxdemos/hello:plain-text", label: "" }, { type: "canvas" }).ok).toBe(true);
  expect(c.raw("Deployment", "default", "hello")).toBeTruthy();
  expect(s.term.at(-1)?.cmd).toBe("kubectl create deployment hello --image=nginxdemos/hello:plain-text --replicas=3");
  // a second one gets a unique name
  performDrop(s, { kind: "palette", what: "deployment", image: "nginxdemos/hello:plain-text", label: "" }, { type: "canvas" });
  expect(c.raw("Deployment", "default", "hello-2")).toBeTruthy();
  expect(performDrop(s, { kind: "palette", what: "service", label: "" }, { type: "deployment", ns: "default", name: "hello" }).ok).toBe(true);
  expect(c.get<Service>("Service", "default", "hello").spec?.selector).toEqual({ app: "hello" });
  performDrop(s, { kind: "palette", what: "pod", image: "nginx", label: "" }, { type: "node", name: "worker-2" });
  c.advance(5000);
  expect(c.get<Pod>("Pod", "default", "nginx").spec?.nodeName).toBe("worker-2");
  // re-point the service at the other deployment
  performDrop(s, { kind: "object", type: "service", ns: "default", name: "hello", label: "" }, { type: "deployment", ns: "default", name: "hello-2" });
  expect(c.get<Service>("Service", "default", "hello").spec?.selector).toEqual({ app: "hello-2" });
  // bare pod moved to another node is re-created pinned there
  performDrop(s, { kind: "object", type: "pod", ns: "default", name: "nginx", label: "" }, { type: "node", name: "worker-1" });
  c.advance(3000);
  expect(c.get<Pod>("Pod", "default", "nginx").spec?.nodeName).toBe("worker-1");
  expect(performDrop(s, { kind: "object", type: "deployment", ns: "default", name: "hello-2", label: "" }, { type: "trash" }).ok).toBe(true);
  expect(c.raw("Deployment", "default", "hello-2")).toBeUndefined();
  // invalid drops explain themselves
  const bad = performDrop(s, { kind: "palette", what: "service", label: "" }, { type: "canvas" });
  expect(bad.ok).toBe(false);
  expect(bad.note).toContain("Deployment");
});

test("blueprints: every one applies cleanly and its Pods come up", () => {
  for (const b of BLUEPRINTS) {
    const s = new SimStore();
    s.cluster = new Cluster();
    const c = s.cluster;
    if (b.on === "service") s.apply(BLUEPRINTS.find((x) => x.id === "web")!.yaml("web"), "web.yaml");
    const r = performDrop(s, { kind: "blueprint", id: b.id, label: b.label }, b.on === "service" ? { type: "service", ns: "default", name: "web" } : { type: "canvas" });
    expect(r.ok).toBe(true);
    expect(s.term.at(-1)?.cmd).toBe(`kubectl apply -f ${b.base}.yaml`);
    // The manifest is saved as a file the Learner can open, change and apply again.
    expect(s.files[`${b.base}.yaml`]).toContain(b.base);
    c.advance(90_000);
    const pods = c.list<Pod>("Pod", "default");
    expect(pods.length).toBeGreaterThan(0);
    for (const p of pods) expect([p.metadata.name, p.status?.phase === "Succeeded" || p.status?.conditions?.some((q) => q.type === "Ready" && q.status === "True")]).toEqual([p.metadata.name, true]);
  }
});

test("blueprints: unique names, and the ones that need a Service say so", () => {
  const s = store();
  const c = s.cluster!;
  performDrop(s, { kind: "blueprint", id: "postgres", label: "PostgreSQL" }, { type: "canvas" });
  performDrop(s, { kind: "blueprint", id: "postgres", label: "PostgreSQL" }, { type: "node", name: "worker-1" });
  expect(c.raw("StatefulSet", "default", "postgres")).toBeTruthy();
  expect(c.raw("StatefulSet", "default", "postgres-2")).toBeTruthy();
  // The full stack derives names from its base, so it avoids anything already using that prefix.
  performDrop(s, { kind: "blueprint", id: "stack", label: "Full-stack app" }, { type: "canvas" });
  performDrop(s, { kind: "blueprint", id: "stack", label: "Full-stack app" }, { type: "canvas" });
  expect(c.raw("Deployment", "default", "shop-api")).toBeTruthy();
  expect(c.raw("Deployment", "default", "shop-2-api")).toBeTruthy();
  const bad = performDrop(s, { kind: "blueprint", id: "load", label: "Load generator" }, { type: "canvas" });
  expect(bad.ok).toBe(false);
  expect(bad.note).toContain("Service");
  expect(canDrop({ kind: "blueprint", id: "load", label: "" }, parseTarget("service:default/web"))).toBe(true);
  expect(canDrop({ kind: "blueprint", id: "redis", label: "" }, parseTarget("service:default/web"))).toBe(false);
});

test("anything on the canvas can go in the trash: a worker Node takes its Pods with it, and they come back elsewhere", () => {
  const s = store();
  const c = s.cluster!;
  s.exec("kubectl create deployment web --image=nginx --replicas=4");
  c.advance(30_000);
  const on1 = () => c.list<Pod>("Pod", "default").filter((p) => p.spec?.nodeName === "worker-1").length;
  expect(on1()).toBeGreaterThan(0);
  const r = performDrop(s, { kind: "object", type: "node", ns: "default", name: "worker-1", label: "Node worker-1" }, { type: "trash" });
  expect(r.ok).toBe(true);
  expect(r.note).toMatch(/Controllers recreate/);
  expect(s.term.at(-1)?.cmd).toBe("kubectl delete node worker-1");
  c.advance(60_000);
  expect(c.raw("Node", undefined, "worker-1")).toBeUndefined();
  const running = c.list<Pod>("Pod", "default").filter((p) => p.status?.phase === "Running");
  expect(running).toHaveLength(4);
  expect(running.every((p) => p.spec?.nodeName === "worker-2")).toBe(true);
  // A ConfigMap, through kubectl too.
  s.exec("kubectl create configmap app --from-literal=a=b");
  expect(performDrop(s, { kind: "object", type: "configmap", ns: "default", name: "app", label: "ConfigMap app" }, { type: "trash" }).ok).toBe(true);
  expect(c.raw("ConfigMap", "default", "app")).toBeUndefined();
});

test("the control plane's Node can't be trashed from the canvas", () => {
  const s = store();
  const r = performDrop(s, { kind: "object", type: "node", ns: "default", name: "control-plane", label: "Node control-plane" }, { type: "trash" });
  expect(r.ok).toBe(false);
  expect(s.cluster!.raw("Node", undefined, "control-plane")).toBeDefined();
});

test("with the apiserver down a drop that would write through the API is refused with kubectl's message and changes nothing; chaos on a Node is power, not an API call", () => {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 4, systemPods: true, nodes: EXAM_NODES });
  const c = s.cluster;
  c.advance(20_000);
  const h = c.state.hosts.controlplane;
  const path = "/etc/kubernetes/manifests/kube-apiserver.yaml";
  hostWrite(h, path, h.files[path].content.replace("--secure-port=6443", "--secure-port=6444"), c.now);
  c.advance(30_000);
  const refused = "The connection to the server controlplane:6443 was refused - did you specify the right host or port?";
  const before = c.list("Deployment").length;
  expect(performDrop(s, { kind: "palette", what: "deployment", image: "nginx:1.27", label: "" }, { type: "canvas" })).toEqual({ ok: false, note: refused });
  expect(performDrop(s, { kind: "palette", what: "pod", image: "nginx:1.27", label: "" }, { type: "canvas" })).toEqual({ ok: false, note: refused });
  expect(performDrop(s, { kind: "tool", what: "cordon", label: "" }, { type: "node", name: "node01" })).toEqual({ ok: false, note: refused });
  expect(performDrop(s, { kind: "object", type: "pod", ns: "kube-system", name: "etcd-controlplane", label: "" }, { type: "trash" })).toEqual({ ok: false, note: refused });
  expect(c.list("Deployment").length).toBe(before);
  expect(c.raw("Pod", "default", "nginx")).toBeUndefined();
  expect((c.raw("Node", undefined, "node01") as { spec?: { unschedulable?: boolean } }).spec?.unschedulable).toBeFalsy();
  expect(c.raw("Pod", "kube-system", "etcd-controlplane")).toBeDefined();
  // The Editor's Apply button goes through the same refusal.
  expect(s.apply("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm1\n", "cm1.yaml")).toEqual({ out: refused, ok: false });
  expect(c.raw("ConfigMap", "default", "cm1")).toBeUndefined();
  // Power is not the API.
  expect(performDrop(s, { kind: "tool", what: "chaos", label: "" }, { type: "node", name: "node01" }).note).toContain("simulated power loss");
  expect(c.state.nodes.node01.up).toBe(false);
});

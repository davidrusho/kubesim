// Each control-plane component gates what it owns, and the apiserver is one choke point (ADR 0003, decisions 4 and 5).
// Every expectation cites the scenario of docs/research/real-cluster-captures-control-plane.md it reproduces.

import { describe, expect, test } from "bun:test";
import { Cluster, EXAM_NODES, killNode, recoverNode, type Deployment, type Pod } from "@/lib/engine";
import { MANIFEST_DIR, hostWrite } from "@/lib/engine/host";
import { controlPlaneHealth } from "@/lib/engine/controllers/staticpods";
import { applyYaml, runKubectl } from "@/lib/kubectl/kubectl";
import { newShell } from "@/lib/kubectl/shell";

const SCHEDULER = `${MANIFEST_DIR}/kube-scheduler.yaml`;
const APISERVER = `${MANIFEST_DIR}/kube-apiserver.yaml`;
const KCM = `${MANIFEST_DIR}/kube-controller-manager.yaml`;
const REFUSED = "The connection to the server controlplane:6443 was refused - did you specify the right host or port?";

function lab() {
  const c = new Cluster({ seed: 7, systemPods: true, nodes: EXAM_NODES });
  const ctx = { cluster: c, namespace: "default", files: {} as Record<string, string>, shell: newShell() };
  const run = (line: string) => runKubectl(ctx, line);
  const kubectl = (line: string) => run(line).out;
  /** A root terminal on a Node, as after `sudo -i`. */
  const root = (node: string) => {
    const shell = newShell();
    shell.sessions.push({ node, user: "root", via: "sudo" });
    const rctx = { cluster: c, namespace: "default", files: {} as Record<string, string>, shell };
    return (line: string) => runKubectl(rctx, line);
  };
  const edit = (path: string, fn: (text: string) => string) => {
    const h = c.state.hosts.controlplane;
    hostWrite(h, path, fn(h.files[path].content), c.now);
  };
  const wait = (seconds: number) => c.advance(seconds * 1000);
  /** Seconds (to the second) until `done` holds, or -1 after `limit`. */
  const until = (done: () => boolean, limit: number) => {
    for (let t = 0; t <= limit; t++) {
      if (done()) return t;
      wait(1);
    }
    return -1;
  };
  const podsOf = (name: string) => c.list<Pod>("Pod", "default").filter((p) => p.metadata.name.startsWith(name));
  const mirror = (comp: string) => kubectl(`kubectl get pods -n kube-system -l component=${comp} --no-headers`).replace(/\s+/g, " ");
  return { c, ctx, run, kubectl, root, edit, wait, until, podsOf, mirror };
}

describe("controller-manager down (capture Scenario 5)", () => {
  test("a scale is accepted but no ReplicaSet or Pod follows; the Pod that ran keeps running; a deleted Pod is not replaced", () => {
    const { kubectl, run, root, wait, podsOf, mirror } = lab();
    run("kubectl create deployment cm-test --image=nginx:1.27 --replicas=1");
    wait(15);
    expect(podsOf("cm-test").length).toBe(1);
    const rsBefore = kubectl("kubectl get rs --no-headers -o name"); // names only: AGE moves on its own
    expect(mirror("kube-controller-manager")).toContain("1/1 Running");
    // Scenario 5: the manifest is moved out of /etc/kubernetes/manifests.
    expect(root("controlplane")(`mv ${KCM} /root/kcm.yaml`).ok).toBe(true);
    wait(8);
    expect(mirror("kube-controller-manager")).toContain("No resources found");
    expect(kubectl("kubectl scale deploy cm-test --replicas=3")).toBe("deployment.apps/cm-test scaled"); // captured: accepted
    wait(40);
    expect(kubectl("kubectl get deploy cm-test --no-headers").replace(/\s+/g, " ")).toStartWith("cm-test 1/3 1 1 "); // captured: 1/3, UP-TO-DATE 1
    expect(kubectl("kubectl get rs --no-headers -o name")).toBe(rsBefore); // captured: no new ReplicaSet
    expect(kubectl("kubectl get rs --no-headers").replace(/\s+/g, " ")).toMatch(/^cm-test-\w+ 1 1 1 /); // and its DESIRED is untouched
    expect(podsOf("cm-test").length).toBe(1);
    expect(podsOf("cm-test")[0].status?.phase).toBe("Running");
    run("kubectl delete pod -l app=cm-test --wait=false");
    wait(40);
    expect(kubectl("kubectl get pods --no-headers")).toBe("No resources found in default namespace."); // captured: nothing replaces it
  });

  test("the new Pods come ~21 s after the manifest is back (capture Scenario 5: 21 s)", () => {
    const { c, kubectl, run, root, wait, until, podsOf } = lab();
    const cp = root("controlplane");
    run("kubectl create deployment cm-test --image=nginx:1.27 --replicas=1");
    wait(15);
    cp(`mv ${KCM} /root/kcm.yaml`);
    wait(8);
    run("kubectl scale deploy cm-test --replicas=3");
    wait(10);
    expect(podsOf("cm-test").length).toBe(1);
    cp(`mv /root/kcm.yaml ${KCM}`);
    const t0 = c.now;
    const created = until(() => podsOf("cm-test").length === 3, 40);
    expect(created).toBeGreaterThanOrEqual(15);
    expect(created).toBeLessThanOrEqual(25);
    expect((c.now - t0) / 1000).toBe(created);
    expect(until(() => kubectl("kubectl get deploy cm-test --no-headers").includes(" 3/3 "), 20)).toBeGreaterThanOrEqual(0);
  });

  test("only what kube-controller-manager owns stops: the scheduler still binds a bare Pod, and the node-lifecycle controller marks nothing", () => {
    const { kubectl, run, root, wait } = lab();
    const cp = root("controlplane");
    wait(5);
    cp(`mv ${KCM} /root/kcm.yaml`);
    wait(8);
    expect(run("kubectl run bare --image=nginx:1.27").ok).toBe(true);
    wait(15);
    expect(kubectl("kubectl get pod bare --no-headers")).toContain("Running"); // the scheduler is not the controller-manager
    // The kubelet on node01 stops, but the controller-manager that would mark the Node NotReady is down too.
    root("node01")("systemctl stop kubelet");
    wait(120);
    expect(kubectl("kubectl get node node01 --no-headers").replace(/\s+/g, " ")).toStartWith("node01 Ready ");
    cp(`mv /root/kcm.yaml ${KCM}`);
    wait(40);
    expect(kubectl("kubectl get node node01 --no-headers").replace(/\s+/g, " ")).toStartWith("node01 NotReady ");
  });
});

describe("scheduler down (capture 3a)", () => {
  test("a new Pod stays Pending with no events; Pods already running are untouched; ~6 s after the mirror Pod is back it is Running", () => {
    const { c, kubectl, run, edit, wait, until, mirror } = lab();
    wait(5);
    const good = c.state.hosts.controlplane.files[SCHEDULER].content;
    edit(SCHEDULER, (t) => t.replace("\n  containers:", "\n  containers")); // a YAML syntax error
    wait(12);
    run("kubectl run test3a --image=nginx:1.27");
    wait(16);
    expect(kubectl("kubectl get pod test3a --no-headers").replace(/\s+/g, " ")).toStartWith("test3a 0/1 Pending 0 ");
    expect(kubectl("kubectl describe pod test3a")).toMatch(/\nNode:\s+<none>\n/);
    expect(kubectl("kubectl describe pod test3a")).toMatch(/Events:\s+<none>\s*$/); // captured: Events: <none>
    expect(kubectl("kubectl get events --field-selector involvedObject.name=test3a")).toBe("No resources found in default namespace.");
    expect(kubectl("kubectl get pods -n kube-system --no-headers")).toContain("kube-apiserver-controlplane"); // the rest of the control plane is fine
    edit(SCHEDULER, () => good);
    const back = until(() => mirror("kube-scheduler") !== "No resources found in kube-system namespace.", 8);
    expect(back).toBeGreaterThanOrEqual(0);
    const running = until(() => kubectl("kubectl get pod test3a --no-headers").includes(" Running "), 20);
    expect(running).toBeGreaterThanOrEqual(3);
    expect(running).toBeLessThanOrEqual(9); // captured: Running by t+6 s
  });
});

describe("apiserver down (capture 4a, 4b)", () => {
  test("a wrong --secure-port: kubectl is refused on 6443 with the in-node message while the container keeps Running; config and help still work (capture 4b)", () => {
    const { c, run, edit, wait } = lab();
    wait(5);
    edit(APISERVER, (t) => t.replace("--secure-port=6443", "--secure-port=6444"));
    wait(30);
    const refused = run("kubectl get nodes");
    expect(refused).toEqual({ out: REFUSED, ok: false });
    expect(c.get<Pod>("Pod", "kube-system", "kube-apiserver-controlplane").status?.containerStatuses?.[0].restartCount).toBe(0); // still the first container
    expect(c.get<Pod>("Pod", "kube-system", "kube-apiserver-controlplane").status?.phase).toBe("Running");
    for (const line of ["kubectl get pods -A", "kubectl apply -f x.yaml", "kubectl cluster-info", "kubectl version", "kubectl explain pod", "k get nodes"]) expect(run(line)).toEqual({ out: REFUSED, ok: false });
    expect(run("kubectl config view").ok).toBe(true);
    expect(run("kubectl config current-context").ok).toBe(true);
    expect(run("kubectl --help").out).toContain("kubectl controls the simulated Kubernetes cluster.");
    expect(run("kubectl version --client").out).toContain("Client Version");
    expect(run("kubectl get --help").ok).toBe(true);
    expect(run("kubectl nosuchverb").out).toContain('unknown command "nosuchverb"'); // a typo is still a typo
  });

  test("a wrong --etcd-servers port: refused within the first scan, long before the container gives up (capture 4a: kubectl fails within seconds, exits after ~20 s)", () => {
    const { c, run, edit, wait, until, root } = lab();
    wait(5);
    edit(APISERVER, (t) => t.replace("https://127.0.0.1:2379", "https://127.0.0.1:2399"));
    expect(until(() => run("kubectl get nodes").out === REFUSED, 8)).toBeGreaterThanOrEqual(0);
    // The container starts again from the changed manifest and retries etcd for ~20 s before it exits: refused the whole time.
    expect(until(() => root("controlplane")("crictl ps").out.includes("kube-apiserver"), 30)).toBeGreaterThan(0);
    expect(c.get<Pod>("Pod", "kube-system", "kube-apiserver-controlplane").status?.phase).toBe("Running");
    expect(run("kubectl get nodes").out).toBe(REFUSED);
  });

  test("recovery after the fix: kubectl works again 10 to 25 s later (capture: 4a ~22 s, 4b ~15 s)", () => {
    for (const [bad, good] of [
      ["https://127.0.0.1:2379", "https://127.0.0.1:2399"],
      ["--secure-port=6443", "--secure-port=6444"],
    ]) {
      const { c, run, edit, wait, until } = lab();
      wait(5);
      edit(APISERVER, (t) => t.replace(bad, good));
      wait(40);
      expect(run("kubectl get nodes").out).toBe(REFUSED);
      edit(APISERVER, (t) => t.replace(good, bad));
      const t0 = c.now;
      const back = until(() => run("kubectl get nodes").ok, 40);
      expect(back).toBeGreaterThanOrEqual(10);
      expect(back).toBeLessThanOrEqual(25);
      expect((c.now - t0) / 1000).toBe(back);
    }
  });

  test("nothing reconciles while it is down; the kubelet keeps restarting a crashing container; the controllers catch up afterwards", () => {
    const { c, run, edit, wait, until, podsOf } = lab();
    run("kubectl create deployment web --image=nginx:1.27 --replicas=1");
    run(`kubectl run boom --image=busybox:1.36 --restart=Always -- sh -c "echo boom; exit 1"`);
    wait(20);
    const good = c.state.hosts.controlplane.files[APISERVER].content;
    edit(APISERVER, (t) => t.replace("--secure-port=6443", "--secure-port=6444"));
    wait(10);
    const restartsThen = c.get<Pod>("Pod", "default", "boom").status?.containerStatuses?.[0].restartCount ?? 0;
    // A change that landed before the outage but whose consequences have not: the Deployment now wants 3 Pods.
    const d = c.get<Deployment>("Deployment", "default", "web");
    c.update(d, (x) => void (x.spec!.replicas = 3));
    wait(60);
    expect(podsOf("web").length).toBe(1); // no ReplicaSet controller ran
    expect(c.get<Pod>("Pod", "default", "boom").status?.containerStatuses?.[0].restartCount ?? 0).toBeGreaterThan(restartsThen); // the kubelet did
    expect(podsOf("web")[0].status?.phase).toBe("Running"); // and the container that ran stays up
    edit(APISERVER, () => good);
    expect(until(() => podsOf("web").length === 3, 60)).toBeGreaterThan(0);
    expect(run("kubectl get pods").ok).toBe(true);
  });

  test("a write from the Editor or the Cluster View's own code is refused the same way, and changes nothing", () => {
    const { c, ctx, edit, wait } = lab();
    wait(5);
    edit(APISERVER, (t) => t.replace("--secure-port=6443", "--secure-port=6444"));
    wait(20);
    const yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm1\ndata:\n  a: b\n";
    expect(applyYaml(ctx, yaml)).toEqual({ out: REFUSED, ok: false });
    expect(c.raw("ConfigMap", "default", "cm1")).toBeUndefined();
    expect(applyYaml(ctx, "metadata:\n  name: x\n")).toEqual({ out: REFUSED, ok: false }); // kubectl validates against the server's schema first, so even a document with no kind is refused, not diagnosed
    expect(() => c.create({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cm2" } })).toThrow(REFUSED);
    expect(() => c.replace(c.get<Pod>("Pod", "kube-system", "etcd-controlplane"))).toThrow(REFUSED);
    expect(() => c.delete("Pod", "kube-system", "etcd-controlplane")).toThrow(REFUSED);
    expect(c.raw("Pod", "kube-system", "etcd-controlplane")).toBeDefined();
  });

  test("the control-plane Node losing power takes the apiserver with it, and bringing it back restores kubectl (Chaos Action)", () => {
    const { c, run, wait, until } = lab();
    wait(5);
    killNode(c, "controlplane");
    wait(5);
    expect(run("kubectl get nodes").out).toBe(REFUSED);
    recoverNode(c, "controlplane");
    const back = until(() => run("kubectl get nodes").ok, 60);
    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThanOrEqual(30);
    expect(run("kubectl get pods -n kube-system --no-headers").out).toContain("kube-apiserver-controlplane");
  });

  test("controlPlaneHealth: the three flags, each from its own component", () => {
    const { c, edit, wait } = lab();
    wait(30);
    expect(controlPlaneHealth(c)).toEqual({ api: true, kcm: true, scheduler: true });
    edit(SCHEDULER, (t) => t.replace("--kubeconfig=/etc/kubernetes/scheduler.conf", "--kubeconfig=/etc/kubernetes/schedulr.conf"));
    wait(30);
    expect(controlPlaneHealth(c)).toEqual({ api: true, kcm: true, scheduler: false });
    edit(APISERVER, (t) => t.replace("--secure-port=6443", "--secure-port=6444"));
    wait(30);
    expect(controlPlaneHealth(c)).toEqual({ api: false, kcm: false, scheduler: false }); // nothing works without the apiserver
  });
});

describe("a cluster with no control plane simulated", () => {
  test("system Pods off: nothing is ever gated or refused", () => {
    const c = new Cluster({ seed: 3, systemPods: false });
    const ctx = { cluster: c, namespace: "default", files: {} as Record<string, string>, shell: newShell() };
    expect(controlPlaneHealth(c)).toEqual({ api: true, kcm: true, scheduler: true });
    expect(runKubectl(ctx, "kubectl create deployment web --image=nginx:1.27 --replicas=2").ok).toBe(true);
    c.advance(20_000);
    expect(c.list<Pod>("Pod").filter((p) => p.status?.phase === "Running").length).toBe(2);
  });
});

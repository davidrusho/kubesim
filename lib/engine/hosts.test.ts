// The host behind each Node (ADR 0003): the kubelet as a service, and static Pods read from manifests.
// Every expectation cites the scenario of docs/research/real-cluster-captures-control-plane.md it reproduces.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Cluster, EXAM_NODES, podStatusColumns, type Node, type Pod } from "@/lib/engine";
import { MANIFEST_DIR, SYSTEM_IMAGES, hostWrite, manifestFor } from "@/lib/engine/host";
import { runKubectl } from "@/lib/kubectl/kubectl";
import { decodeCluster, encodeCluster } from "@/lib/sim/share";
import { newShell } from "@/lib/kubectl/shell";

const SCHEDULER = `${MANIFEST_DIR}/kube-scheduler.yaml`;
const APISERVER = `${MANIFEST_DIR}/kube-apiserver.yaml`;
const KCM = `${MANIFEST_DIR}/kube-controller-manager.yaml`;
const CONFIG = "/var/lib/kubelet/config.yaml";

/** A two-Node exam cluster, a terminal on the base machine, and root terminals on either Node. */
function lab() {
  const c = new Cluster({ seed: 7, systemPods: true, nodes: EXAM_NODES });
  const base = { cluster: c, namespace: "default", files: {} as Record<string, string>, shell: newShell() };
  const kubectl = (line: string) => runKubectl(base, line).out;
  const root = (node: string) => {
    const shell = newShell();
    shell.sessions.push({ node, user: "root", via: "sudo" });
    const ctx = { cluster: c, namespace: "default", files: {} as Record<string, string>, shell };
    return (line: string) => runKubectl(ctx, line);
  };
  const edit = (node: string, path: string, fn: (text: string) => string) => {
    const h = c.state.hosts[node];
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
  const nodeStatus = (name: string) => kubectl(`kubectl get node ${name} --no-headers`).split(/\s+/)[1];
  const mirror = (comp: string) => kubectl(`kubectl get pods -n kube-system -l component=${comp} --no-headers`).replace(/\s+/g, " ");
  return { c, kubectl, root, edit, wait, until, nodeStatus, mirror, cp: root("controlplane"), worker: root("node01") };
}

/**
 * The apiserver's mirror Pod as `kubectl get pods` would list it. While the apiserver is down kubectl is refused (ADR 0003,
 * decision 5), so a test of a broken apiserver reads the Pod from the store, the state the kubelet keeps on the node.
 */
const apiserverRow = (c: Cluster) => {
  const p = c.raw("Pod", "kube-system", "kube-apiserver-controlplane") as unknown as Pod | undefined;
  if (!p) return "No resources found in kube-system namespace.";
  const col = podStatusColumns(p);
  return `${col.ready} ${col.status}`;
};

describe("a host per Node (decision 1)", () => {
  test("every Node has one; the control plane has the four manifests, mode 0600, the worker has none (capture Scenario 0, ls -l)", () => {
    const { c, cp, worker } = lab();
    expect(Object.keys(c.state.hosts).sort()).toEqual(["controlplane", "node01"]);
    const rows = cp("ls -l /etc/kubernetes/manifests").out.split("\n");
    expect(rows[0]).toMatch(/^total \d+$/);
    expect(rows.slice(1).map((r) => r.replace(/\s+/g, " ").replace(/ \d+ \w{3} +\d+ \d\d:\d\d /, " <size+time> "))).toEqual([
      "-rw------- 1 root root <size+time> etcd.yaml",
      "-rw------- 1 root root <size+time> kube-apiserver.yaml",
      "-rw------- 1 root root <size+time> kube-controller-manager.yaml",
      "-rw------- 1 root root <size+time> kube-scheduler.yaml",
    ]);
    expect(worker("ls -l /etc/kubernetes/manifests").out).toBe("total 0"); // capture: worker `total 0`
  });

  test("the four manifests are the real kubeadm v1.36.6 ones (kubeadm capture), with only the node name, IP and image tag substituted", () => {
    const doc = readFileSync("docs/research/real-cluster-captures-kubeadm.md", "utf8");
    const { c } = lab();
    for (const comp of ["etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler"]) {
      const at = doc.indexOf(`## /etc/kubernetes/manifests/${comp}.yaml\n`);
      const open = doc.indexOf("```\n", at) + 4;
      const real = doc.slice(open, doc.indexOf("\n```", open)) + "\n";
      const mine = c.state.hosts.controlplane.files[`${MANIFEST_DIR}/${comp}.yaml`].content;
      const back = mine.replace(/172\.18\.0\.2/g, "10.0.0.10").replace(/image: \S+/, "image: IMG");
      expect(back).toBe(real.replace(/image: \S+/, "image: IMG"));
      expect(mine).toContain(`image: ${SYSTEM_IMAGES[comp as keyof typeof SYSTEM_IMAGES]}\n`); // the simulator's own version
    }
  });

  test("the kube-scheduler manifest is the one the capture printed in full, and the others carry the node name", () => {
    const doc = readFileSync("docs/research/real-cluster-captures-control-plane.md", "utf8");
    const at = doc.indexOf("cat /etc/kubernetes/manifests/kube-scheduler.yaml");
    const block = doc.slice(at, doc.indexOf("[exit 0]", at)).split("\n");
    const captured = block.slice(block.indexOf("apiVersion: v1")).join("\n");
    const { c } = lab();
    expect(c.state.hosts.controlplane.files[SCHEDULER].content.trimEnd()).toBe(captured.trimEnd());
    expect(manifestFor("etcd", "controlplane", "172.18.0.2")).toContain("--name=controlplane");
    expect(manifestFor("etcd", "controlplane", "172.18.0.2")).toContain("--initial-cluster=controlplane=https://172.18.0.2:2380");
  });

  test("the kubelet's config and unit are where kubeadm on Ubuntu puts them", () => {
    const { cp } = lab();
    const cfg = cp(`cat ${CONFIG}`).out;
    expect(cfg).toContain("staticPodPath: /etc/kubernetes/manifests");
    expect(cfg).toContain("containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock");
    expect(cp("systemctl cat kubelet --no-pager").out).toStartWith("# /usr/lib/systemd/system/kubelet.service\n[Unit]\nDescription=kubelet: The Kubernetes Node Agent");
    expect(cp("systemctl cat kubelet --no-pager").out).toContain("# /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf");
    expect(cp("cat /var/lib/kubelet/kubeadm-flags.env").out).toStartWith("KUBELET_KUBEADM_ARGS=");
  });

  test("a snapshot keeps the host (an edited file, a stopped service); a save from before hosts existed gets defaults and keeps its Pods", () => {
    const { c, edit, root } = lab();
    edit("node01", CONFIG, (t) => t + "# edited\n");
    root("node01")("systemctl stop kubelet");
    const back = new Cluster(c.snapshot());
    expect(back.state.hosts.node01.files[CONFIG].content).toEndWith("# edited\n");
    expect(back.state.hosts.node01.services.kubelet.active).toBe("inactive");
    const old = c.snapshot() as unknown as Record<string, unknown>;
    delete old.hosts;
    const restored = new Cluster(old as never);
    expect(Object.keys(restored.state.hosts).sort()).toEqual(["controlplane", "node01"]);
    expect(restored.state.hosts.controlplane.files[SCHEDULER]).toBeDefined();
    const before = restored.list<Pod>("Pod", "kube-system").map((p) => p.metadata.uid);
    restored.advance(30_000);
    // The mirror Pods the save already had are adopted, not created a second time.
    expect(restored.list<Pod>("Pod", "kube-system").map((p) => p.metadata.uid)).toEqual(expect.arrayContaining(before.filter((u) => restored.byUid(u)?.metadata.name.endsWith("-controlplane"))));
    expect(restored.list<Pod>("Pod", "kube-system").filter((p) => p.metadata.name === "kube-scheduler-controlplane")).toHaveLength(1);
  });
});

describe("a shared link carries the hosts", () => {
  test("hosts survive the round trip; a malformed block is dropped and the Nodes get default hosts", async () => {
    const { c, edit } = lab();
    edit("node01", CONFIG, (t) => t + "# edited\n");
    const back = await decodeCluster(await encodeCluster(c.snapshot()));
    expect(back.hosts.node01.files[CONFIG].content).toEndWith("# edited\n");
    const bad = c.snapshot() as unknown as { hosts: Record<string, { services: unknown }> };
    bad.hosts.node01.services = 7;
    const fixed = await decodeCluster(await encodeCluster(bad as never));
    expect(fixed.hosts).toBeUndefined();
    const run = new Cluster(fixed);
    run.advance(5000);
    expect(run.state.hosts.node01.files[CONFIG].content).not.toEndWith("# edited\n"); // rebuilt as defaults
    expect(run.state.hosts.node01.services.kubelet.active).toBe("active");
  });
});

describe("kubelet running is separate from the Node's power (decision 2)", () => {
  test("a stopped kubelet: Ready until ~52 s, then NotReady with Unknown conditions; the Pod stays 1/1 Running, its container keeps running (capture Scenario 1)", () => {
    const { c, kubectl, worker, until, nodeStatus, wait } = lab();
    kubectl("kubectl create deployment web --image=nginx:1.27");
    kubectl('kubectl patch deployment web -p {"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":"node01"}}}}}');
    wait(10);
    expect(kubectl("kubectl get pods --no-headers")).toMatch(/1\/1\s+Running/);
    worker("systemctl stop kubelet");
    expect(nodeStatus("node01")).toBe("Ready");
    const secs = until(() => nodeStatus("node01") === "NotReady", 70);
    expect(secs).toBeGreaterThanOrEqual(50);
    expect(secs).toBeLessThanOrEqual(55); // capture: NotReady at t+52 s (polls were 5 s apart)
    const conds = c.get<Node>("Node", undefined, "node01").status!.conditions;
    expect(conds.map((x) => [x.type, x.status, x.reason, x.message])).toEqual(
      ["MemoryPressure", "DiskPressure", "PIDPressure", "Ready"].map((t) => [t, "Unknown", "NodeStatusUnknown", "Kubelet stopped posting node status."]),
    );
    // The control plane's view does not change: 1/1 Running. The container is still there.
    expect(kubectl("kubectl get pods --no-headers")).toMatch(/1\/1\s+Running/);
    expect(worker("crictl ps").out).toMatch(/nginx\s+0\s/);
    expect(worker("crictl ps").out).toContain("Running");
  });

  test("eviction comes ~300 s after NotReady (capture: t+353 s); the replacement is Pending; starting the kubelet brings the Node back within 3 s", () => {
    const { c, kubectl, worker, until, nodeStatus, wait } = lab();
    kubectl("kubectl create deployment web --image=nginx:1.27");
    kubectl('kubectl patch deployment web -p {"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":"node01"}}}}}');
    wait(10);
    worker("systemctl stop kubelet");
    const t0 = c.now;
    expect(until(() => nodeStatus("node01") === "NotReady", 70)).toBeGreaterThan(0);
    expect(until(() => kubectl("kubectl get pods --no-headers").includes("Terminating"), 400)).toBeGreaterThan(0);
    const sinceStop = (c.now - t0) / 1000;
    expect(sinceStop).toBeGreaterThanOrEqual(345);
    expect(sinceStop).toBeLessThanOrEqual(360);
    const pods = kubectl("kubectl get pods --no-headers").split("\n").map((l) => l.split(/\s+/));
    expect(pods.map((p) => p[2]).sort()).toEqual(["Pending", "Terminating"]);
    worker("systemctl start kubelet");
    const ready = until(() => nodeStatus("node01") === "Ready", 10);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(ready).toBeLessThanOrEqual(3); // capture: Ready ~3 s after start
    wait(3);
    expect(kubectl("kubectl get pods --no-headers")).not.toContain("Terminating");
    expect(kubectl("kubectl get pods --no-headers")).toMatch(/1\/1\s+Running/);
  });

  test("systemctl status, is-active and the journal after a stop (capture Scenario 1)", () => {
    const { worker, wait } = lab();
    wait(20);
    worker("systemctl stop kubelet");
    const st = worker("systemctl status kubelet --no-pager");
    expect(st.ok).toBe(false); // capture: exit 3
    const lines = st.out.split("\n");
    expect(lines[0]).toBe("○ kubelet.service - kubelet: The Kubernetes Node Agent");
    expect(lines[1]).toBe("     Loaded: loaded (/usr/lib/systemd/system/kubelet.service; enabled; preset: enabled)");
    expect(lines[2]).toBe("    Drop-In: /usr/lib/systemd/system/kubelet.service.d");
    expect(lines[3]).toBe("             └─10-kubeadm.conf");
    expect(lines[4]).toMatch(/^     Active: inactive \(dead\) since \w{3} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC; \d+ms ago$/);
    expect(lines[5]).toMatch(/^   Duration: \d+(\.\d+)?s$/);
    expect(st.out).toContain("(code=exited, status=0/SUCCESS)");
    // The last journal lines are systemd's three, exactly as captured.
    expect(lines.slice(-3).map((l) => l.replace(/^\w{3} \d\d \d\d:\d\d:\d\d /, ""))).toEqual([
      "node01 systemd[1]: Stopping kubelet.service - kubelet: The Kubernetes Node Agent...",
      "node01 systemd[1]: kubelet.service: Deactivated successfully.",
      "node01 systemd[1]: Stopped kubelet.service - kubelet: The Kubernetes Node Agent.",
    ]);
    expect(worker("systemctl is-active kubelet").out).toBe("inactive");
    expect(worker("systemctl is-enabled kubelet").out).toBe("enabled");
  });

  test("disable + stop, then enable --now (capture Scenario 2)", () => {
    const { worker, until, nodeStatus, wait } = lab();
    wait(10);
    expect(worker("systemctl disable kubelet").out).toBe("Removed '/etc/systemd/system/multi-user.target.wants/kubelet.service'.");
    worker("systemctl stop kubelet");
    const st = worker("systemctl status kubelet --no-pager").out;
    expect(st).toContain("Loaded: loaded (/usr/lib/systemd/system/kubelet.service; disabled; preset: enabled)");
    expect(st).toMatch(/Active: inactive \(dead\) since/);
    const both = worker("systemctl is-enabled kubelet; systemctl is-active kubelet");
    expect(both.out).toBe("disabled\ninactive");
    expect(both.ok).toBe(false);
    expect(until(() => nodeStatus("node01") === "NotReady", 70)).toBeGreaterThan(0);
    expect(worker("systemctl enable --now kubelet").out).toBe("Created symlink '/etc/systemd/system/multi-user.target.wants/kubelet.service' → '/usr/lib/systemd/system/kubelet.service'.");
    expect(worker("systemctl status kubelet --no-pager").out).toContain("Active: active (running) since");
    const ready = until(() => nodeStatus("node01") === "Ready", 10);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(ready).toBeLessThanOrEqual(3);
  });

  test("a wrong runtime socket in config.yaml: activating (auto-restart), NotReady at ~51 s, containers up, the captured journal lines; the fix brings the Node back in ~4 s (capture Scenario 6)", () => {
    const { c, worker, edit, until, nodeStatus, wait } = lab();
    wait(5);
    const good = c.state.hosts.node01.files[CONFIG].content;
    edit("node01", CONFIG, (t) => t.replace("containerd.sock", "containerd.sockk"));
    worker("systemctl restart kubelet");
    expect(worker("systemctl is-active kubelet").out).toBe("activating");
    const st = worker("systemctl status kubelet --no-pager").out;
    expect(st).toContain("Active: activating (auto-restart) (Result: exit-code) since");
    expect(st).toContain("(code=exited, status=1/FAILURE)");
    expect(st).toContain("Main PID: ");
    const j = worker("journalctl -u kubelet --no-pager").out;
    expect(j).toContain(
      `"command failed" err="failed to run Kubelet: validate service connection: validate CRI v1 runtime API for endpoint \\"unix:///var/run/containerd/containerd.sockk\\": rpc error: code = Unavailable desc = connection error: desc = \\"transport: Error while dialing: dial unix /var/run/containerd/containerd.sockk: connect: no such file or directory\\""`,
    );
    expect(j).toContain('grpc: addrConn.createTransport failed to connect to {Addr: "/var/run/containerd/containerd.sockk", ServerName: "localhost", }.');
    const tail = j.split("\n").slice(-2).map((l) => l.replace(/^\w{3} \d\d \d\d:\d\d:\d\d /, ""));
    expect(tail).toEqual(["node01 systemd[1]: kubelet.service: Main process exited, code=exited, status=1/FAILURE", "node01 systemd[1]: kubelet.service: Failed with result 'exit-code'."]);
    // The config dump comes first, so `journalctl -n 30` is mostly dump: the cause is only in the last few lines.
    expect(worker("journalctl -u kubelet --no-pager -n 30").out.split("\n").filter((l) => /kubelet\[\d+\]: {9}\S/.test(l)).length).toBeGreaterThanOrEqual(15);
    // systemd tries again after RestartSec.
    wait(10);
    expect(worker("journalctl -u kubelet --no-pager").out).toContain("kubelet.service: Scheduled restart job, restart counter is at 1.");
    const secs = until(() => nodeStatus("node01") === "NotReady", 70);
    expect(secs).toBeGreaterThan(0);
    expect(worker("crictl ps").out).toContain("Running"); // containerd itself is fine
    edit("node01", CONFIG, () => good);
    worker("systemctl restart kubelet");
    const back = until(() => nodeStatus("node01") === "Ready", 10);
    expect(back).toBeGreaterThanOrEqual(0);
    expect(back).toBeLessThanOrEqual(4); // capture: Ready at t+4 s
  });

  test("NotReady after a wrong socket comes ~51 s after the restart (capture Scenario 6)", () => {
    const { worker, edit, until, nodeStatus, wait } = lab();
    wait(5);
    edit("node01", CONFIG, (t) => t.replace("containerd.sock", "containerd.sockk"));
    worker("systemctl restart kubelet");
    const secs = until(() => nodeStatus("node01") === "NotReady", 70);
    expect(secs).toBeGreaterThanOrEqual(49);
    expect(secs).toBeLessThanOrEqual(55);
  });

  test("an edit to config.yaml does nothing until the kubelet restarts; a config that does not parse stops it from starting", () => {
    const { worker, edit, wait, nodeStatus } = lab();
    wait(5);
    edit("node01", CONFIG, (t) => t.replace("containerd.sock", "containerd.sockk"));
    wait(80);
    expect(worker("systemctl is-active kubelet").out).toBe("active");
    expect(nodeStatus("node01")).toBe("Ready");
    edit("node01", CONFIG, () => "kind: KubeletConfiguration\nstaticPodPath: [\n");
    worker("systemctl restart kubelet");
    expect(worker("systemctl is-active kubelet").out).toBe("activating");
    expect(worker("journalctl -u kubelet --no-pager -n 4").out).toContain("failed to load kubelet config file, path: /var/lib/kubelet/config.yaml");
  });

  test("a unit or drop-in edit takes effect only after daemon-reload and a restart", () => {
    const { worker, edit, wait } = lab();
    wait(5);
    const dropin = "/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf";
    edit("node01", dropin, (t) => t.replace("--config=/var/lib/kubelet/config.yaml", "--config=/var/lib/kubelet/config.yamll"));
    const warn = "Warning: The unit file, source configuration file or drop-ins of kubelet.service changed on disk. Run 'systemctl daemon-reload' to reload units.";
    expect(worker("systemctl status kubelet --no-pager").out).toContain(warn);
    worker("systemctl restart kubelet"); // still the unit as loaded: healthy
    expect(worker("systemctl is-active kubelet").out).toBe("active");
    worker("systemctl daemon-reload");
    expect(worker("systemctl status kubelet --no-pager").out).not.toContain(warn);
    worker("systemctl restart kubelet");
    expect(worker("systemctl is-active kubelet").out).toBe("activating");
    expect(worker("journalctl -u kubelet --no-pager -n 3").out).toContain('failed to read kubelet config file \\"/var/lib/kubelet/config.yamll\\", error: open /var/lib/kubelet/config.yamll: no such file or directory');
  });
});

describe("static Pods come from the manifests (decision 3)", () => {
  test("the control-plane Pods are the mirror Pods of the four manifests: same names, labels and the file annotation", () => {
    const { c } = lab();
    const pods = c.list<Pod>("Pod", "kube-system").filter((p) => p.metadata.annotations?.["kubernetes.io/config.source"] === "file");
    expect(pods.map((p) => p.metadata.name)).toEqual(["etcd-controlplane", "kube-apiserver-controlplane", "kube-controller-manager-controlplane", "kube-scheduler-controlplane"]);
    for (const p of pods) {
      expect(p.metadata.labels).toEqual({ component: p.metadata.name.replace("-controlplane", ""), tier: "control-plane" });
      expect(p.metadata.ownerReferences?.[0]).toMatchObject({ kind: "Node", name: "controlplane" });
      expect(p.status?.phase).toBe("Running");
    }
  });

  test("YAML that does not parse: the Pod and its container are gone within 10 s, the kubelet says why (capture 3a)", () => {
    const { c, kubectl, cp, edit, until, wait } = lab();
    wait(20);
    expect(cp("crictl ps").out).toContain("kube-scheduler");
    edit("controlplane", SCHEDULER, (t) => t.replace("\n  containers:", "\n  containers"));
    const gone = until(() => !kubectl("kubectl get pods -n kube-system").includes("kube-scheduler"), 12);
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(gone).toBeLessThanOrEqual(10);
    expect(cp("crictl ps -a").out).not.toContain("kube-scheduler");
    expect(cp("crictl pods").out).not.toContain("kube-scheduler");
    wait(25);
    const lines = cp("journalctl -u kubelet --no-pager").out.split("\n").filter((l) => l.includes("file.go:186"));
    expect(lines.length).toBeGreaterThanOrEqual(2); // once at the change, again 20 s later
    expect(lines[0]).toMatch(/E\d{4} \d\d:\d\d:\d\d\.\d{6}\s+\d+ file\.go:186\] "Could not process manifest file" err="\/etc\/kubernetes\/manifests\/kube-scheduler\.yaml: couldn't parse as pod\(yaml: line 11: mapping values are not allowed in this context\), please check config file" path="\/etc\/kubernetes\/manifests\/kube-scheduler\.yaml"$/);
    expect(c.list<Pod>("Pod", "kube-system").some((p) => p.metadata.name.startsWith("kube-scheduler"))).toBe(false);
  });

  test("restoring the file brings the Pod back: Pending at once, 0/1 Running for ~10 s, 1/1 by ~16 s (capture 3a)", () => {
    const { c, cp, edit, until, mirror, wait } = lab();
    wait(20);
    const good = c.state.hosts.controlplane.files[SCHEDULER].content;
    edit("controlplane", SCHEDULER, (t) => t.replace("\n  containers:", "\n  containers"));
    wait(12);
    edit("controlplane", SCHEDULER, () => good);
    const appeared = until(() => mirror("kube-scheduler") !== "No resources found in kube-system namespace.", 6);
    expect(appeared).toBeGreaterThanOrEqual(0);
    expect(appeared).toBeLessThanOrEqual(5);
    expect(mirror("kube-scheduler")).toMatch(/0\/1 (Pending|ContainerCreating|Running)/);
    const t0 = c.now;
    const ready = until(() => mirror("kube-scheduler").includes("1/1"), 30);
    expect(ready).toBeGreaterThan(8);
    expect((c.now - t0) / 1000).toBeLessThanOrEqual(20); // capture: 1/1 at t+16 s
    expect(cp("crictl ps").out).toContain("kube-scheduler");
  });

  test("a wrong image tag: no container, ErrImagePull then ImagePullBackOff, the real pull error in describe (capture 3b)", () => {
    const { c, kubectl, cp, edit, until, mirror, wait } = lab();
    wait(20);
    edit("controlplane", SCHEDULER, (t) => t.replace("kube-scheduler:v1.37.0", "kube-scheduler:v1.37.99"));
    // The old Pod is deleted at the next scan; the new one comes ~10 s later (capture: recreated at t+15 s).
    const gone = until(() => mirror("kube-scheduler").startsWith("No resources"), 8);
    expect(gone).toBeGreaterThanOrEqual(0);
    const back = until(() => !mirror("kube-scheduler").startsWith("No resources"), 20);
    expect(back).toBeGreaterThanOrEqual(8);
    expect(back).toBeLessThanOrEqual(12);
    expect(until(() => /ErrImagePull|ImagePullBackOff/.test(mirror("kube-scheduler")), 40)).toBeGreaterThanOrEqual(0);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(mirror("kube-scheduler").split(" ")[2]);
      wait(1);
    }
    expect([...seen].sort()).toEqual(["ErrImagePull", "ImagePullBackOff"]);
    expect(cp("crictl ps -a").out).not.toContain("kube-scheduler"); // capture: no container exists to read logs from
    expect(cp("crictl pods").out).toMatch(/kube-scheduler-controlplane\s+kube-system\s+0\s+\(default\)/);
    const d = kubectl("kubectl describe pod -n kube-system kube-scheduler-controlplane");
    expect(d).toContain('Failed to pull image "registry.k8s.io/kube-scheduler:v1.37.99": rpc error: code = NotFound desc = failed to pull and unpack image "registry.k8s.io/kube-scheduler:v1.37.99": failed to resolve reference "registry.k8s.io/kube-scheduler:v1.37.99"');
    expect(d).toContain("Error: ImagePullBackOff");
    const j = cp("journalctl -u kubelet --no-pager").out;
    expect(j).toContain('"Error syncing pod, skipping" err="failed to \\"StartContainer\\" for \\"kube-scheduler\\" with ErrImagePull:');
    expect(j).toContain('with ImagePullBackOff:');
    expect(c.list<Pod>("Pod", "kube-system").find((p) => p.metadata.name === "kube-scheduler-controlplane")?.status?.phase).toBe("Pending");
  });

  test("a flag naming a missing file: the container exits and the Pod goes CrashLoopBackOff with rising attempts; the cause is in crictl logs (capture 3c)", () => {
    const { cp, edit, until, mirror, wait } = lab();
    wait(20);
    edit("controlplane", SCHEDULER, (t) => t.replace("--kubeconfig=/etc/kubernetes/scheduler.conf", "--kubeconfig=/etc/kubernetes/schedulr.conf"));
    expect(until(() => mirror("kube-scheduler").includes("CrashLoopBackOff"), 40)).toBeGreaterThan(0);
    wait(60);
    expect(mirror("kube-scheduler")).toMatch(/0\/1 CrashLoopBackOff [3-9] \(\d+s ago\)/);
    const ps = cp("crictl ps -a --name kube-scheduler").out.split("\n");
    expect(ps).toHaveLength(5); // the latest attempt and the three before it, all Exited, newest first (capture 3c lists ATTEMPT 1 to 3 together)
    expect(ps.slice(1).every((r) => /Exited\s+kube-scheduler\s+\d+\s/.test(r))).toBe(true);
    expect(ps[1]).toMatch(/Exited\s+kube-scheduler\s+[3-9]\s/);
    const id = ps[1].split(/\s+/)[0];
    const logs = cp(`crictl logs ${id}`).out.split("\n");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^I\d{4} \d\d:\d\d:\d\d\.\d{6}\s+1 serving\.go:411\] Generated self-signed cert in-memory$/);
    expect(logs[1]).toMatch(/^E\d{4} \d\d:\d\d:\d\d\.\d{6}\s+1 run\.go:72\] "command failed" err="stat \/etc\/kubernetes\/schedulr\.conf: no such file or directory"$/);
    const j = cp("journalctl -u kubelet --no-pager").out;
    expect(j).toContain("with CrashLoopBackOff: \\\"back-off 10s restarting failed container=kube-scheduler pod=kube-scheduler-controlplane_kube-system(");
    expect(j).toContain("back-off 20s restarting");
  });

  test("a bad certificate path in the apiserver: crash loop, with the captured log (capture 4c); a wrong --secure-port leaves it running (capture 4b)", () => {
    const { c, cp, edit, until, wait } = lab();
    wait(20);
    const good = lab;
    void good;
    edit("controlplane", APISERVER, (t) => t.replace("--tls-cert-file=/etc/kubernetes/pki/apiserver.crt", "--tls-cert-file=/etc/kubernetes/pki/apiserver.crtt"));
    expect(until(() => apiserverRow(c).includes("CrashLoopBackOff"), 40)).toBeGreaterThan(0);
    const id = cp("crictl ps -a -q --name kube-apiserver").out.split("\n")[0];
    const logs = cp(`crictl logs ${id}`).out.split("\n").map((l) => l.replace(/^[IE]\d{4} \d\d:\d\d:\d\d\.\d{6}\s+1 /, ""));
    expect(logs).toEqual([
      "options.go:261] external host was not specified, using 172.18.0.2",
      "server.go:151] Version: v1.37.0",
      'server.go:153] "Golang settings" GOGC="" GOMAXPROCS="" GOTRACEBACK=""',
      'run.go:72] "command failed" err="open /etc/kubernetes/pki/apiserver.crtt: no such file or directory"',
    ]);
  });

  test("a wrong --secure-port: the container keeps running (attempt 0), nothing listens on 6443 (capture 4b)", () => {
    const { c, cp, edit, wait } = lab();
    wait(20);
    edit("controlplane", APISERVER, (t) => t.replace("--secure-port=6443", "--secure-port=6444"));
    wait(60);
    const row = cp("crictl ps -a --name kube-apiserver").out.split("\n")[1];
    expect(row).toMatch(/Running\s+kube-apiserver\s+0\s/);
    expect(c.get<Pod>("Pod", "kube-system", "kube-apiserver-controlplane").status?.containerStatuses?.[0].restartCount).toBe(0);
  });

  test("a wrong --etcd-servers port: the apiserver retries ~20 s and then exits (capture 4a)", () => {
    const { c, cp, edit, until, wait } = lab();
    wait(20);
    edit("controlplane", APISERVER, (t) => t.replace("https://127.0.0.1:2379", "https://127.0.0.1:2399"));
    const running = until(() => /0\/1 Running/.test(apiserverRow(c)), 30);
    expect(running).toBeGreaterThan(0);
    const exited = until(() => cp("crictl ps -a --name kube-apiserver").out.includes("Exited"), 40);
    expect(exited).toBeGreaterThan(15);
    expect(exited).toBeLessThanOrEqual(25); // capture: gives up after ~20 s
    const id = cp("crictl ps -a -q --name kube-apiserver").out.split("\n")[0];
    const logs = cp(`crictl logs ${id}`).out;
    expect(logs).toContain('grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }.');
    expect(logs).toContain('"command failed" err="error creating storage factory: etcd grpc connection not ready: context deadline exceeded"');
  });

  test("a manifest moved out of the directory: the mirror Pod is gone within 5 s, and back when it is moved in (capture Scenario 5)", () => {
    const { c, cp, until, mirror, wait } = lab();
    wait(20);
    expect(cp(`mv ${KCM} /root/kcm.yaml`).ok).toBe(true);
    expect(cp("ls /etc/kubernetes/manifests").out).not.toContain("kube-controller-manager");
    const gone = until(() => mirror("kube-controller-manager").startsWith("No resources"), 8);
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(gone).toBeLessThanOrEqual(5);
    expect(cp("crictl ps -a").out).not.toContain("kube-controller-manager");
    expect(c.state.hosts.controlplane.files["/root/kcm.yaml"].mode).toBe(0o600); // mv keeps the mode
    cp("mv /root/kcm.yaml /etc/kubernetes/manifests/kube-controller-manager.yaml");
    expect(until(() => mirror("kube-controller-manager").includes("1/1"), 30)).toBeGreaterThan(0);
  });

  test("a manifest for any Pod works: a static Pod on node01 appears as <name>-node01 with the file annotation", () => {
    const { c, worker, wait } = lab();
    wait(5);
    const manifest = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: static-web\nspec:\n  containers:\n  - name: web\n    image: nginx:1.27\n";
    expect(worker(`cat > ${MANIFEST_DIR}/static-web.yaml <<'EOF'\n${manifest}EOF`).ok).toBe(true);
    wait(25);
    const p = c.get<Pod>("Pod", "default", "static-web-node01");
    expect(p.metadata.annotations?.["kubernetes.io/config.source"]).toBe("file");
    expect(p.spec?.nodeName).toBe("node01");
    expect(p.status?.phase).toBe("Running");
    expect(p.status?.podIP).toMatch(/^10\.244\./);
  });

  test("with the kubelet stopped, manifest edits are not picked up until it starts again", () => {
    const { cp, edit, mirror, wait, until } = lab();
    wait(20);
    cp("systemctl stop kubelet");
    edit("controlplane", SCHEDULER, (t) => t.replace("\n  containers:", "\n  containers"));
    wait(30);
    expect(mirror("kube-scheduler")).toContain("1/1");
    cp("systemctl start kubelet");
    expect(until(() => mirror("kube-scheduler").startsWith("No resources"), 10)).toBeGreaterThanOrEqual(0);
  });

  test("the component-health function names a stopped or broken component (the seam for the controller gates)", async () => {
    const { c, edit, wait } = lab();
    const { componentUp } = await import("./controllers/staticpods");
    wait(30);
    expect(componentUp(c, "kube-scheduler")).toBe(true);
    edit("controlplane", SCHEDULER, (t) => t.replace("--kubeconfig=/etc/kubernetes/scheduler.conf", "--kubeconfig=/etc/kubernetes/schedulr.conf"));
    wait(30);
    expect(componentUp(c, "kube-scheduler")).toBe(false);
    expect(componentUp(c, "kube-apiserver")).toBe(true);
    edit("controlplane", APISERVER, (t) => t.replace("--secure-port=6443", "--secure-port=6444"));
    wait(30);
    expect(componentUp(c, "kube-apiserver")).toBe(false); // running, but not on 6443 (capture 4b)
  });
});

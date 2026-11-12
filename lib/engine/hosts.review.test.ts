// Node hosts and the control plane, hardened: etcd down takes the API down, a mirror Pod deleted does not restart its container,
// a bad link or manifest is a fault on the Node and not an exception, and the small host-shell corners.
// Timings cite docs/research/real-cluster-captures-control-plane.md.

import { describe, expect, test } from "bun:test";
import { Cluster, EXAM_NODES, controlPlaneHealth, type Node, type Pod } from "@/lib/engine";
import { MANIFEST_DIR, hostWrite } from "@/lib/engine/host";
import { runKubectl } from "@/lib/kubectl/kubectl";
import { newShell } from "@/lib/kubectl/shell";
import { decodeCluster, encodeCluster, SHARE_LIMITS } from "@/lib/sim/share";

const ETCD = `${MANIFEST_DIR}/etcd.yaml`;
const SCHEDULER = `${MANIFEST_DIR}/kube-scheduler.yaml`;
const REFUSED = "The connection to the server controlplane:6443 was refused - did you specify the right host or port?";

function lab(seed = 7) {
  const c = new Cluster({ seed, systemPods: true, nodes: EXAM_NODES });
  const base = { cluster: c, namespace: "default", files: {} as Record<string, string>, shell: newShell() };
  const kubectl = (line: string) => runKubectl(base, line).out;
  const root = (node: string) => {
    const shell = newShell();
    shell.sessions.push({ node, user: "root", via: "sudo" });
    const ctx = { cluster: c, namespace: "default", files: {} as Record<string, string>, shell };
    return (line: string) => runKubectl(ctx, line);
  };
  const edit = (path: string, fn: (text: string) => string, node = "controlplane") => {
    const h = c.state.hosts[node];
    hostWrite(h, path, fn(h.files[path]?.content ?? ""), c.now);
  };
  const wait = (s: number) => c.advance(s * 1000);
  const until = (done: () => boolean, limit: number) => {
    for (let t = 0; t <= limit; t++) {
      if (done()) return t;
      wait(1);
    }
    return -1;
  };
  return { c, base, kubectl, root, edit, wait, until, cp: root("controlplane") };
}

describe("etcd down takes the API down (ADR 0003, decision 4; capture 4a)", () => {
  test("an etcd that crash-loops (a missing certificate) leaves kubectl working for the retry window, then refused; the fix brings it back", () => {
    const { c, kubectl, edit, wait, until } = lab();
    wait(5);
    edit(ETCD, (t) => t.replace("--cert-file=/etc/kubernetes/pki/etcd/server.crt", "--cert-file=/etc/kubernetes/pki/etcd/server.crtt"));
    wait(8);
    expect(kubectl("kubectl get nodes")).not.toBe(REFUSED); // the apiserver rides out a short etcd absence
    const refused = until(() => kubectl("kubectl get nodes") === REFUSED, 60);
    expect(refused).toBeGreaterThan(8); // after the ~20 s window, counted from when etcd went away
    expect(refused).toBeLessThanOrEqual(40);
    const good = c.state.hosts.controlplane.files[ETCD].content.replace("server.crtt", "server.crt");
    edit(ETCD, () => good);
    expect(until(() => kubectl("kubectl get nodes") !== REFUSED, 60)).toBeGreaterThan(0);
    expect(kubectl("kubectl get nodes")).toContain("controlplane");
  });

  test("etcd's manifest moved out: the same, and the controller-manager and scheduler follow the API", () => {
    const { c, kubectl, cp, wait } = lab();
    wait(5);
    cp(`mv ${ETCD} /root/etcd.yaml`);
    wait(40);
    expect(kubectl("kubectl get nodes")).toBe(REFUSED);
    expect(controlPlaneHealth(c)).toEqual({ api: false, kcm: false, scheduler: false });
  });
});

describe("deleting a mirror Pod", () => {
  test("kubectl delete pod on the apiserver's mirror Pod makes a new Pod in front of the same container: no restart, no outage", () => {
    const { c, kubectl, cp, wait } = lab();
    wait(20);
    const idsBefore = cp("crictl ps -q --name kube-apiserver").out;
    const old = c.get<Pod>("Pod", "kube-system", "kube-apiserver-controlplane");
    expect(kubectl("kubectl delete pod kube-apiserver-controlplane -n kube-system")).toContain("deleted");
    expect(kubectl("kubectl get nodes")).toContain("controlplane"); // not refused, at once
    const now = c.get<Pod>("Pod", "kube-system", "kube-apiserver-controlplane");
    expect(now.metadata.uid).not.toBe(old.metadata.uid);
    expect(now.metadata.annotations?.["kubernetes.io/config.source"]).toBe("file");
    wait(30);
    expect(kubectl("kubectl get nodes")).toContain("controlplane");
    expect(cp("crictl ps -q --name kube-apiserver").out).toBe(idsBefore); // the same container
    expect(c.get<Pod>("Pod", "kube-system", "kube-apiserver-controlplane").status?.containerStatuses?.[0].restartCount).toBe(0);
    expect(kubectl("kubectl get pods -n kube-system -l component=kube-apiserver --no-headers")).toMatch(/1\/1\s+Running\s+0\s/);
  });
});

describe("a link or a manifest the engine cannot make sense of is a fault on the Node, never an exception", () => {
  const roundTrip = async (c: Cluster, mutate: (s: Cluster["state"]) => void) => {
    const state = c.snapshot();
    mutate(state);
    return decodeCluster(await encodeCluster(state));
  };

  test("the reviewer's inputs: static[path] with a numeric pod, a numeric staticPodPath, non-string loaded: the hosts block is dropped and rebuilt", async () => {
    const { c } = lab();
    for (const mutate of [
      (s: Cluster["state"]) => (s.hosts.controlplane.static["/etc/kubernetes/manifests/etcd.yaml"] = { hash: "a", pod: 5 as unknown as string }),
      (s: Cluster["state"]) => (s.hosts.controlplane.services.kubelet.staticPodPath = 5 as unknown as string),
      (s: Cluster["state"]) => (s.hosts.controlplane.loaded["/x"] = 5 as unknown as string),
      (s: Cluster["state"]) => (s.hosts.node01.services.kubelet.active = "exploded" as never),
      (s: Cluster["state"]) => (s.hosts.node01.services.kubelet.restarts = "3" as unknown as number),
    ]) {
      const back = await roundTrip(c, mutate);
      expect(back.hosts).toBeUndefined();
      const rebuilt = new Cluster(back);
      rebuilt.advance(10_000); // runs: the Nodes get default hosts
      expect(Object.keys(rebuilt.state.hosts).sort()).toEqual(["controlplane", "node01"]);
    }
  });

  test("counts and sizes are capped: too many files, a huge file, too many journal lines", async () => {
    const { c } = lab();
    const many = await roundTrip(c, (s) => {
      for (let i = 0; i <= SHARE_LIMITS.hostFiles; i++) s.hosts.node01.files[`/tmp/f${i}`] = { content: "x", mode: 0o644, mtime: 0 };
    });
    expect(many.hosts).toBeUndefined();
    const big = await roundTrip(c, (s) => void (s.hosts.node01.files["/tmp/big"] = { content: "x".repeat(SHARE_LIMITS.fileBytes + 1), mode: 0o644, mtime: 0 }));
    expect(big.hosts).toBeUndefined();
    const lines = await roundTrip(c, (s) => void (s.hosts.node01.journal.kubelet = Array.from({ length: SHARE_LIMITS.journalLines + 1 }, () => ({ t: 0, text: "x" }))));
    expect(lines.hosts).toBeUndefined();
    // Control: an untouched cluster's hosts survive the same check.
    expect((await roundTrip(c, () => {})).hosts).toBeDefined();
  });

  test("an engine given the bad state directly does not throw either: the kubelet logs it and carries on", () => {
    const { c } = lab();
    c.state.hosts.controlplane.static["/etc/kubernetes/manifests/etcd.yaml"] = { hash: "a", pod: 5 as unknown as string };
    c.state.hosts.node01.services.kubelet.staticPodPath = 5 as unknown as string;
    expect(() => c.advance(12_000)).not.toThrow();
  });

  test("a manifest with more than 100 aliases (typed on the Node) is a manifest the kubelet cannot parse", () => {
    const { c, root, kubectl, wait } = lab();
    wait(5);
    const bomb = `apiVersion: v1\nkind: Pod\nmetadata:\n  name: bomb\nspec:\n  containers:\n  - name: a\n    image: nginx\n  x: &a [1]\n  y: [${Array.from({ length: 150 }, () => "*a").join(", ")}]\n`;
    expect(root("node01")(`cat > ${MANIFEST_DIR}/bomb.yaml <<'EOF'\n${bomb}EOF`).ok).toBe(true);
    expect(() => wait(12)).not.toThrow();
    expect(c.state.hosts.node01.static[`${MANIFEST_DIR}/bomb.yaml`]?.bad).toBeDefined();
    expect(kubectl("kubectl get pods -A --no-headers")).not.toContain("bomb");
    expect(root("node01")("journalctl -u kubelet --no-pager").out).toContain("bomb.yaml");
  });

  test("the same bomb as the kubelet's config.yaml: the kubelet fails to start, it does not crash the engine", () => {
    const { c, root, wait } = lab();
    wait(5);
    const bomb = `apiVersion: kubelet.config.k8s.io/v1beta1\nkind: KubeletConfiguration\nx: &a [1]\ny: [${Array.from({ length: 150 }, () => "*a").join(", ")}]\n`;
    hostWrite(c.state.hosts.node01, "/var/lib/kubelet/config.yaml", bomb, c.now);
    expect(root("node01")("systemctl restart kubelet").ok).toBe(true);
    expect(() => wait(10)).not.toThrow();
    expect(c.state.hosts.node01.services.kubelet.active).toBe("activating");
  });

  test("a unit whose loaded text is not text fails the kubelet's start, it does not throw", () => {
    const { c, root, wait } = lab();
    wait(5);
    c.state.hosts.node01.loaded["/usr/lib/systemd/system/kubelet.service"] = 5 as unknown as string;
    expect(() => root("node01")("systemctl restart kubelet")).not.toThrow();
    expect(() => wait(10)).not.toThrow();
    expect(c.state.hosts.node01.services.kubelet.active).toBe("activating");
  });

  test("a kubelet config field of the wrong type does not decode", () => {
    const { c, root, wait } = lab();
    wait(5);
    hostWrite(c.state.hosts.node01, "/var/lib/kubelet/config.yaml", "apiVersion: kubelet.config.k8s.io/v1beta1\nkind: KubeletConfiguration\nstaticPodPath: 5\n", c.now);
    root("node01")("systemctl restart kubelet");
    expect(() => wait(10)).not.toThrow();
    expect(c.state.hosts.node01.services.kubelet.active).toBe("activating");
  });
});

describe("the host shell", () => {
  test("/var/run is /run: ls /var/run/containerd lists the socket (hint 4 of node-notready-after-change)", () => {
    const { root } = lab();
    const node = root("node01");
    expect(node("ls /var/run/containerd").out).toContain("containerd.sock");
    expect(node("ls /run/containerd").out).toBe(node("ls /var/run/containerd").out);
    expect(node("ls /var/run/nosuchthing").ok).toBe(false);
  });

  test("systemctl on a name that is an Object member says the unit is not there, and does not crash", () => {
    const { root } = lab();
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = root("node01")(`systemctl status ${name}`);
      expect(r.out, name).toContain(`Unit ${name}.service could not be found.`);
      expect(r.ok).toBe(false);
    }
  });

  test("deleting the Node you are logged in to: the session keeps working on the host that is still there", () => {
    const { c, kubectl, root, wait } = lab();
    wait(5);
    const node = root("node01");
    expect(kubectl("kubectl delete node node01")).toContain("deleted");
    expect(c.raw("Node", undefined, "node01")).toBeUndefined();
    for (const line of ["systemctl status kubelet --no-pager", "ls /etc/kubernetes", "cat /var/lib/kubelet/config.yaml", "crictl ps", "crictl images", "journalctl -u kubelet --no-pager", "hostname"]) {
      expect(() => node(line), line).not.toThrow();
    }
    expect(node("cat /var/lib/kubelet/config.yaml").out).toContain("staticPodPath");
    expect(() => wait(20)).not.toThrow();
  });
});

describe("the container runtime and crictl", () => {
  test("systemctl stop containerd: the Node goes NotReady on the kubelet's grace path; restart recovers in a few seconds", () => {
    const { c, kubectl, root, wait, until } = lab();
    wait(5);
    const w = root("node01");
    expect(w("systemctl stop containerd").ok).toBe(true);
    wait(30);
    expect(kubectl("kubectl get node node01 --no-headers")).toContain(" Ready");
    const notReady = until(() => kubectl("kubectl get node node01 --no-headers").includes("NotReady"), 60);
    expect(notReady).toBeGreaterThan(0);
    expect(notReady).toBeLessThanOrEqual(40); // 50 s grace from the last heartbeat, 30 s of which had already passed
    expect(c.get<Node>("Node", undefined, "node01").status?.conditions.find((q) => q.type === "Ready")?.status).toBe("Unknown");
    expect(w("systemctl restart containerd").ok).toBe(true);
    const back = until(() => kubectl("kubectl get node node01 --no-headers").includes(" Ready"), 15);
    expect(back).toBeGreaterThanOrEqual(0);
    expect(back).toBeLessThanOrEqual(5); // capture: Ready within ~3 s
  });

  test("crictl ps -a lists the earlier attempts of a crash-looping container as Exited, with consecutive ATTEMPT numbers (capture 3c)", () => {
    const { c, cp, edit, wait } = lab();
    wait(5);
    edit(SCHEDULER, (t) => t.replace("--kubeconfig=/etc/kubernetes/scheduler.conf", "--kubeconfig=/etc/kubernetes/schedulr.conf"));
    wait(150);
    const restarts = c.get<Pod>("Pod", "kube-system", "kube-scheduler-controlplane").status?.containerStatuses?.[0].restartCount ?? 0;
    expect(restarts).toBeGreaterThanOrEqual(3);
    const rows = cp("crictl ps -a --name kube-scheduler").out.split("\n").slice(1).map((l) => l.split(/\s+/));
    const attempts = rows.map((r) => Number(r[5])).sort((a, b) => b - a);
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts.slice(0, 3)).toEqual([attempts[0], attempts[0] - 1, attempts[0] - 2]);
    expect(rows.filter((r) => r.includes("Exited")).length).toBeGreaterThanOrEqual(3);
    // The logs of an earlier attempt are readable by its ID.
    const prev = cp("crictl ps -a -q --name kube-scheduler").out.split("\n")[1];
    expect(cp(`crictl logs ${prev}`).out).toContain("schedulr.conf");
  });
});

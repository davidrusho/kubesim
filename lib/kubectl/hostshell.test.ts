// The terminal on a Node's host (ADR 0003, decision 6): ssh, the prompt, sudo, files by absolute path,
// systemctl, journalctl, crictl. Output shapes cite docs/research/real-cluster-captures-control-plane.md.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Cluster, EXAM_NODES } from "@/lib/engine";
import { SimStore } from "@/lib/sim/useSimulation";
import { Terminal } from "@/components/sim/Terminal";
import { readFileSync } from "node:fs";
import { table } from "./crictl";

const SCHEDULER = "/etc/kubernetes/manifests/kube-scheduler.yaml";

/** An exam terminal: the two exam Nodes, and the system Pods up. */
function exam() {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 3, systemPods: true, nodes: EXAM_NODES });
  const run = (line: string) => s.exec(line)!;
  return { s, run, out: (line: string) => run(line).out };
}

describe("ssh, the prompt and exit", () => {
  test("ssh <node> changes the prompt to candidate@<node>:~$, sudo -i to root@<node>:~#, and exit goes back one login at a time", () => {
    const { s, run } = exam();
    expect(s.prompt).toBeUndefined(); // the base terminal's own prompt is unchanged
    expect(run("ssh node01").ok).toBe(true);
    expect(s.prompt).toBe("candidate@node01:~$");
    run("sudo -i");
    expect(s.prompt).toBe("root@node01:~#");
    expect(run("exit").out).toBe("logout");
    expect(s.prompt).toBe("candidate@node01:~$");
    expect(run("exit").out).toBe("logout\nConnection to node01 closed.");
    expect(s.prompt).toBeUndefined();
    expect(run("exit").out).toContain("command not found"); // nothing to leave: as before
  });

  test("each scrollback entry keeps the prompt it was typed at", () => {
    const { s, run } = exam();
    run("ssh controlplane");
    run("hostname");
    run("exit");
    run("kubectl get nodes");
    expect(s.term.map((t) => t.prompt)).toEqual([undefined, "candidate@controlplane:~$", "candidate@controlplane:~$", undefined]);
    expect(s.term[1].out).toBe("controlplane");
  });

  test("the Terminal shows the host prompt, and the practice prompt still hides the namespace", () => {
    const { s, run } = exam();
    run("kubectl config set-context --current --namespace=kube-system");
    run("kubectl get pods");
    expect(renderToStaticMarkup(createElement(Terminal, { sim: s }))).toContain("(kube-system) $");
    expect(renderToStaticMarkup(createElement(Terminal, { sim: s, quiet: true }))).not.toContain("(kube-system)");
    run("ssh node01");
    const html = renderToStaticMarkup(createElement(Terminal, { sim: s, quiet: true }));
    expect(html).toContain("candidate@node01:~$");
    run("sudo -i");
    expect(renderToStaticMarkup(createElement(Terminal, { sim: s, quiet: true }))).toContain("root@node01:~#");
  });

  test("ssh to something that is not a Node, as another user, or from a node, fails the way ssh does", () => {
    const { run, out } = exam();
    expect(out("ssh nowhere")).toBe("ssh: Could not resolve hostname nowhere: Name or service not known");
    expect(out("ssh root@node01")).toBe("root@node01: Permission denied (publickey).");
    run("ssh node01");
    expect(out("ssh controlplane")).toBe("candidate@controlplane: Permission denied (publickey).");
  });

  test("a Node without power cannot be reached", () => {
    const { s, out } = exam();
    s.cluster!.state.nodes.node01.up = false;
    expect(out("ssh node01")).toBe("ssh: connect to host node01 port 22: Connection timed out");
    expect(s.prompt).toBeUndefined();
  });

  test("sudo -i needs a node: on the base terminal there is no root shell, but a sudo prefix is accepted", () => {
    const { run, out } = exam();
    expect(run("sudo -i").ok).toBe(false);
    expect(out("sudo kubectl get nodes")).toContain("controlplane");
    expect(out("sudo echo hi")).toBe("hi");
  });
});

describe("what the candidate may do on a node, and what needs root", () => {
  test("systemctl status works as the candidate (without the journal); changes need sudo (polkit)", () => {
    const { run, out } = exam();
    run("ssh node01");
    const st = out("systemctl status kubelet --no-pager");
    expect(st).toContain("Active: active (running)");
    // Real kubeadm node, 2026-11-12: as the candidate, status ends at the CGroup line, with no journal lines and no warning.
    expect(st.split("\n").at(-1)).toMatch(/^ +└─\d+ /);
    expect(st).not.toContain("Warning");
    const r = run("systemctl restart kubelet");
    expect(r.out).toBe("Failed to restart kubelet.service: Interactive authentication required.\nSee system logs and 'systemctl status kubelet.service' for details.");
    expect(r.ok).toBe(false);
    expect(out("systemctl stop kubelet")).toContain("Interactive authentication required.");
    expect(out("sudo systemctl is-active kubelet")).toBe("active");
    expect(run("sudo systemctl restart kubelet").ok).toBe(true);
    // sudo is for one command: the next plain one is the candidate's again.
    expect(run("systemctl restart kubelet").ok).toBe(false);
    expect(run("sudo -i").ok).toBe(true);
    expect(run("systemctl restart kubelet").ok).toBe(true);
  });

  test("journalctl and crictl need root; the manifests are root-only until sudo", () => {
    const { run, out } = exam();
    run("ssh controlplane");
    expect(out("crictl ps")).toContain("permission denied");
    expect(out(`cat ${SCHEDULER}`)).toBe(`cat: ${SCHEDULER}: Permission denied`);
    expect(out(`sudo cat ${SCHEDULER}`)).toStartWith("apiVersion: v1\nkind: Pod");
    expect(out("ls -l /etc/kubernetes/manifests")).toContain("-rw------- 1 root root"); // the directory itself is readable
    expect(out("cat /var/lib/kubelet/config.yaml")).toContain("staticPodPath: /etc/kubernetes/manifests"); // 0644
  });

  test("writing outside /tmp is refused; sudo and a root shell may", () => {
    const { s, run, out } = exam();
    run("ssh node01");
    expect(out("echo x > /etc/kubernetes/foo")).toBe("bash: /etc/kubernetes/foo: Permission denied");
    expect(out("echo x > /tmp/mine")).toBe("");
    expect(out("cat /tmp/mine")).toBe("x");
    run("sudo -i");
    expect(run("echo x > /etc/kubernetes/foo").ok).toBe(true);
    expect(out("cat /etc/kubernetes/foo")).toBe("x");
    expect(out("echo x > /no/such/dir/file")).toBe("bash: /no/such/dir/file: No such file or directory");
    expect(s.cluster!.state.hosts.node01.files["/etc/kubernetes/foo"].content).toBe("x\n");
  });

  test("kubectl on a node: only the control plane's root, through admin.conf (the worker has no kubeconfig)", () => {
    const { run, out } = exam();
    run("ssh node01");
    run("sudo -i");
    expect(out("kubectl get nodes")).toContain("The connection to the server localhost:8080 was refused");
    run("exit");
    run("exit");
    run("ssh controlplane");
    expect(out("kubectl get nodes")).toContain("localhost:8080 was refused");
    expect(out("kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes")).toBe('error: error loading config file "/etc/kubernetes/admin.conf": open /etc/kubernetes/admin.conf: permission denied');
    run("sudo -i");
    expect(out("kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes")).toContain("controlplane");
    run("export KUBECONFIG=/etc/kubernetes/admin.conf");
    expect(out("kubectl get nodes")).toContain("node01");
  });
});

/** The text of one captured block of docs/research/real-cluster-captures-kubeadm.md, between its heading's fence and the closing one. */
function kubeadmBlock(heading: string): string {
  const doc = readFileSync("docs/research/real-cluster-captures-kubeadm.md", "utf8");
  const at = doc.indexOf(`## ${heading}\n`);
  const open = doc.indexOf("```\n", at) + 4;
  return doc.slice(open, doc.indexOf("\n```", open));
}

describe("the candidate's view of a kubeadm node, as captured (kubeadm v1.36.6, Ubuntu 24.04, no sudo)", () => {
  /** The captured text with the run-specific parts (clock, pid) blanked. */
  const shape = (t: string) => t.replace(/^E\d{4} \d\d:\d\d:\d\d\.\d{6} +\d+ /gm, "E<time> <pid> ").replace(/time="[^"]*"/, 'time="<time>"');
  const { run } = exam();
  run("ssh controlplane");

  test("kubectl get nodes: five memcache errors, then the refusal; exit 1", () => {
    const r = run("kubectl get nodes");
    const captured = kubeadmBlock("AS candidate: kubectl get nodes").replace(/\n\[exit 1\]$/, "");
    expect(shape(r.out)).toBe(shape(captured));
    expect(r.out.split("\n")).toHaveLength(6);
    expect(r.out).toMatch(/^E\d{4} \d\d:\d\d:\d\d\.\d{6} {2}\d{6} memcache\.go:265\] /); // klog header: time, then the pid right-aligned
    expect(r.ok).toBe(false);
  });

  test("systemctl stop without sudo: polkit refuses, exit 1", () => {
    const r = run("systemctl stop kubelet");
    expect(r.out).toBe(kubeadmBlock("AS candidate: systemctl stop kubelet (no sudo, no tty)").replace(/\n\[exit 1\]$/, ""));
    expect(r.ok).toBe(false);
    for (const verb of ["start", "restart"]) expect(run(`systemctl ${verb} kubelet`).out).toBe(`Failed to ${verb} kubelet.service: Interactive authentication required.\nSee system logs and 'systemctl status kubelet.service' for details.`);
  });

  test("journalctl without sudo is not an error: the hint, then -- No entries --, exit 0; -q drops the hint", () => {
    const r = run("journalctl -u kubelet -n 3 --no-pager");
    expect(r.out).toBe(kubeadmBlock("AS candidate: journalctl -u kubelet -n 3 --no-pager").replace(/\n\[exit 0\]$/, ""));
    expect(r.ok).toBe(true);
    expect(run("journalctl -q -u kubelet --no-pager").out).toBe("-- No entries --");
  });

  test("crictl ps without sudo: the fatal permission-denied line, exit 1", () => {
    const captured = readFileSync("docs/research/real-cluster-captures-kubeadm.md", "utf8");
    const at = captured.indexOf("## AS candidate: crictl ps (standalone capture)");
    const line = captured.slice(captured.indexOf("```\n", at) + 4).split("\n")[0];
    const r = run("crictl ps");
    expect(shape(r.out)).toBe(shape(line));
    expect(r.ok).toBe(false);
  });

  test("cat of a 0600 manifest is refused, exit 1; ls of the directory works", () => {
    const r = run(`cat ${SCHEDULER}`);
    expect(r.out).toBe(kubeadmBlock("AS candidate: cat /etc/kubernetes/manifests/kube-scheduler.yaml").split("\n")[0]);
    expect(r.ok).toBe(false);
    expect(run("ls /etc/kubernetes/manifests").out.split("  ")).toEqual(kubeadmBlock("AS candidate: ls /etc/kubernetes/manifests").replace(/\n\[exit 0\]$/, "").split("\n"));
  });

  test("root's crictl ps layout is kubeadm's: header and rows laid out by the 20-or-widest+3 rule", () => {
    const real = kubeadmBlock("versions").split("\n").slice(2);
    const cells = real.map((l) => l.trim().split(/ {2,}/).map((c) => (c === "6 hours" ? c : c)));
    const rows = cells.map((r) => (r.length === 9 ? r : [...r.slice(0, 2), r.slice(2, 3).join(" "), ...r.slice(3)]));
    // The real listing had longer Pod names further down, which set the POD column; stand in for them.
    const wide = ["x", "x", "x", "x", "x", "0", "x", "p".repeat(40), "x"];
    const laid = table([...rows, wide]).split("\n").slice(0, -1);
    expect(laid).toEqual(real.map((l) => l.trimEnd()));
  });
});

describe("files by absolute path on a host", () => {
  test("cat, ls, cp, mv and rm over host files; the home files stay separate", () => {
    const { s, run, out } = exam();
    s.files["notes.txt"] = "mine\n";
    run("ssh controlplane");
    run("sudo -i");
    expect(out("ls /etc/kubernetes/manifests")).toBe("etcd.yaml  kube-apiserver.yaml  kube-controller-manager.yaml  kube-scheduler.yaml");
    expect(out("ls")).toContain("notes.txt"); // relative names are the Learner's own files, not the host's
    run(`cp -p ${SCHEDULER} /root/scheduler.bak`);
    expect(s.cluster!.state.hosts.controlplane.files["/root/scheduler.bak"].mode).toBe(0o600);
    expect(out("ls -l /root")).toMatch(/^total \d+\n-rw------- 1 root root +\d+ \w{3} +\d+ \d\d:\d\d scheduler\.bak$/);
    run(`mv ${SCHEDULER} /tmp/`);
    expect(out("ls /etc/kubernetes/manifests")).not.toContain("kube-scheduler");
    expect(out("ls /tmp")).toBe("kube-scheduler.yaml");
    expect(out(`cat ${SCHEDULER}`)).toBe(`cat: ${SCHEDULER}: No such file or directory`);
    run("rm /tmp/kube-scheduler.yaml");
    expect(out("ls /tmp")).toBe("");
    expect(out("cat /etc")).toBe("cat: /etc: Is a directory");
    expect(out("ls /nope")).toBe("ls: cannot access '/nope': No such file or directory");
    expect(out(`cp ${SCHEDULER} /tmp`)).toBe(`cp: cannot stat '${SCHEDULER}': No such file or directory`);
    // grep and pipes read host files like any other.
    expect(out("grep -c image: /etc/kubernetes/manifests/etcd.yaml")).toBe("1");
  });

  test("mv and cp work between the home directory and a host, and on the base terminal's own files", () => {
    const { s, run, out } = exam();
    s.files["a.yaml"] = "a: 1\n";
    run("cp a.yaml b.yaml");
    expect(s.files["b.yaml"]).toBe("a: 1\n");
    run("mv b.yaml c.yaml");
    expect(s.files["b.yaml"]).toBeUndefined();
    expect(s.files["c.yaml"]).toBe("a: 1\n");
    expect(out("mv nope.yaml x.yaml")).toBe("mv: cannot stat 'nope.yaml': No such file or directory");
    run("ssh node01");
    run("sudo -i");
    run("cp a.yaml /etc/a.yaml");
    expect(s.cluster!.state.hosts.node01.files["/etc/a.yaml"].content).toBe("a: 1\n");
    run("mv /etc/a.yaml home.yaml");
    expect(s.files["home.yaml"]).toBe("a: 1\n");
  });

  test("nano and vi open a host file; saving writes the Node's file and keeps its mode; a new file is not created by opening it", () => {
    const { s, run, out } = exam();
    run("ssh controlplane");
    expect(out(`nano ${SCHEDULER}`)).toBe(`nano: ${SCHEDULER}: Permission denied`); // root-only, like the real thing
    run("sudo -i");
    expect(run(`nano ${SCHEDULER}`).ok).toBe(true);
    expect(s.editorMode).toBe("nano");
    expect(s.editorFile).toBe(SCHEDULER);
    expect(s.editorNode).toBe("controlplane");
    expect(s.buffer).toContain("kube-scheduler:v1.37.0");
    expect(s.files[SCHEDULER]).toBeUndefined(); // the Learner's own files are not touched
    s.setBuffer(s.buffer.replace("v1.37.0", "v1.37.1"));
    expect(s.editorDirty).toBe(true);
    s.saveBuffer();
    const f = s.cluster!.state.hosts.controlplane.files[SCHEDULER];
    expect(f.content).toContain("kube-scheduler:v1.37.1");
    expect(f.mode).toBe(0o600);
    expect(s.editorDirty).toBe(false);
    s.exitEditor(false);
    expect(out(`grep -c v1.37.1 ${SCHEDULER}`)).toBe("1");
    run("vi /etc/kubernetes/manifests/new.yaml");
    expect(s.editorMode).toBe("vi");
    expect(s.cluster!.state.hosts.controlplane.files["/etc/kubernetes/manifests/new.yaml"]).toBeUndefined();
    s.setBuffer("x: 1\n");
    s.exitEditor(true);
    expect(s.cluster!.state.hosts.controlplane.files["/etc/kubernetes/manifests/new.yaml"].content).toBe("x: 1\n");
    // A bare name inside a host session is still one of the Learner's own files.
    run("nano mine.yaml");
    expect(s.editorNode).toBeUndefined();
  });

  test("editing a manifest through the editor is what changes the Pod (the terminal edit and the engine agree)", () => {
    const { s, run } = exam();
    s.cluster!.advance(20_000);
    run("ssh controlplane");
    run("sudo -i");
    run(`vi ${SCHEDULER}`);
    s.setBuffer(s.buffer.replace("kube-scheduler:v1.37.0", "kube-scheduler:v1.37.99"));
    s.exitEditor(true);
    s.cluster!.advance(45_000);
    run("exit");
    run("exit");
    expect(s.exec("kubectl get pods -n kube-system -l component=kube-scheduler")!.out).toMatch(/kube-scheduler-controlplane\s+0\/1\s+(ErrImagePull|ImagePullBackOff)/);
  });
});

describe("systemctl, journalctl and crictl output", () => {
  test("restart and start print nothing; status of an active unit has the captured fields", () => {
    const { s, run, out } = exam();
    s.cluster!.advance(40_000);
    run("ssh node01");
    run("sudo -i");
    const st = out("systemctl status kubelet --no-pager").split("\n");
    expect(st[0]).toBe("● kubelet.service - kubelet: The Kubernetes Node Agent");
    expect(st[4]).toMatch(/^     Active: active \(running\) since \w{3} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC; 1min 10s ago$/); // 30 s of warm-up plus 40 s
    expect(st[5]).toMatch(/^ Invocation: [0-9a-f]{32}$/);
    expect(st[6]).toBe("       Docs: https://kubernetes.io/docs/");
    expect(st[7]).toMatch(/^   Main PID: \d+ \(kubelet\)$/);
    expect(st.some((l) => l.startsWith("     CGroup: /system.slice/kubelet.service"))).toBe(true);
    expect(out("systemctl restart kubelet")).toBe("");
    expect(out("systemctl start kubelet")).toBe("");
    expect(out("systemctl is-active kubelet")).toBe("active");
    expect(out("systemctl status nope")).toBe("Unit nope.service could not be found.");
    expect(out("systemctl restart nope")).toBe("Failed to restart nope.service: Unit nope.service not found.");
    expect(out("systemctl frobnicate kubelet")).toBe("Unknown command verb 'frobnicate'.");
  });

  test("journalctl: -n, --since, -u, the line format, and -f streaming through the watch mechanism", () => {
    const { s, run, out } = exam();
    s.cluster!.advance(40_000);
    run("ssh node01");
    run("sudo -i");
    const lines = out("journalctl -u kubelet --no-pager -n 3").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\w{3} \d\d \d\d:\d\d:\d\d node01 kubelet\[\d+\]: [IWE]\d{4} \d\d:\d\d:\d\d\.\d{6}\s+\d+ \S+\] /);
    expect(out("journalctl -u kubelet --no-pager -n 0")).toBe("-- No entries --");
    out("systemctl stop kubelet");
    s.cluster!.advance(30_000);
    expect(out("journalctl -u kubelet --no-pager --since -10s")).toBe("-- No entries --");
    expect(out("journalctl -u kubelet --no-pager --since '-2 minutes ago'")).toContain("Stopped kubelet.service");
    expect(out("journalctl -u kubelet --no-pager --since garbage")).toBe("Failed to parse timestamp: garbage");
    const f = run("journalctl -u kubelet -f");
    expect(f.out.split("\n")).toHaveLength(10); // like -f: the last 10 lines first
    expect(s.term.at(-1)!.live).toBe("journalctl -u kubelet -n 10 --no-pager");
    run("systemctl start kubelet");
    expect(s.term.at(-1)!.live).toBeUndefined(); // the next command stops a stream
  });

  test("crictl ps, ps -a, pods, images and the table layout (capture Scenario 0)", () => {
    const { s, run, out } = exam();
    s.cluster!.advance(40_000);
    run("ssh controlplane");
    run("sudo -i");
    const rows = out("crictl ps").split("\n");
    expect(rows[0].split(/\s{2,}/)).toEqual(["CONTAINER", "IMAGE", "CREATED", "STATE", "NAME", "ATTEMPT", "POD ID", "POD", "NAMESPACE"]);
    const names = rows.slice(1).map((r) => r.split(/\s{2,}/)[4]);
    expect(names).toEqual(expect.arrayContaining(["etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler", "kube-proxy", "coredns"]));
    // 13-hex container and pod ids, and the CREATED wording of go-units.
    expect(rows[1]).toMatch(/^[0-9a-f]{13} {7}[0-9a-f]{13} {7}(\d+ seconds|About a minute|\d+ minutes|Less than a second) ago {2,}Running /);
    expect(out("crictl ps -a")).toBe(out("crictl ps"));
    const pods = out("crictl pods").split("\n");
    expect(pods[0].split(/\s{2,}/)).toEqual(["POD ID", "CREATED", "STATE", "NAME", "NAMESPACE", "ATTEMPT", "RUNTIME"]);
    expect(pods.slice(1).every((r) => /\s(Ready)\s/.test(r) && r.endsWith("(default)"))).toBe(true);
    expect(out("crictl images").split("\n")[0]).toMatch(/^IMAGE {2,}TAG {2,}IMAGE ID {2,}SIZE$/);
    expect(out("crictl images")).toContain("registry.k8s.io/kube-scheduler");
    expect(out("crictl --version")).toBe("crictl version v1.36.0"); // kubeadm capture (the kind capture printed it without the v)
    const id = rows[1].split(/\s+/)[0];
    const inspect = JSON.parse(out(`crictl inspect ${id}`));
    expect(inspect.status.id.startsWith(id)).toBe(true);
    expect(inspect.status.state).toBe("CONTAINER_RUNNING");
    expect(out("crictl logs deadbeef")).toContain('NotFound desc = an error occurred when try to find container \\"deadbeef\\"');
  });

  test("the table layout reproduces the capture's crictl ps blocks exactly (Scenario 0, control plane and worker)", () => {
    const doc = readFileSync("docs/research/real-cluster-captures-control-plane.md", "utf8");
    for (const host of ["cka-capture-control-plane", "cka-capture-worker"]) {
      const at = doc.indexOf(`[${host}]$ crictl ps\n`);
      const block = doc.slice(at, doc.indexOf("[exit 0]", at)).split("\n").slice(1).filter(Boolean);
      expect(block.length).toBeGreaterThan(2);
      expect(table(block.map((l) => l.trim().split(/ {2,}/)).map((r) => (r.length === 9 ? r : [...r.slice(0, 2), r.slice(2, 4).join(" "), ...r.slice(4)]))).split("\n")).toEqual(block.map((l) => l.trimEnd()));
    }
  });

  test("crictl needs a running containerd", () => {
    const { run, out } = exam();
    run("ssh node01");
    run("sudo -i");
    run("systemctl stop containerd");
    expect(out("crictl ps")).toContain("connection refused");
    run("systemctl start containerd");
    expect(out("crictl ps")).toContain("CONTAINER");
  });
});

describe("a cluster with the exam's node names (decision 7)", () => {
  test("SimOptions.nodes builds controlplane and node01; the default stays control-plane / worker-1 / worker-2", () => {
    const boot = (sim: SimStore) => (sim as unknown as { boot(): void }).boot();
    const exam = new SimStore({ nodes: EXAM_NODES });
    boot(exam);
    expect(Object.keys(exam.cluster!.state.nodes)).toEqual(["controlplane", "node01"]);
    expect(Object.keys(exam.cluster!.state.hosts)).toEqual(["controlplane", "node01"]);
    const dflt = new SimStore();
    boot(dflt);
    expect(Object.keys(dflt.cluster!.state.nodes)).toEqual(["control-plane", "worker-1", "worker-2"]);
    expect(Object.keys(dflt.cluster!.state.hosts)).toEqual(["control-plane", "worker-1", "worker-2"]);
  });
});

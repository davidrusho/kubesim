import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Cluster, EXAM_NODES, type KubeEvent, type Node, type Pod } from "@/lib/engine";
import { hostWrite } from "@/lib/engine/host";
import { runKubectl } from "@/lib/kubectl/kubectl";
import { newShell } from "@/lib/kubectl/shell";
import { INCIDENTS, incidentBySlug, shopYaml } from "@/lib/sim/incidents";
import { SimStore } from "@/lib/sim/useSimulation";
import { Inspector } from "./Inspector";
import { Workspace } from "./Workspace";

/** The lost-password incident, a minute after the page. */
function paged() {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 11, systemPods: true });
  s.apply(shopYaml(), "shop.yaml");
  s.cluster.advance(60_000);
  incidentBySlug(INCIDENTS[0].slug)!.break(s.cluster);
  s.cluster.advance(30_000);
  // The store collects events as the cluster emits them; here, take the ones it has.
  s.events = s.cluster.list<KubeEvent>("Event").sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return s;
}
const workspace = (s: SimStore, narration: boolean) => renderToStaticMarkup(createElement(Workspace, { sim: s, selection: null, onSelect: () => {}, quiet: true, narration }));

test("the cluster's status line names the cause, so practice mode holds it back until hints are asked for", () => {
  const s = paged();
  const shown = workspace(s, true);
  expect(shown).toContain("needs Secret"); // control: with narration on, the event that names the cause is there
  const hidden = workspace(s, false);
  expect(hidden).not.toContain("needs Secret");
});

test("in practice mode a button tooltip that names a command is dropped", () => {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 3, systemPods: true });
  const node = s.cluster.list<Node>("Node").find((n) => n.metadata.name.startsWith("worker"))!.metadata.name;
  const render = (quiet: boolean) => renderToStaticMarkup(createElement(Inspector, { sim: s, c: s.cluster!, sel: { kind: "node", name: node }, onSelect: () => {}, quiet }));
  expect(render(false)).toContain("kubectl drain");
  expect(render(true)).not.toContain("kubectl drain");
  expect(render(true)).not.toContain("kubectl uncordon");
});

// ---------------------------------------------------------------- the control plane's health on the canvas

const SCHEDULER_MANIFEST = "/etc/kubernetes/manifests/kube-scheduler.yaml";
const APISERVER_MANIFEST = "/etc/kubernetes/manifests/kube-apiserver.yaml";

/** An exam-node cluster in the store, after the control plane has had time to settle. */
function lab() {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 5, systemPods: true, nodes: EXAM_NODES });
  s.cluster.advance(20_000);
  const c = s.cluster;
  const edit = (path: string, fn: (t: string) => string) => {
    const h = c.state.hosts.controlplane;
    hostWrite(h, path, fn(h.files[path].content), c.now);
  };
  const root = (node: string, line: string) => {
    const shell = newShell();
    shell.sessions.push({ node, user: "root", via: "sudo" });
    return runKubectl({ cluster: c, namespace: "default", files: {}, shell }, line);
  };
  return { s, c, edit, root };
}
/** Every phrase that names a cause rather than a symptom. Practice mode must show none of them. */
const CAUSES = ["exits right after", "a flag", "manifest", "kubeconfig", "schedulr", "cannot parse", "image cannot be pulled", "kubelet service", "config.yaml", "6443", "secure-port", "not answering", "no Pod:"];

test("a crashing scheduler: practice mode shows the STATUS word kubectl would, and no cause; narration names the cause", () => {
  const { s, c, edit } = lab();
  edit(SCHEDULER_MANIFEST, (t) => t.replace("--kubeconfig=/etc/kubernetes/scheduler.conf", "--kubeconfig=/etc/kubernetes/schedulr.conf"));
  c.advance(60_000);
  expect(c.get<Pod>("Pod", "kube-system", "kube-scheduler-controlplane").status?.containerStatuses?.[0].state.waiting?.reason).toBe("CrashLoopBackOff");
  const practice = workspace(s, false);
  expect(practice).toContain("CrashLoopBackOff"); // control: the display exists and reads from the Pod
  for (const phrase of CAUSES) expect(practice).not.toContain(phrase);
  const narrated = workspace(s, true);
  expect(narrated).toContain("a flag, or a file a flag names, is wrong in the manifest");
});

test("a scheduler with no manifest: practice mode draws a plain placeholder with no label and no warning tone; narration names it", () => {
  const { s, c, root } = lab();
  root("controlplane", "mv /etc/kubernetes/manifests/kube-scheduler.yaml /root/");
  c.advance(10_000);
  const practice = workspace(s, false);
  expect(practice).not.toContain("no Pod");
  expect(practice).not.toContain("scheduler no");
  expect(practice).toContain("4 system components"); // the quiet label, as when nothing is wrong
  expect(practice).not.toContain("cv-mark-starting"); // no amber warning mark anywhere on the control plane
  for (const phrase of CAUSES) expect(practice).not.toContain(phrase);
  const narrated = workspace(s, true);
  expect(narrated).toContain("scheduler no Pod"); // control: narration still says it
  expect(narrated).toContain("kube-scheduler.yaml is not in /etc/kubernetes/manifests");
});

test("a stopped kubelet: practice mode shows Ready and then NotReady, as kubectl get nodes does; narration says the service is stopped", () => {
  const { s, c, root } = lab();
  expect(workspace(s, false)).toContain('data-kubelet="node01"');
  root("node01", "systemctl stop kubelet");
  c.advance(70_000);
  const practice = workspace(s, false);
  expect(practice).toContain("NotReady");
  for (const phrase of CAUSES) expect(practice).not.toContain(phrase);
  expect(practice).not.toContain("stopped");
  expect(workspace(s, true)).toContain("the kubelet service is stopped");
});

test("an unreachable apiserver: the canvas is marked stale in both modes, and only narration says why", () => {
  const { s, c, edit } = lab();
  expect(workspace(s, false)).not.toContain("unreachable");
  edit(APISERVER_MANIFEST, (t) => t.replace("--secure-port=6443", "--secure-port=6444"));
  c.advance(30_000);
  const practice = workspace(s, false);
  expect(practice).toContain('data-overlay="unreachable"');
  expect(practice).toContain("Cluster unreachable · showing the last state it read");
  expect(practice).toContain("cv-stale");
  for (const phrase of CAUSES) expect(practice).not.toContain(phrase);
  const narrated = workspace(s, true);
  expect(narrated).toContain("kube-apiserver is not answering on 6443");
  expect(narrated).toContain("check --secure-port and --etcd-servers in its manifest");
});

// ---------------------------------------------------------------- the node and control-plane Incidents show no command and no cause up front

const COMMAND_NAMES = ["ssh", "systemctl", "journalctl", "crictl", "kubectl", "sudo", "vi", "ls"];
/** What names each Incident's cause. The page, the brief and the title say how it looks, never why. */
const INCIDENT_CAUSES: Record<string, string[]> = {
  "node-not-ready": ["kubelet", "service", "stopped", "systemd", "inactive"],
  "node-lost-after-reboot": ["kubelet", "service", "enabled", "disabled", "at boot", "systemd", "stopped"],
  "pods-stuck-pending": ["scheduler", "kubeconfig", "manifest", "schedulr", "crash", "kube-system"],
  "cluster-unreachable": ["apiserver", "api server", "api-server", "etcd", "manifest", "port", "2399", "crash"],
  "scale-does-nothing": ["controller", "manifest", "moved", "kube-system", "replicaset"],
  "node-notready-after-change": ["kubelet", "socket", "containerd", "config", "runtime", "restart", "systemd", "service"],
};

test("each node and control-plane Incident's title, page and brief name no command and no cause", () => {
  for (const [slug, causes] of Object.entries(INCIDENT_CAUSES)) {
    const inc = incidentBySlug(slug)!;
    expect(inc, slug).toBeDefined();
    for (const [where, text] of [["title", inc.title], ["page", inc.page], ["brief", inc.brief]] as const) {
      for (const word of [...COMMAND_NAMES, ...causes]) expect(new RegExp(`\\b${word}`, "i").test(text), `${slug} ${where} mentions "${word}": ${text}`).toBe(false);
    }
    // The shown text is not a command block either.
    expect(inc.brief).not.toContain("```");
  }
});

test("the control: the cause words are the ones the hints and the fix do use, so the check above can fail", () => {
  for (const [slug, causes] of Object.entries(INCIDENT_CAUSES)) {
    const inc = incidentBySlug(slug)!;
    const later = [...inc.hints, inc.fix, inc.debrief].join("\n").toLowerCase();
    expect(causes.some((w) => later.includes(w)), slug).toBe(true);
    expect(COMMAND_NAMES.some((w) => new RegExp(`\\b${w}\\b`).test(later)), slug).toBe(true);
  }
});

test("the host Incidents are solved from the terminal: no hint or fix sends the Learner to the Cluster View", () => {
  for (const slug of Object.keys(INCIDENT_CAUSES)) {
    const inc = incidentBySlug(slug)!;
    for (const text of [...inc.hints, inc.fix, ...(inc.start ?? [])]) expect(/cluster view|canvas|diagram|inspector|click|drag/i.test(text), `${slug}: ${text}`).toBe(false);
  }
});

// ---------------------------------------------------------------- every Incident's title is a symptom (practice rule: nothing names the cause before the first Hint)

/** Cause words of the shop Incidents, as their hints and fixes use them. The title, like the page, says how it looks. */
const SHOP_INCIDENT_CAUSES: Record<string, string[]> = {
  "lost-password": ["secret", "password", "credential", "auth"],
  "lost-endpoints": ["service", "selector", "endpoint", "label"],
  "bad-config": ["config", "env", "host"],
  "locked-out": ["policy", "networkpolicy"],
  "cache-crashloop": ["probe", "liveness"],
  "node-down": ["node", "power", "reschedul"],
  "scaled-to-zero": ["scale", "replicas", "zero"],
  "wrong-target-port": ["target", "port"],
  "bad-image-tag": ["image", "tag"],
  "deleted-db-service": ["service", "deleted", "headless"],
  "renamed-secret-key": ["secret", "renamed", "key"],
  "drained-nodes": ["drain", "cordon", "unschedulable", "taint"],
  "dns-scaled-down": ["dns", "coredns"],
  "db-too-big": ["memory", "request", "resources"],
  "dns-egress": ["dns", "egress", "policy"],
  "quota-limits": ["quota", "limits"],
};

test("all 22 Incident titles are symptoms: none names a cause or a command", () => {
  const all = { ...SHOP_INCIDENT_CAUSES, ...INCIDENT_CAUSES };
  expect(Object.keys(all).sort()).toEqual(INCIDENTS.map((i) => i.slug).sort()); // every Incident is covered, so a new one cannot skip the check
  for (const inc of INCIDENTS) {
    for (const word of [...COMMAND_NAMES, ...all[inc.slug]]) expect(new RegExp(`\\b${word}`, "i").test(inc.title), `${inc.slug} title mentions "${word}": ${inc.title}`).toBe(false);
  }
});

test("the control: those cause words are the ones each Incident's hints, fix or debrief use, so the title check can fail", () => {
  const all = { ...SHOP_INCIDENT_CAUSES, ...INCIDENT_CAUSES };
  for (const inc of INCIDENTS) {
    const later = [...inc.hints, inc.fix, inc.debrief].join("\n").toLowerCase();
    expect(all[inc.slug].some((w) => later.includes(w)), inc.slug).toBe(true);
  }
});

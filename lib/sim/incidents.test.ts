import { expect, test } from "bun:test";
import { Cluster, type Pod } from "@/lib/engine";
import * as A from "./actions";
import { MANIFEST_DIR } from "@/lib/engine/host";
import { runKubectl } from "@/lib/kubectl/kubectl";
import { newShell } from "@/lib/kubectl/shell";
import { INCIDENTS, RESOLVE_MS, dailyIncident, incidentBySlug, shopProblem, shopTraffic, shopYaml, type Incident } from "./incidents";
import { SimStore } from "./useSimulation";

/** The healthy shop, as the Incident player builds it: seed 11, or 1000 + the day for the Daily Incident. */
function healthyShop(seed = 11, inc?: Incident) {
  const s = new SimStore();
  s.cluster = new Cluster({ seed, systemPods: true, ...(inc?.nodes ? { nodes: inc.nodes } : {}) });
  s.apply(shopYaml(), "shop.yaml");
  s.cluster.advance(60_000);
  return s;
}

/** Advances in steps until the shop is healthy (or the time runs out); returns how long it took. */
function untilHealthy(c: Cluster, maxMs: number): number | null {
  for (let t = 0; t <= maxMs; t += 1000) {
    if (shopProblem(c) === null) return t;
    c.advance(1000);
  }
  return null;
}

/** Breaks the shop and checks that customers notice: requests fail, or none get through. */
function broken(inc: Incident, seed?: number) {
  const s = healthyShop(seed);
  const c = s.cluster!;
  expect(shopProblem(c)).toBeNull();
  inc.break(c);
  c.advance(60_000);
  expect(shopProblem(c)).not.toBeNull();
  const t = shopTraffic(c);
  expect(t.rps === 0 || t.err > 0.5).toBe(true);
  return s;
}

const blocks = (inc: Incident, lang: string) => [...inc.fix.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```", "g"))].map((m) => m[1]);

// The Incidents that break a Node or the control plane (inc.nodes) keep the shop serving; they are tested below, against their captures.
for (const inc of INCIDENTS.filter((i) => !i.nodes)) {
  for (const seed of [11, 1001]) {
    test(`incident ${inc.slug} (seed ${seed}): breaks the shop, and its fix resolves it`, () => {
      const s = broken(inc, seed);
      const c = s.cluster!;
      if (inc.slug === "node-down") {
        const node = c.get<Pod>("Pod", "default", "shop-db-0").spec!.nodeName!;
        s.run((cl) => A.chaosRecover(cl, node));
      } else {
        const cmds = blocks(inc, "bash").flatMap((b) => b.split("\n"));
        expect(cmds.length).toBeGreaterThan(0);
        for (const cmd of cmds) expect([cmd, s.exec(cmd)?.ok]).toEqual([cmd, true]);
      }
      expect(untilHealthy(c, 180_000)).not.toBeNull();
    });
  }
  // The "or, better" manifests in a fix work on their own, too.
  for (const yaml of blocks(inc, "yaml")) {
    test(`incident ${inc.slug}: the manifest in its fix resolves it`, () => {
      const s = broken(inc);
      expect(s.apply(yaml, "fix.yaml")?.ok).toBe(true);
      expect(untilHealthy(s.cluster!, 180_000)).not.toBeNull();
    });
  }
}

test("every incident has its own slug and a full write-up", () => {
  expect(new Set(INCIDENTS.map((i) => i.slug)).size).toBe(INCIDENTS.length);
  for (const i of INCIDENTS) for (const f of [i.title, i.page, i.brief, i.fix, i.debrief]) expect(f.length).toBeGreaterThan(0);
  for (const i of INCIDENTS) expect(i.hints.length).toBeGreaterThanOrEqual(3);
});

// ---------------------------------------------------------------- node and control-plane Incidents (ADR 0003)
// Each expectation cites the scenario of docs/research/real-cluster-captures-control-plane.md it reproduces.

const HOST_SLUGS = ["node-not-ready", "node-lost-after-reboot", "pods-stuck-pending", "cluster-unreachable", "scale-does-nothing", "node-notready-after-change"];
const REFUSED = "The connection to the server controlplane:6443 was refused - did you specify the right host or port?";

/** kubectl from the base terminal (no Node login), which is where a Learner starts. */
const kubectl = (s: SimStore, line: string) => runKubectl({ cluster: s.cluster!, namespace: "default", files: {}, shell: newShell() }, line);
const nodeStatus = (s: SimStore, node: string) => kubectl(s, `kubectl get node ${node} --no-headers`).out.split(/\s+/)[1];
/** Seconds until `done`, or -1 after `limit`. */
const until = (s: SimStore, done: () => boolean, limit: number) => {
  for (let t = 0; t <= limit; t++) {
    if (done()) return t;
    s.cluster!.advance(1000);
  }
  return -1;
};

/** The edit a Learner makes in the Editor for each `vi <path>` line of a fix. */
const VI_EDITS: Record<string, [string, string][]> = {
  "pods-stuck-pending": [["schedulr.conf", "scheduler.conf"]],
  "cluster-unreachable": [["https://127.0.0.1:2399", "https://127.0.0.1:2379"]],
  "node-notready-after-change": [["containerd.sockk", "containerd.sock"]],
};

/** Types an Incident's fix, line by line, through the store (a `vi` line opens the Editor, where the edit is made and saved). */
function runFix(s: SimStore, inc: Incident, skip: (line: string) => boolean = () => false) {
  const lines = blocks(inc, "bash").flatMap((b) => b.split("\n"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    if (skip(line)) continue;
    expect([line, s.exec(line)?.ok]).toEqual([line, true]);
    if (line.startsWith("vi ")) {
      let text = s.buffer;
      for (const [from, to] of VI_EDITS[inc.slug]) {
        expect(text).toContain(from);
        text = text.replace(from, to);
      }
      s.setBuffer(text);
      s.exitEditor(true);
    }
  }
}

/** Seconds from now until the shop is healthy, which it then stays for the whole of RESOLVE_MS (what the player needs to call it resolved). */
function resolvedAfter(s: SimStore, limitS: number) {
  const took = until(s, () => shopProblem(s.cluster!) === null, limitS);
  expect(took).toBeGreaterThanOrEqual(0);
  for (let t = 0; t < RESOLVE_MS / 1000; t++) {
    s.cluster!.advance(1000);
    expect(shopProblem(s.cluster!)).toBeNull();
  }
  return took;
}

/** Breaks the shop with a host Incident and checks the player would see it: the shop's own pager reports a problem. */
function brokenHost(slug: string, seed = 11) {
  const inc = incidentBySlug(slug)!;
  const s = healthyShop(seed, inc);
  expect(shopProblem(s.cluster!)).toBeNull();
  const t0 = s.cluster!.now;
  inc.break(s.cluster!);
  // The kubelet picks a changed manifest up within its 5 s scan.
  expect(until(s, () => shopProblem(s.cluster!) !== null, 8)).toBeGreaterThanOrEqual(0);
  return { inc, s, t0 };
}

test("the host Incidents are all here, run on the exam's Nodes, and have 3 to 5 hints", () => {
  expect(INCIDENTS.filter((i) => i.nodes).map((i) => i.slug)).toEqual(HOST_SLUGS);
  for (const slug of HOST_SLUGS) {
    const inc = incidentBySlug(slug)!;
    expect(inc.nodes!.map((n) => n.name)).toEqual(["controlplane", "node01"]);
    expect(inc.hints.length).toBeGreaterThanOrEqual(3);
    expect(inc.hints.length).toBeLessThanOrEqual(5);
  }
});

for (const seed of [11, 1001]) {
  test(`node-not-ready (seed ${seed}): NotReady at ~52 s with the Pods still Running; start kubelet brings it back in seconds (capture Scenario 1)`, () => {
    const { inc, s, t0 } = brokenHost("node-not-ready", seed);
    const c = s.cluster!;
    expect(nodeStatus(s, "node01")).toBe("NotReady"); // after the ~52 s grace, which has passed by the time the Learner arrives
    expect((c.now - t0) / 1000).toBeGreaterThanOrEqual(52);
    expect((c.now - t0) / 1000).toBeLessThan(300); // well before the Pods are evicted
    expect(kubectl(s, "kubectl get pods --no-headers").out).not.toContain("Pending"); // captured: Pods stay 1/1 Running until eviction
    expect(kubectl(s, "kubectl get pods --no-headers").out).toContain("1/1");
    runFix(s, inc);
    expect(resolvedAfter(s, 10)).toBeLessThanOrEqual(10); // captured: Ready ~3 s
    expect(nodeStatus(s, "node01")).toBe("Ready");
  });

  test(`node-lost-after-reboot (seed ${seed}): disabled and stopped; enable --now resolves it, a plain start does not (capture Scenario 2)`, () => {
    const { s } = brokenHost("node-lost-after-reboot", seed);
    const c = s.cluster!;
    expect(nodeStatus(s, "node01")).toBe("NotReady"); // already, when the Learner arrives
    // A plain start brings the Node back Ready, but the unit is still disabled: it would not survive the next reboot, so it is not resolved.
    const start = (cmd: string) => {
      s.exec("ssh node01");
      s.exec("sudo -i");
      expect(s.exec(cmd)?.ok).toBe(true);
      s.exec("exit");
      s.exec("exit");
    };
    start("systemctl start kubelet");
    expect(until(s, () => nodeStatus(s, "node01") === "Ready", 10)).toBeGreaterThanOrEqual(0);
    c.advance(30_000);
    // The Node is Ready now, so the message must not say it is not reporting in; it is true that it would not rejoin after a restart.
    expect(nodeStatus(s, "node01")).toBe("Ready");
    expect(shopProblem(c)).toBe("A Node would not rejoin after a restart.");
    start("systemctl enable kubelet");
    expect(shopProblem(c)).toBeNull();
  });

  test(`node-lost-after-reboot (seed ${seed}): its fix resolves it, Ready within 3 s (capture Scenario 2)`, () => {
    const { inc, s } = brokenHost("node-lost-after-reboot", seed);
    const c = s.cluster!;
    expect(nodeStatus(s, "node01")).toBe("NotReady"); // already, when the Learner arrives
    expect(blocks(inc, "bash")[0]).toContain("systemctl enable --now kubelet");
    runFix(s, inc);
    const ready = until(s, () => nodeStatus(s, "node01") === "Ready", 10);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(ready).toBeLessThanOrEqual(3);
    expect(resolvedAfter(s, 10)).toBeLessThanOrEqual(10);
    expect(kubectl(s, "kubectl get node node01").ok).toBe(true);
    expect(c.state.hosts.node01.services.kubelet.enabled).toBe(true);
  });

  test(`pods-stuck-pending (seed ${seed}): new Pods stay Pending with no events, the scheduler crash-loops; fixing its manifest resolves it (capture 3c)`, () => {
    const { inc, s } = brokenHost("pods-stuck-pending", seed);
    expect(until(s, () => kubectl(s, "kubectl get pods -n kube-system --no-headers").out.includes("kube-scheduler-controlplane") && /CrashLoopBackOff/.test(kubectl(s, "kubectl get pods -n kube-system --no-headers").out), 60)).toBeGreaterThanOrEqual(0);
    const pods = kubectl(s, "kubectl get pods -l app=shop-web --no-headers").out.split("\n");
    expect(pods.filter((l) => /\s0\/1\s+Pending\s/.test(l)).length).toBe(2); // 3 running, scaled to 5
    expect(pods.filter((l) => /\s1\/1\s+Running\s/.test(l)).length).toBe(3);
    const pending = pods.find((l) => l.includes("Pending"))!.split(/\s+/)[0];
    expect(kubectl(s, `kubectl describe pod ${pending}`).out).toMatch(/Events:\s+<none>\s*$/); // captured: no events
    runFix(s, inc);
    expect(resolvedAfter(s, 45)).toBeLessThanOrEqual(45); // captured: scheduler 1/1 in 26 s, a waiting Pod Running ~6 s after
    expect(kubectl(s, "kubectl get pods -l app=shop-web --no-headers").out).not.toContain("Pending");
  });

  test(`cluster-unreachable (seed ${seed}): kubectl is refused within seconds while the shop keeps serving; fixing the manifest resolves it in ~22 s (capture 4a)`, () => {
    const { inc, s } = brokenHost("cluster-unreachable", seed);
    expect(until(s, () => kubectl(s, "kubectl get nodes").out === REFUSED, 8)).toBeGreaterThanOrEqual(0);
    expect(shopProblem(s.cluster!)).toBe("The cluster isn't answering."); // what the pager says: a symptom, not the cause
    s.cluster!.advance(60_000);
    expect(kubectl(s, "kubectl get nodes")).toEqual({ out: REFUSED, ok: false });
    expect(shopTraffic(s.cluster!).err).toBeLessThan(0.01); // the Pods that run keep serving
    runFix(s, inc);
    expect(resolvedAfter(s, 40)).toBeLessThanOrEqual(30); // captured: kubectl works ~22 s after the fix
    expect(kubectl(s, "kubectl get nodes").ok).toBe(true);
  });

  test(`scale-does-nothing (seed ${seed}): the scale is accepted, 2/4 with no Pending Pod and no controller-manager; putting the manifest back resolves it (capture Scenario 5)`, () => {
    const { inc, s } = brokenHost("scale-does-nothing", seed);
    s.cluster!.advance(40_000);
    expect(kubectl(s, "kubectl get deploy shop-api --no-headers").out.replace(/\s+/g, " ")).toStartWith("shop-api 2/4 2 2 "); // captured: 1/3, UP-TO-DATE unchanged
    expect(kubectl(s, "kubectl get pods --no-headers").out).not.toContain("Pending");
    expect(kubectl(s, "kubectl get pods -n kube-system -l component=kube-controller-manager --no-headers").out).toBe("No resources found in kube-system namespace.");
    expect(s.cluster!.state.hosts.controlplane.files[`${MANIFEST_DIR}/kube-controller-manager.yaml`]).toBeUndefined();
    runFix(s, inc);
    expect(resolvedAfter(s, 40)).toBeLessThanOrEqual(35); // captured: Pods ~21 s after the manifest is back
    expect(kubectl(s, "kubectl get deploy shop-api --no-headers").out.replace(/\s+/g, " ")).toStartWith("shop-api 4/4 ");
  });

  test(`node-notready-after-change (seed ${seed}): the kubelet crash-restarts on the wrong socket, NotReady at ~51 s, Pods still run; fixing config.yaml and restarting resolves it (capture Scenario 6)`, () => {
    const { inc, s, t0 } = brokenHost("node-notready-after-change", seed);
    const c = s.cluster!;
    expect(c.state.hosts.node01.services.kubelet.active).toBe("activating");
    expect(nodeStatus(s, "node01")).toBe("NotReady");
    expect((c.now - t0) / 1000).toBeGreaterThanOrEqual(51);
    expect((c.now - t0) / 1000).toBeLessThan(300);
    expect(kubectl(s, "kubectl get pods --no-headers").out).not.toContain("Pending");
    runFix(s, inc);
    expect(resolvedAfter(s, 12)).toBeLessThanOrEqual(12); // captured: Ready ~4 s
    expect(nodeStatus(s, "node01")).toBe("Ready");
  });
}

test("a fix that leaves out the edit does not resolve a host Incident", () => {
  for (const [slug, node] of [["pods-stuck-pending", "controlplane"], ["cluster-unreachable", "controlplane"], ["node-notready-after-change", "node01"]]) {
    const { s } = brokenHost(slug);
    s.exec(`ssh ${node}`);
    s.exec("sudo -i");
    if (slug === "node-notready-after-change") s.exec("systemctl restart kubelet"); // restarts it on the same wrong socket
    s.cluster!.advance(90_000);
    expect(shopProblem(s.cluster!), slug).not.toBeNull();
  }
});

test("a controller-manager or scheduler that is not running is a problem even when nothing is waiting on it", () => {
  for (const file of ["kube-controller-manager.yaml", "kube-scheduler.yaml"]) {
    const s = healthyShop(11, incidentBySlug("scale-does-nothing"));
    const host = s.cluster!.state.hosts.controlplane;
    host.files[`/tmp/${file}`] = host.files[`${MANIFEST_DIR}/${file}`];
    delete host.files[`${MANIFEST_DIR}/${file}`];
    s.cluster!.hostChanged();
    expect(until(s, () => shopProblem(s.cluster!) !== null, 10), file).toBeGreaterThanOrEqual(0);
  }
});

test("the Daily Incident is the same all day and changes the next day", () => {
  const day = Date.UTC(2026, 10, 3, 1);
  expect(dailyIncident(day).incident.slug).toBe(dailyIncident(day + 20 * 3600_000).incident.slug);
  expect(dailyIncident(day).incident.slug).not.toBe(dailyIncident(day + 86_400_000).incident.slug);
  expect(dailyIncident(Date.UTC(2026, 9, 30, 12)).n).toBe(1);
});

test("the Daily Incident goes through every incident before repeating", () => {
  const seen = new Set<string>();
  for (let d = 0; d < INCIDENTS.length; d++) seen.add(dailyIncident(Date.UTC(2026, 9, 30, 12) + d * 86_400_000).incident.slug);
  expect(seen.size).toBe(INCIDENTS.length);
});

// What each page says must already be what the Learner's first command shows (no waiting for the grace period or a scan).
const PAGE_SYMPTOMS: [string, string, (out: string) => boolean][] = [
  ["node-not-ready", "kubectl get nodes", (o) => /node01\s+NotReady/.test(o)],
  ["node-lost-after-reboot", "kubectl get nodes", (o) => /node01\s+NotReady/.test(o)],
  ["node-notready-after-change", "kubectl get nodes", (o) => /node01\s+NotReady/.test(o)],
  ["pods-stuck-pending", "kubectl get pods -l app=shop-web", (o) => /0\/1\s+Pending/.test(o)],
  ["cluster-unreachable", "kubectl get nodes", (o) => o === REFUSED],
  ["scale-does-nothing", "kubectl get deployments", (o) => /shop-api\s+2\/4/.test(o)],
];

test("right after break(), the symptom each page names is what the Learner's first command shows", () => {
  expect(PAGE_SYMPTOMS.map((p) => p[0]).sort()).toEqual([...HOST_SLUGS].sort());
  for (const [slug, cmd, shows] of PAGE_SYMPTOMS) {
    const inc = incidentBySlug(slug)!;
    const s = healthyShop(11, inc);
    inc.break(s.cluster!);
    const out = s.exec(cmd)!.out; // through the store, as the terminal runs it
    expect(shows(out), `${slug}: ${cmd}\n${out}`).toBe(true);
    // The Pods that were running still are, except where the page says Pods are Pending.
    if (slug !== "cluster-unreachable") expect(s.exec("kubectl get pods --no-headers")!.out).toContain("1/1");
  }
  // control: the same commands on the healthy shop do not show these symptoms
  const healthy = healthyShop(11, incidentBySlug("node-not-ready"));
  expect(healthy.exec("kubectl get nodes")!.out).not.toMatch(/NotReady/);
});

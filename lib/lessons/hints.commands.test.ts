// Every command a Challenge's hints name has to work in the simulator, and its output has to hold what
// the next rung says it shows. Each Challenge is set up the way the player does (seed 7, system Pods,
// the Challenge's own warm-up), then every command in `start` and every `kubectl …`, `curl …` or `wget …`
// in a hint runs against it.
import { describe, expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { runKubectl } from "@/lib/kubectl/kubectl";
import { CHALLENGES } from "./challenges";
import { START_COMMANDS } from "./hints";
import { replaySteps } from "./replay";

interface Probe {
  /** The command exactly as a hint (or the Challenge's start list) writes it. */
  cmd: string;
  /** What the output must contain: strings, or a regex. */
  has: (string | RegExp)[];
  /** The command is expected to exit non-zero, as a symptom or a "no" answer does. */
  fails?: boolean;
  /** Solve this many goals first, for a hint written for the cluster as it is by then. */
  after?: number;
}

const PROBES: Record<string, Probe[]> = {
  "typo-image": [{ cmd: "kubectl describe pods -l app=web", has: ['Failed to pull image "nginx:stabel"', "ImagePullBackOff"] }],
  "service-selector": [
    { cmd: "kubectl describe svc api", has: ["app=api-server", "<none>"] },
    { cmd: "kubectl get pods --show-labels", has: ["app=api,"] },
  ],
  "missing-configmap": [
    { cmd: "kubectl get pods", has: ["CreateContainerConfigError"] },
    { cmd: "kubectl describe pods -l app=frontend", has: ['configmap "frontend-config" not found'] },
  ],
  "postgres-password": [{ cmd: "kubectl logs deploy/db --previous", has: ["superuser password is not specified", "POSTGRES_PASSWORD"] }],
  "readiness-wrong-port": [
    { cmd: "kubectl describe pods -l app=web", has: ["Readiness probe failed", ":8080/", "connection refused"] },
    { cmd: "kubectl get endpoints web", has: ["<none>"] },
  ],
  "oversized-request": [
    { cmd: "kubectl describe pods -l app=report", has: ["Insufficient cpu", /cpu:\s+6\b/] },
    { cmd: "kubectl describe nodes", has: ["Allocatable"] },
  ],
  "wrong-storageclass": [
    { cmd: "kubectl describe pvc data", has: ['storageclass.storage.k8s.io "fast-ssd" not found'] },
    { cmd: "kubectl get storageclass", has: ["standard"] },
  ],
  "forbidden-sa": [
    { cmd: "kubectl auth can-i patch deployments -n apps --as=system:serviceaccount:apps:deployer", has: ["no"], fails: true },
    { cmd: "kubectl describe rolebinding deployer-binding -n apps", has: [/ServiceAccount\s+deployer\s+default/] },
  ],
  "egress-dns": [
    { cmd: "kubectl exec deploy/frontend -- nslookup backend", has: ["timed out"], fails: true },
    { cmd: "kubectl describe networkpolicy frontend-egress", has: ["app=backend", "80/TCP"] },
    { cmd: "kubectl get pods -n kube-system --show-labels", has: ["k8s-app=kube-dns"] },
  ],
  "after-maintenance": [
    { cmd: "kubectl get nodes", has: ["Ready,SchedulingDisabled"] },
    { cmd: "kubectl describe node worker-1", has: ["maintenance=true:NoSchedule"] },
    { cmd: "kubectl describe node worker-2", has: ["Unschedulable:      true"] },
    { cmd: "kubectl describe pods -l app=web", has: ["1 node(s) were unschedulable", "2 node(s) had untolerated taint(s)"] },
  ],
  "secret-wrong-key": [
    { cmd: "kubectl describe pods -l app=payments", has: ["couldn't find key password in Secret default/payments-db"] },
    { cmd: "kubectl describe secret payments-db", has: ["username", "db-password"] },
  ],
  "oom-resizer": [{ cmd: "kubectl describe pods -l app=resizer", has: ["Last State", "OOMKilled", /memory:\s+100Mi/] }],
  "failed-backfill": [
    { cmd: "kubectl logs job/backfill", has: ["BACKFILL_FROM is not set (expected a date such as 2026-01-01)"] },
    { cmd: "kubectl get job backfill -o yaml", has: ["kind: Job", "BACKFILL_FROM"] },
  ],
  "cronjob-never-runs": [{ cmd: "kubectl get cronjob cleanup", has: ["0 */5 * * *", /SUSPEND[\s\S]*True/] }],
  "cache-emptydir": [{ cmd: "kubectl describe deployment cache", has: ["EmptyDir"] }],
  "cronjob-stuck-run": [
    { cmd: "kubectl get cronjob,jobs,pods", has: ["Running"] },
    { cmd: "kubectl describe cronjob report", has: ["Not starting job because prior execution is running and concurrency policy is Forbid"] },
    { cmd: "kubectl explain cronjob.spec.concurrencyPolicy", has: ["Forbid", "Replace"] },
    { cmd: "kubectl explain job.spec.activeDeadlineSeconds", has: ["Seconds the Job may run"] },
  ],
  "configmap-subpath": [
    { cmd: "kubectl exec deploy/site -- cat /usr/share/nginx/html/index.html", has: ["Spring sale"] },
    { cmd: "kubectl get configmap site-content -o yaml", has: ["Summer sale"] },
    { cmd: "kubectl describe pods -l app=site", has: ['(rw,path="index.html")'] },
  ],
  "nodeselector-typo": [
    { cmd: "kubectl describe pods -l app=search", has: ["2 node(s) didn't match Pod's node affinity/selector"] },
    { cmd: "kubectl get deployment search -o yaml", has: ["disktype: sdd"] },
    { cmd: "kubectl get nodes --show-labels", has: ["disktype=ssd"] },
  ],
  "ingress-ignored": [
    { cmd: "curl http://shop.example/", has: ["404 Not Found"] },
    { cmd: "kubectl get ingress", has: ["traefik"] },
    { cmd: "kubectl get ingressclass", has: ["nginx"] },
  ],
  "allow-frontend": [
    { cmd: "kubectl exec deploy/frontend -- wget -qO- --timeout=2 http://api", has: ["timed out"], fails: true },
    { cmd: "kubectl describe networkpolicy default-deny-ingress", has: ["Selected pods are isolated for ingress connectivity"] },
    { cmd: "kubectl get pods --show-labels", has: ["app=frontend"] },
  ],
  "daemonset-tainted-node": [
    { cmd: "kubectl describe node worker-2", has: ["gpu=true:NoSchedule"] },
    { cmd: "kubectl get pods -o wide", has: ["log-agent"] },
  ],
  "hpa-stuck": [
    { cmd: "kubectl get hpa", has: ["<unknown>/50%"] },
    { cmd: "kubectl describe hpa php-apache", has: ["missing request for cpu in container log-shipper"] },
  ],
  "anti-affinity-third-replica": [
    { cmd: "kubectl describe pods -l app=cache", has: ["pod anti-affinity rules"] },
    { cmd: "kubectl get pods -o wide", has: ["Pending"] },
  ],
  "storefront-gateway": [
    { cmd: "curl http://shop.example/", has: ["503 Service Temporarily Unavailable"] },
    { cmd: "kubectl get endpoints -n shop", has: ["<none>"] },
    { cmd: "kubectl describe svc storefront -n shop", has: [/TargetPort:\s+http\/TCP/] },
  ],
  "run-as-nonroot": [{ cmd: "kubectl describe pods -l app=worker", has: ["container has runAsNonRoot and image will run as root"] }],
  "readonly-tmp": [
    { cmd: "kubectl describe pods -l app=agent", has: ["Readiness probe failed", "/tmp/heartbeat", "No such file"] },
    { cmd: "kubectl logs deploy/agent", has: ["can't create /tmp/heartbeat: Read-only file system"] },
  ],
  "node-reader": [
    { cmd: "kubectl api-resources", has: [/\bnodes\s+no\s+v1\s+false\b/] },
    { cmd: "kubectl auth can-i list nodes --as=system:serviceaccount:monitoring:capacity-report", has: ["no"], fails: true },
  ],
  "hardening-rollout": [
    { cmd: "kubectl describe networkpolicy -n shop", has: ["PodSelector:     app=storefront", "To Port: 80/TCP"] },
    { cmd: "kubectl get pods -n shop --show-labels", has: ["app=shop,"] },
    { cmd: "kubectl auth can-i patch deployments.apps -n shop --as=system:serviceaccount:shop:ci", has: ["no"], fails: true },
    { cmd: "kubectl describe role ci-deployer -n shop", has: [/\bdeployments\s+\[\]/] },
    { cmd: "kubectl describe pods -n shop -l app=audit", has: ["container's runAsUser breaks non-root policy"] },
  ],
  "payments-onboarding": [
    { cmd: "kubectl get rolebindings -A", has: [/default\s+payments-devs/] },
    { cmd: "kubectl auth can-i list deployments -n payments --as=alice", has: ["no"], fails: true },
    { cmd: "kubectl describe pods -n payments", has: ['MountVolume.SetUp failed for volume "db" : secret "payments-db" not found'] },
    { cmd: "kubectl get secrets -A", has: [/default\s+payments-db/] },
    { cmd: "kubectl get secret payments-db -o yaml", has: ["password:"] },
    { cmd: "kubectl exec deploy/frontend -- wget -qO- --timeout=2 http://payments-api.payments", has: ["Connection refused"], fails: true, after: 2 },
    { cmd: "kubectl describe svc payments-api -n payments", has: [/TargetPort:\s+8080\/TCP/], after: 2 },
  ],
  "audit-cleanup": [
    { cmd: "kubectl get rolebindings -A", has: ["Role/release", "ClusterRole/release"] },
    { cmd: "kubectl get rolebinding release-bot -n blog -o yaml", has: ["kind: Role"] },
    { cmd: "kubectl get role -n blog", has: ["No resources found"] },
    { cmd: "kubectl get endpoints -n blog", has: ["<none>"] },
    { cmd: "kubectl describe svc blog -n blog", has: ["app=blog,tier=web"] },
    { cmd: "kubectl get pods -n blog --show-labels", has: ["app=blog,"] },
    { cmd: "kubectl describe pods -n blog -l app=comments", has: ["couldn't find key db-password in Secret blog/blog-db"] },
    { cmd: "kubectl describe secret blog-db -n blog", has: ["password:"] },
  ],
};

/** The cluster a Challenge starts from, as the player builds it. */
function fresh(slug: string, after = 0) {
  const ch = CHALLENGES.find((c) => c.slug === slug)!;
  const c = new Cluster({ seed: 7, systemPods: true });
  ch.setup?.(c);
  c.advance(ch.warmupMs ?? 0);
  if (after) replaySteps(ch, c, after);
  return { c, ctx: { cluster: c, namespace: "default" } };
}

/** The `kubectl …`, `curl …` and `wget …` commands a hint writes in code spans. */
const commandsIn = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((s) => /^(kubectl|curl|wget|nslookup) /.test(s));
const READ_ONLY = /^(kubectl (get|describe|logs|exec|auth can-i|top|explain|api-resources)\b|curl |wget |nslookup )/;

describe("the commands a hint names", () => {
  test("PROBES has an entry for every Challenge, and only for Challenges", () => {
    expect(Object.keys(PROBES).sort()).toEqual(CHALLENGES.map((c) => c.slug).sort());
  });

  for (const ch of CHALLENGES) {
    test(`${ch.slug}: every command in a hint is checked, read-only, and shows what the next rung says`, () => {
      const named = new Set<string>(ch.start);
      const inHints = new Set<string>();
      for (const g of ch.steps) for (const h of g.hints) for (const cmd of commandsIn(h)) inHints.add(cmd);
      const probes = PROBES[ch.slug];
      const probed = new Set(probes.map((p) => p.cmd));
      // Nothing a hint names goes unchecked, and nothing is checked that neither a hint nor `start` names.
      for (const cmd of inHints) expect(probed.has(cmd), `${ch.slug}: a hint names "${cmd}" and PROBES does not check it`).toBe(true);
      for (const cmd of inHints) named.add(cmd);
      for (const p of probes) expect(named.has(p.cmd), `${ch.slug}: PROBES checks "${p.cmd}" and no hint names it`).toBe(true);
      const clusters = new Map<number, ReturnType<typeof fresh>>();
      for (const p of probes) {
        expect(p.cmd, `${ch.slug}: ${p.cmd}`).toMatch(READ_ONLY);
        // Read-only commands leave the cluster as it was, so one cluster per starting point is enough.
        if (!clusters.has(p.after ?? 0)) clusters.set(p.after ?? 0, fresh(ch.slug, p.after));
        const { ctx } = clusters.get(p.after ?? 0)!;
        const r = runKubectl(ctx, p.cmd);
        const where = `${ch.slug}: ${p.cmd}\n${r.out.slice(0, 600)}`;
        expect(r.ok, where).toBe(!p.fails);
        for (const want of p.has) {
          if (typeof want === "string") expect(r.out.includes(want), `${where}\n(missing ${JSON.stringify(want)})`).toBe(true);
          else expect(want.test(r.out), `${where}\n(missing ${want})`).toBe(true);
        }
      }
    });

    test(`${ch.slug}: every "where to start" command runs`, () => {
      const { ctx } = fresh(ch.slug);
      for (const cmd of ch.start ?? START_COMMANDS) {
        expect(cmd, ch.slug).toMatch(READ_ONLY);
        const r = runKubectl(ctx, cmd);
        // A symptom (a refused connection, a timeout) fails on purpose; an unknown command or an internal error is a bug.
        expect(r.out.trim(), `${ch.slug}: ${cmd}`).not.toBe("");
        expect(r.out, `${ch.slug}: ${cmd}`).not.toMatch(/unknown command|unsupported|not supported|internal problem|unknown flag|unknown shorthand/i);
      }
    });
  }

  test("the 504 in the storefront ladder is what you get once the Service's targetPort is fixed", () => {
    const { c, ctx } = fresh("storefront-gateway");
    expect(runKubectl(ctx, `kubectl patch service storefront -n shop --type=json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":"web"}]'`).ok).toBe(true);
    c.advance(5000);
    expect(runKubectl(ctx, "curl http://shop.example/").out).toContain("504 Gateway Time-out");
  });
});

// More Challenges (see ../challenges.ts for the format and the rules).
// Workloads, configuration and storage: Secrets, memory limits, Jobs,
// CronJobs, emptyDir vs PersistentVolumeClaims, and ConfigMap volumes.

import type { Cluster, ConfigMap, CronJob, Job, PersistentVolumeClaim, Pod, Secret } from "@/lib/engine";
import { controllerOf, execEnv, jobComplete, nextRun, parseCron } from "@/lib/engine";
import type { Challenge } from "../challenges";
import { dep, deployment, endpointCount, firstContainer, obj, podsWith, readyCount, rolledOut, service, up } from "../lessons";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The environment the kubelet resolved for a container when it last started. */
const runtimeEnv = (c: Cluster, p: Pod, container: string) => c.state.pods[p.metadata.uid]?.containers[container]?.env;
/** Same keys, same values, in any order. */
const sameData = (a: Record<string, string> | undefined, b: Record<string, string>) =>
  !!a && Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v);

// ---------------------------------------------------------------- payments-secret-key

const PAYMENTS_PASSWORD = "Vault-synced-7f3a";
const PAYMENTS_SECRET = { username: btoa("payments"), "db-password": btoa(PAYMENTS_PASSWORD) };

// ---------------------------------------------------------------- resizer-oom

const RESIZER_ARGS = ["--vm", "1", "--vm-bytes", "150M", "--vm-hang", "1"];

// ---------------------------------------------------------------- backfill-job

const BACKFILL_SCRIPT =
  'echo "backfill: starting"; sleep 2; test -n "$BACKFILL_FROM" || echo "backfill: error: BACKFILL_FROM is not set (expected a date such as 2026-01-01)"; test -n "$BACKFILL_FROM" && echo "backfill: copying orders since $BACKFILL_FROM" && echo "backfill: done"';

const BACKFILL_FIXED = `apiVersion: batch/v1
kind: Job
metadata:
  name: backfill
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: backfill
        image: busybox:1.36
        command: ["sh", "-c", ${JSON.stringify(BACKFILL_SCRIPT)}]
        env:
        - name: BACKFILL_FROM
          value: "2026-01-01"
`;

// ---------------------------------------------------------------- cronjob-suspended

const CLEANUP_SCRIPT = 'echo "deleting sessions idle for more than 24h"; sleep 3; echo "deleted 1832 expired sessions"';

/** The schedule fires exactly every 5 minutes, checked over the next hour. */
const everyFiveMinutes = (c: Cluster, cj: CronJob) => {
  const cron = parseCron(cj.spec!.schedule);
  if (!cron) return false;
  let t: number | undefined = c.now;
  let prev: number | undefined;
  for (let i = 0; i < 13; i++) {
    t = nextRun(cron, t!, cj.spec!.timeZone);
    if (t === undefined || (prev !== undefined && t - prev !== 300_000)) return false;
    prev = t;
  }
  return true;
};

// ---------------------------------------------------------------- cache-emptydir

const CACHE_CLAIM = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cache-data
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`;

/** The volume a Pod spec mounts at /data in its first container. */
const dataVolume = (spec?: Pod["spec"]) => {
  const m = spec?.containers[0]?.volumeMounts?.find((x) => x.mountPath.replace(/\/+$/, "") === "/data" && !x.subPath);
  return m && spec?.volumes?.find((v) => v.name === m.name);
};

// ---------------------------------------------------------------- cronjob-stuck-run

const REPORT_OLD = 'echo "report: connecting to reports-db-legacy"; until wget -q -O- http://reports-db-legacy/healthz; do echo "report: reports-db-legacy not reachable, retrying in 10s"; sleep 10; done; echo "report: done"';
const REPORT_NEW = 'echo "report: building the daily report from reports-db"; sleep 5; echo "report: done"';

const reportJobs = (c: Cluster, cj: CronJob) => c.list<Job>("Job").filter((j) => controllerOf(j)?.uid === cj.metadata.uid);
const runningFor = (c: Cluster, j: Job) => (jobComplete(j) || (j.status?.conditions ?? []).some((x) => x.type === "Failed" && x.status === "True") ? 0 : c.now - j.metadata.creationTimestamp);

// ---------------------------------------------------------------- configmap-subpath

const SPRING_PAGE = "<h1>Spring sale: 20% off</h1>\n";
const SUMMER_PAGE = "<h1>Summer sale: 30% off everything</h1>\n";
const SITE_INDEX = "/usr/share/nginx/html/index.html";

/** What nginx in this Pod serves at `/` right now. */
const servedPage = (c: Cluster, p: Pod) => {
  const ct = p.spec?.containers[0];
  if (!ct) return undefined;
  return execEnv(c, p, ct, runtimeEnv(c, p, ct.name) ?? {}, { quiet: true }).fs.read(SITE_INDEX);
};

/** index.html comes from the site-content ConfigMap through a whole-volume mount (no subPath), so edits reach it. */
const liveMounted = (p: Pod) => {
  const ct = p.spec?.containers[0];
  const mounts = [...(ct?.volumeMounts ?? [])].sort((a, b) => b.mountPath.length - a.mountPath.length);
  const m = mounts.find((x) => {
    const mp = x.mountPath.replace(/\/+$/, "");
    return SITE_INDEX === mp || SITE_INDEX.startsWith(mp + "/");
  });
  if (!m || m.subPath) return false;
  const v = p.spec?.volumes?.find((x) => x.name === m.name);
  if (v?.configMap?.name !== "site-content") return false;
  const rel = SITE_INDEX.slice(m.mountPath.replace(/\/+$/, "").length + 1);
  return v.configMap.items ? v.configMap.items.some((i) => i.key === "index.html" && i.path === rel) : rel === "index.html";
};

const SITE_LIVE_MOUNT = `kubectl patch deployment site --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/volumeMounts","value":[{"name":"content","mountPath":"/usr/share/nginx/html"}]}]'`;

// ---------------------------------------------------------------- the Challenges

export const WORKLOADS_CHALLENGES: Challenge[] = [
  {
    slug: "secret-wrong-key",
    start: ["kubectl get pods", "kubectl describe secret payments-db"],
    difficulty: "easy",
    track: "config",
    title: "Never got started",
    summary: "A new Deployment whose containers are never created.",
    brief: "The new `payments` Deployment went out an hour ago and neither of its Pods has started a container yet. Its database credentials live in the Secret `payments-db`, which is synced from Vault and is correct: don't edit it.",
    minutes: 5,
    concepts: ["Secret", "secretKeyRef", "CreateContainerConfigError"],
    setup: (c) => {
      c.create({ apiVersion: "v1", kind: "Secret", metadata: { name: "payments-db" }, type: "Opaque", data: { ...PAYMENTS_SECRET } } as never);
      deployment(c, "payments", "nginx:1.27", 2, "default", {
        env: [
          { name: "DB_USER", valueFrom: { secretKeyRef: { name: "payments-db", key: "username" } } },
          { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "payments-db", key: "password" } } },
        ],
      });
    },
    warmupMs: 20_000,
    steps: [
      {
        title: "payments running with the password from payments-db",
        body: "Both `payments` Pods are Running and Ready, `DB_PASSWORD` in them is the password stored in the Secret `payments-db`, and the Secret is unchanged.",
        check: (x) => {
          const ct = firstContainer(dep(x.cluster, "payments"));
          const ref = ct?.env?.find((e) => e.name === "DB_PASSWORD")?.valueFrom?.secretKeyRef;
          const secret = obj<Secret>(x.cluster, "Secret", "payments-db");
          const pods = podsWith(x.cluster, "app", "payments").filter(up);
          return (
            ref?.name === "payments-db" &&
            sameData(secret?.data, PAYMENTS_SECRET) &&
            rolledOut(x.cluster, "payments") &&
            pods.length === 2 &&
            pods.every((p) => runtimeEnv(x.cluster, p, "payments")?.DB_PASSWORD === PAYMENTS_PASSWORD)
          );
        },
        hints: [
          "No container has started, although the image was pulled. So the Pods fail while the kubelet assembles the container's configuration. Look at what the kubelet says it couldn't do.",
          "`kubectl describe pods -l app=payments` shows the Events. `kubectl describe secret payments-db` lists the keys in the Secret, with sizes only.",
          "The warning says `couldn't find key password in Secret default/payments-db`. The Secret holds `username` and `db-password`. The Deployment asks for a key the Secret doesn't have, and the Secret itself is right, as the brief says.",
          "Change the key that the Deployment's `DB_PASSWORD` variable refers to, so it names a key the Secret has. Leave the Secret alone.",
        ],
        solution: { commands: [`kubectl patch deployment payments -p '{"spec":{"template":{"spec":{"containers":[{"name":"payments","env":[{"name":"DB_PASSWORD","valueFrom":{"secretKeyRef":{"name":"payments-db","key":"db-password"}}}]}]}}}}'`] },
      },
    ],
  },
  {
    slug: "oom-resizer",
    difficulty: "easy",
    track: "config",
    title: "Restarting for no reason",
    summary: "Workers that restart every few seconds while their logs look fine.",
    brief: "The `resizer` workers restart every few seconds and never finish a job, but their logs show nothing wrong. Nothing in the code changed. Don't change what the workers run, and keep a memory limit on them: that's platform policy.",
    minutes: 4,
    concepts: ["OOMKilled", "Memory limits", "kubectl describe"],
    setup: (c) => deployment(c, "resizer", "polinux/stress", 2, "default", { args: RESIZER_ARGS, resources: { requests: { memory: "50Mi" }, limits: { memory: "100Mi" } } }),
    warmupMs: 30_000,
    steps: [
      {
        title: "Both resizer Pods Running, with a memory limit",
        body: "Both `resizer` Pods are Running and Ready, they run the same command as before, and the container still has a memory limit.",
        check: (x) => {
          const ct = firstContainer(dep(x.cluster, "resizer"));
          return !!ct?.resources?.limits?.memory && same(ct.args, RESIZER_ARGS) && rolledOut(x.cluster, "resizer") && readyCount(x.cluster, "resizer") === 2;
        },
        hints: [
          "The workers restart again and again but log no error, so the program isn't failing by itself. Something outside it ends the container. Look at how the last run of a container ended.",
          "`kubectl describe pods -l app=resizer` shows the container's `Last State`, and its limits.",
          "`Last State: Terminated` with `Reason: OOMKilled`: the kernel killed the container for going over its memory limit. The limit is 100Mi, and the worker's args ask it to allocate 150M.",
          "You can't change what the workers run, so change what they're allowed to use. Raise the memory limit above what the worker allocates, with room to spare, and keep the request at or below the limit.",
        ],
        solution: { commands: ["kubectl set resources deployment resizer --requests=memory=200Mi --limits=memory=256Mi"] },
      },
    ],
  },
  {
    slug: "failed-backfill",
    start: ["kubectl get jobs,pods", "kubectl describe job backfill"],
    difficulty: "medium",
    track: "workloads",
    title: "The backfill failed",
    summary: "A one-off Job that gave up overnight and has to run again.",
    brief: "The one-off `backfill` Job failed overnight and nothing was copied. It has to run once more, under the same name, and succeed, copying orders from 2026-01-01 onwards.",
    minutes: 7,
    concepts: ["Job", "backoffLimit", "Immutable fields"],
    setup: (c) =>
      c.create({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: "backfill" },
        spec: { backoffLimit: 2, template: { spec: { restartPolicy: "Never", containers: [{ name: "backfill", image: "busybox:1.36", command: ["sh", "-c", BACKFILL_SCRIPT] }] } } },
      } as never),
    warmupMs: 60_000,
    steps: [
      {
        title: "backfill completed, from 2026-01-01",
        body: "A Job named `backfill` has completed: one of its Pods ran the backfill script and succeeded with `BACKFILL_FROM=2026-01-01`.",
        check: (x) => {
          const c = x.cluster;
          const job = obj<Job>(c, "Job", "backfill");
          if (!job || !jobComplete(job)) return false;
          return c.list<Pod>("Pod").some(
            (p) =>
              controllerOf(p)?.uid === job.metadata.uid &&
              p.status?.phase === "Succeeded" &&
              same(p.spec?.containers[0]?.command, ["sh", "-c", BACKFILL_SCRIPT]) &&
              runtimeEnv(c, p, p.spec!.containers[0].name)?.BACKFILL_FROM === "2026-01-01",
          );
        },
        hints: [
          "The Job is Failed, which means it used up its retries. Each attempt left a Pod behind, with that attempt's output. Look there for why it failed.",
          "`kubectl logs job/backfill` prints the output of one of the Job's Pods.",
          "The script says `BACKFILL_FROM is not set (expected a date such as 2026-01-01)`, so the container needs that variable. The fields of a Job's Pod template can't be updated after creation, so you can't add it to this Job.",
          "Read the Job's definition, delete the Job, and create a new one under the same name that sets the variable. `kubectl get job backfill -o yaml` prints the current definition to start from.",
        ],
        solution: { commands: ["kubectl delete job backfill"], yaml: BACKFILL_FIXED },
      },
    ],
  },
  {
    slug: "cronjob-never-runs",
    start: ["kubectl get cronjobs", "kubectl get jobs"],
    difficulty: "medium",
    track: "workloads",
    title: "The cleanup never happens",
    summary: "A scheduled job that hasn't run once since it was deployed.",
    brief: "The `cleanup` CronJob is meant to delete expired sessions every 5 minutes. It went out ten minutes ago, no Job has been created yet, and the sessions table keeps growing. Make it run on its intended schedule.",
    minutes: 6,
    concepts: ["CronJob", "Cron schedule", "suspend"],
    setup: (c) =>
      c.create({
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: { name: "cleanup" },
        spec: {
          schedule: "0 */5 * * *",
          suspend: true,
          jobTemplate: { spec: { template: { spec: { restartPolicy: "OnFailure", containers: [{ name: "cleanup", image: "busybox:1.36", command: ["sh", "-c", CLEANUP_SCRIPT] }] } } } },
        },
      } as never),
    warmupMs: 600_000,
    steps: [
      {
        title: "cleanup runs every 5 minutes",
        body: "The `cleanup` CronJob is active, its schedule fires every 5 minutes, and at least one Job it started on schedule has completed.",
        check: (x) => {
          const c = x.cluster;
          const cj = obj<CronJob>(c, "CronJob", "cleanup");
          if (!cj || cj.spec?.suspend || !everyFiveMinutes(c, cj)) return false;
          return c
            .list<Job>("Job")
            .some(
              (j) =>
                controllerOf(j)?.uid === cj.metadata.uid &&
                !!j.metadata.annotations?.["batch.kubernetes.io/cronjob-scheduled-timestamp"] &&
                jobComplete(j) &&
                same(j.spec?.template.spec.containers[0]?.command, ["sh", "-c", CLEANUP_SCRIPT]),
            );
        },
        hints: [
          "No Job has ever been created. A CronJob creates one only when two things hold: it is switched on, and its schedule comes due. Check both.",
          "`kubectl get cronjob cleanup` shows the schedule and whether it is suspended, in the SCHEDULE and SUSPEND columns.",
          "SUSPEND is `True`, so the CronJob starts nothing. The schedule `0 */5 * * *` is also wrong: it means minute 0 of every fifth hour, not every five minutes.",
          "Switch the CronJob on and write a schedule whose minute field means every five minutes. The five fields run minute, hour, day of month, month, day of week. A step value in the minute field does it.",
        ],
        solution: { commands: [`kubectl patch cronjob cleanup -p '{"spec":{"schedule":"*/5 * * * *","suspend":false}}'`] },
      },
    ],
  },
  {
    slug: "cache-emptydir",
    start: ["kubectl get pods,pvc", "kubectl describe deployment cache"],
    difficulty: "medium",
    track: "storage",
    title: "Cold cache after every deploy",
    summary: "A cache that comes back empty whenever its Pod is replaced.",
    brief: "Every time the `cache` Pod is replaced (a deploy, a Node drain, someone deleting it), Redis comes back completely empty and the site is slow for hours while it warms up again. What Redis keeps in `/data` has to survive the Pod being deleted and recreated. Keep `cache` a Deployment with one replica.",
    minutes: 7,
    concepts: ["emptyDir", "PersistentVolumeClaim", "Volumes"],
    setup: (c) => {
      c.create({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "cache", labels: { app: "cache" } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "cache" } },
          template: {
            metadata: { labels: { app: "cache" } },
            spec: { containers: [{ name: "cache", image: "redis:7", volumeMounts: [{ name: "data", mountPath: "/data" }] }], volumes: [{ name: "data", emptyDir: {} }] },
          },
        },
      });
      service(c, "cache", 6379);
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "cache keeps /data on a Bound claim",
        body: "The `cache` Deployment has one Pod, Running and Ready, and what it mounts at `/data` is a PersistentVolumeClaim that is Bound.",
        check: (x) => {
          const c = x.cluster;
          const d = dep(c, "cache");
          const claimOf = (spec?: Pod["spec"]) => dataVolume(spec)?.persistentVolumeClaim?.claimName;
          const bound = (name?: string) => !!name && obj<PersistentVolumeClaim>(c, "PersistentVolumeClaim", name)?.status?.phase === "Bound";
          const pods = podsWith(c, "app", "cache");
          return (d?.spec?.replicas ?? 1) === 1 && bound(claimOf(d?.spec?.template.spec)) && rolledOut(c, "cache") && pods.length === 1 && pods.every((p) => up(p) && bound(claimOf(p.spec)));
        },
        hints: [
          "Redis writes its data to `/data`, and that data goes away when the Pod is replaced. So it matters what kind of storage sits behind that directory, and how long that storage lives. Look at what is mounted there.",
          "`kubectl describe deployment cache` lists the Pod's Volumes.",
          "The volume `data` is of type `EmptyDir`. An emptyDir is deleted for good when its Pod is removed from the Node, so a replacement Pod always starts empty.",
          "Storage that outlives a Pod comes from a PersistentVolumeClaim. Create a claim, then change the Deployment's volume to use it in place of the emptyDir. Wait until the claim is Bound and the new Pod is Ready.",
        ],
        solution: { commands: [`kubectl patch deployment cache --type=json -p '[{"op":"replace","path":"/spec/template/spec/volumes/0","value":{"name":"data","persistentVolumeClaim":{"claimName":"cache-data"}}}]'`], yaml: CACHE_CLAIM },
      },
    ],
  },
  {
    slug: "cronjob-stuck-run",
    start: ["kubectl get cronjob,jobs,pods", "kubectl describe cronjob report"],
    difficulty: "hard",
    track: "workloads",
    title: "No report since this morning",
    summary: "A CronJob that stopped producing runs after one bad night.",
    brief: "The `report` CronJob should build a report every 5 minutes. Last night's database move broke it, and someone fixed its command first thing this morning, but there hasn't been a single new report since. Get it running on schedule again, and make sure that a run that hangs can never again hold the schedule up for more than 5 minutes (without hung runs piling up instead).",
    minutes: 12,
    concepts: ["CronJob", "concurrencyPolicy", "activeDeadlineSeconds", "Job"],
    setup: (c) => {
      c.create({
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: { name: "report" },
        spec: {
          schedule: "*/5 * * * *",
          concurrencyPolicy: "Forbid",
          jobTemplate: { spec: { template: { spec: { restartPolicy: "OnFailure", containers: [{ name: "report", image: "busybox:1.36", command: ["sh", "-c", REPORT_OLD] }] } } } },
        },
      } as never);
      // The 09:05 run starts against the old database and hangs; then the command is fixed.
      c.advance(310_000);
      c.update(c.get<CronJob>("CronJob", "default", "report"), (cj) => void (cj.spec!.jobTemplate.spec.template.spec.containers[0].command = ["sh", "-c", REPORT_NEW]));
    },
    warmupMs: 900_000,
    steps: [
      {
        title: "report runs on schedule again",
        body: "A Job that `report` started on schedule has completed with the fixed command, and no `report` Job has been running for more than 10 minutes.",
        check: (x) => {
          const c = x.cluster;
          const cj = obj<CronJob>(c, "CronJob", "report");
          if (!cj || cj.spec?.suspend) return false;
          const jobs = reportJobs(c, cj);
          const ran = jobs.some((j) => !!j.metadata.annotations?.["batch.kubernetes.io/cronjob-scheduled-timestamp"] && jobComplete(j) && same(j.spec?.template.spec.containers[0]?.command, ["sh", "-c", REPORT_NEW]));
          return ran && jobs.every((j) => runningFor(c, j) <= 600_000);
        },
        hints: [
          "The schedule fires and the command is fixed, yet nothing new appears. The CronJob is choosing not to start runs. Look for something from last night that never finished.",
          "`kubectl get cronjob,jobs,pods` shows what is still running. `kubectl describe cronjob report` shows the CronJob's Events.",
          "One Job from last night is still `Running`, far longer than a run should take. The Events say `Not starting job because prior execution is running and concurrency policy is Forbid`. The old run uses the old command and never ends, so every new run is skipped.",
          "Remove the stuck Job. Deleting its Pod isn't enough: the Job starts another Pod from its own old template. After that, the next scheduled run uses the fixed command.",
        ],
        solution: {
          commands: (c) => {
            const cj = obj<CronJob>(c, "CronJob", "report");
            return cj ? reportJobs(c, cj).filter((j) => runningFor(c, j) > 0).map((j) => `kubectl delete job ${j.metadata.name}`) : [];
          },
        },
      },
      {
        title: "A hung run can't block the schedule again",
        body: "`report` still runs every 5 minutes, and a hung run is stopped within 5 minutes: either each Job has an `activeDeadlineSeconds` of 300 or less, or the CronJob's `concurrencyPolicy` is `Replace`.",
        check: (x) => {
          const cj = obj<CronJob>(x.cluster, "CronJob", "report");
          if (!cj || cj.spec?.suspend || !everyFiveMinutes(x.cluster, cj)) return false;
          const deadline = cj.spec?.jobTemplate.spec.activeDeadlineSeconds;
          return cj.spec?.concurrencyPolicy === "Replace" || (deadline !== undefined && deadline <= 300);
        },
        hints: [
          "One hung run held up every later one. Think about what should happen when a run is still going as the next one comes due. Two settings are involved: what the CronJob does about it, and how long a single run may live.",
          "`kubectl explain cronjob.spec.concurrencyPolicy` and `kubectl explain job.spec.activeDeadlineSeconds` describe the two settings.",
          "`concurrencyPolicy` is `Forbid` here, so a run that never ends blocks every later one. `Replace` swaps a running Job for a new one. `activeDeadlineSeconds` ends any single run after that many seconds.",
          "Use one of the two. If you set a deadline, it goes in the Job template inside the CronJob, and it has to be 300 seconds or less to end a hung run within 5 minutes.",
        ],
        solution: { commands: [`kubectl patch cronjob report -p '{"spec":{"jobTemplate":{"spec":{"activeDeadlineSeconds":240}}}}'`] },
      },
    ],
  },
  {
    slug: "configmap-subpath",
    start: ["kubectl get configmap site-content -o yaml", "kubectl exec deploy/site -- cat /usr/share/nginx/html/index.html"],
    difficulty: "hard",
    track: "config",
    title: "Yesterday's page",
    summary: "An edited page that the site never shows.",
    brief: "Marketing changed the home page in the ConfigMap `site-content` this morning (the new text is correct), but `http://site` still shows the spring sale. They'll keep editing that ConfigMap all summer, and nobody wants to restart Pods every time they do.",
    minutes: 10,
    concepts: ["ConfigMap volumes", "subPath", "Rollout restart"],
    setup: (c) => {
      c.create({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "site-content" }, data: { "index.html": SPRING_PAGE } } as never);
      c.create({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "site", labels: { app: "site" } },
        spec: {
          replicas: 2,
          selector: { matchLabels: { app: "site" } },
          template: {
            metadata: { labels: { app: "site" } },
            spec: {
              containers: [{ name: "site", image: "nginx:1.27", volumeMounts: [{ name: "content", mountPath: SITE_INDEX, subPath: "index.html" }] }],
              volumes: [{ name: "content", configMap: { name: "site-content" } }],
            },
          },
        },
      });
      service(c, "site", 80);
      c.advance(30_000);
      c.update(c.get<ConfigMap>("ConfigMap", "default", "site-content"), (cm) => void (cm.data = { "index.html": SUMMER_PAGE }));
    },
    warmupMs: 90_000,
    steps: [
      {
        title: "The site shows the new page",
        body: "Both `site` Pods are Ready behind the `site` Service and serve the page that's in `site-content` now (the summer sale).",
        check: (x) => {
          const c = x.cluster;
          if (obj<ConfigMap>(c, "ConfigMap", "site-content")?.data?.["index.html"] !== SUMMER_PAGE) return false;
          const pods = podsWith(c, "app", "site").filter(up);
          return pods.length === 2 && endpointCount(c, "site") === 2 && pods.every((p) => servedPage(c, p) === SUMMER_PAGE);
        },
        hints: [
          "The ConfigMap is right and the Pods are Running, yet they serve old text. Compare what the ConfigMap holds with what a Pod can see.",
          "`kubectl exec deploy/site -- cat /usr/share/nginx/html/index.html` shows what a Pod serves. `kubectl get configmap site-content -o yaml` shows what the ConfigMap holds.",
          "The file in the Pod has the spring sale and the ConfigMap holds the summer sale. The Pods read the file when they started, and nothing has refreshed it. A Pod started now would read the current ConfigMap.",
          "Have the Deployment replace its Pods so they start fresh. Use a rollout, not a delete of each Pod by hand.",
        ],
        solution: { commands: ["kubectl rollout restart deployment site"] },
      },
      {
        title: "Future edits go live on their own",
        body: "The `site` Pods mount `site-content` so that later edits reach `index.html` without a restart (within about a minute), and the ConfigMap isn't immutable.",
        check: (x) => {
          const c = x.cluster;
          const cm = obj<ConfigMap>(c, "ConfigMap", "site-content");
          const pods = podsWith(c, "app", "site");
          return !!cm && !(cm as { immutable?: boolean }).immutable && rolledOut(c, "site") && pods.length === 2 && pods.every((p) => up(p) && liveMounted(p));
        },
        hints: [
          "A fresh start fixes today's page, but not the next edit. How a file gets into the container decides whether later changes arrive. Look at how this file is mounted.",
          "`kubectl describe pods -l app=site` lists the Mounts for each container.",
          "The mount line ends in `(rw,path=\"index.html\")`. That `path` is a subPath mount: the file is put in place once, when the container starts. The Kubernetes docs say a container using a ConfigMap as a subPath volume mount will not receive ConfigMap updates.",
          "Mount the whole ConfigMap volume over the html directory instead of one file inside it. The old file mount has to go: an edit or a JSON patch can replace the whole `volumeMounts` list. Then let the Pods roll again.",
        ],
        solution: { commands: [SITE_LIVE_MOUNT] },
      },
    ],
  },
];

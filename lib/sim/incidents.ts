// Incidents: the full-stack shop, serving real traffic, then something breaks and customers
// start seeing errors. The Learner is paged and works against the clock; it's resolved once
// the shop has served cleanly, with everything healthy, for RESOLVE_MS of cluster time.
// A Daily Incident picks one per day, the same for everyone.

import { EXAM_NODES, controlPlaneHealth, type Cluster, type Deployment, type NetworkPolicy, type Node, type NodeConfig, type Pod, type ResourceQuota, type Secret, type Service, type StatefulSet } from "@/lib/engine";
import { KUBELET_CONFIG, MANIFEST_DIR, hostWrite } from "@/lib/engine/host";
import { restartService, setEnabled, stopService } from "@/lib/engine/hostservices";
import { BLUEPRINTS } from "./blueprints";

export const SHOP = "shop";
/** How long the shop must stay healthy before the incident counts as resolved. */
export const RESOLVE_MS = 15_000;
/** The window error rates are measured over. */
const WINDOW_MS = 5_000;

export interface Incident {
  slug: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  /** What the pager says. */
  page: string;
  /** The situation, told the way a colleague would. Prose markdown, like a Challenge brief. */
  brief: string;
  /** Breaks the healthy shop. */
  break(c: Cluster): void;
  /** Hints, each a little more direct than the last. */
  hints: string[];
  /** One way to fix it: commands to run (Prose markdown). */
  fix: string;
  /** What happened, and the lesson it carries, shown once resolved. */
  debrief: string;
  /** The cluster's Nodes, when the Incident works on node hosts (`EXAM_NODES`: `controlplane` and `node01`, ADR 0003 decision 7). Absent: the default cluster. */
  nodes?: NodeConfig[];
  /** The read-only commands the first press of Hint reveals, when the default `kubectl get pods` / events pair is not where this one starts. */
  start?: string[];
}

/** The manifest for the shop, and how to build the cluster an Incident starts from. */
export const shopYaml = () => BLUEPRINTS.find((b) => b.id === "stack")!.yaml(SHOP);

const rollout = (c: Cluster, name: string, cause: string, edit: (spec: Deployment["spec"] & object) => void) => {
  const d = c.get<Deployment>("Deployment", "default", name);
  const spec = structuredClone(d.spec!);
  edit(spec);
  c.replace({ ...d, metadata: { ...d.metadata, annotations: { ...d.metadata.annotations, "kubernetes.io/change-cause": cause } }, spec });
};

/** Edits a file on a Node's host the way a colleague's editor would: the mode stays, and autosave notices. */
const hostEdit = (c: Cluster, node: string, path: string, edit: (text: string) => string) => {
  const host = c.state.hosts[node];
  hostWrite(host, path, edit(host.files[path].content), c.now);
  c.hostChanged();
};

/** Scales a Deployment the way `kubectl scale` does: only `spec.replicas` changes. */
const scale = (c: Cluster, name: string, replicas: number) => {
  const d = c.get<Deployment>("Deployment", "default", name);
  c.update(d, (x) => void (x.spec!.replicas = replicas));
};

/** Time passes before the Learner is paged, so what the page says is already what kubectl shows (capture: NotReady at ~52 s; the Pods are evicted only after another 300 s). */
const settle = (c: Cluster, ms: number) => c.advance(ms);
const NOT_READY_MS = 56_000;

const SCHEDULER_MANIFEST = `${MANIFEST_DIR}/kube-scheduler.yaml`;
const APISERVER_MANIFEST = `${MANIFEST_DIR}/kube-apiserver.yaml`;
const KCM_MANIFEST = `${MANIFEST_DIR}/kube-controller-manager.yaml`;

export const INCIDENTS: Incident[] = [
  {
    slug: "lost-password",
    title: "Every page of the shop fails",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "Someone was tidying up old Secrets this morning. Shortly after, the database Pod restarted, and now every page of the shop fails. The web and API Pods look fine.",
    break: (c) => {
      c.delete("Secret", "default", `${SHOP}-db`);
      c.delete("Pod", "default", `${SHOP}-db-0`, { force: true });
    },
    hints: [
      "Which Pod isn't Running? `kubectl get pods` and look at the STATUS column.",
      "`kubectl describe pod shop-db-0`: the Events at the bottom say what it's missing.",
      "The Pod reads its password from Secret shop-db (envFrom). Create it again with the key POSTGRES_PASSWORD.",
    ],
    fix: "```bash\nkubectl create secret generic shop-db --from-literal=POSTGRES_PASSWORD=change-me\n```",
    debrief:
      "The database Pod couldn't start: its container takes environment variables from Secret shop-db, which had been deleted, so the kubelet stopped at CreateContainerConfigError. Pods only read Secrets when they start, which is why nothing broke until the Pod restarted. Once the Secret existed again, the kubelet retried and Postgres came up.",
  },
  {
    slug: "lost-endpoints",
    title: "The website fails though the API Pods look fine",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "A teammate was preparing a v2 of the API and \"just tweaked the Service\". The API Pods are all Running and Ready, but the website fails on every request.",
    break: (c) => {
      const s = c.get<Service>("Service", "default", `${SHOP}-api`);
      c.replace({ ...s, spec: { ...s.spec, selector: { app: `${SHOP}-api-v2` } } });
    },
    hints: [
      "A Service sends traffic to the Pods its selector matches. `kubectl get endpoints shop-api`: how many does it have?",
      "Compare `kubectl get service shop-api -o wide` (SELECTOR) with `kubectl get pods --show-labels`.",
      "Point the selector back at the Pods' label: app=shop-api.",
    ],
    fix: "```bash\nkubectl patch service shop-api -p '{\"spec\":{\"selector\":{\"app\":\"shop-api\"}}}'\n```",
    debrief:
      "The Service's selector said app=shop-api-v2, and no Pod has that label, so the Service had no endpoints and every connection to it was refused. The Pods were healthy all along. When a Service fails but its Pods look fine, check `kubectl get endpoints` first.",
  },
  {
    slug: "bad-config",
    title: "Every request fails and every Pod is Ready",
    difficulty: "medium",
    page: "shop-web is returning 503s",
    brief:
      "The API team shipped a small config change a minute ago: \"point at the new database host\". The rollout finished, every Pod is Ready, and yet every request now fails.",
    break: (c) =>
      rollout(c, `${SHOP}-api`, "point at the new database host", (spec) => {
        const env = spec.template.spec.containers[0].env ?? [];
        spec.template.spec.containers[0].env = env.map((e) => (e.name === "DATABASE_URL" ? { ...e, value: `postgres://${SHOP}-database:5432/shop` } : e));
      }),
    hints: [
      "Ready Pods can still fail requests: readiness only checks /healthz. What do the API's own logs say? `kubectl logs deploy/shop-api`",
      "`kubectl rollout history deployment shop-api` shows what changed, and when.",
      "There's no Service called shop-database. Roll back to the revision that worked.",
    ],
    fix: "```bash\nkubectl rollout undo deployment shop-api\n```",
    debrief:
      "The new revision pointed DATABASE_URL at shop-database, a name nothing answers to, so every request the API handled failed. Its readiness probe only checks /healthz, which doesn't touch the database, so Kubernetes saw healthy Pods and finished the rollout. `kubectl rollout undo` goes back to the previous ReplicaSet in seconds; then fix the config properly.",
  },
  {
    slug: "locked-out",
    title: "The API says it can't reach the database",
    difficulty: "medium",
    page: "shop-web is returning 503s",
    brief:
      "Security asked for the database to be locked down, and someone applied a NetworkPolicy before lunch. Postgres is Running and Ready. The API says it can't reach it.",
    break: (c) =>
      c.create<NetworkPolicy>({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "db-lockdown", namespace: "default" },
        spec: { podSelector: { matchLabels: { app: `${SHOP}-db` } }, policyTypes: ["Ingress"] },
      }),
    hints: [
      "Everything is Running. What's between the API and the database? `kubectl get networkpolicy`",
      "`kubectl describe networkpolicy db-lockdown`: it selects the database Pods and allows no ingress at all.",
      "Allow connections from the API Pods on port 5432 (or delete the policy, if security agrees).",
    ],
    fix: "```bash\nkubectl delete networkpolicy db-lockdown\n```\n\nOr, better, let only the API in:\n\n```yaml\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: db-lockdown\nspec:\n  podSelector:\n    matchLabels:\n      app: shop-db\n  policyTypes: [\"Ingress\"]\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: shop-api\n    ports:\n    - port: 5432\n```",
    debrief:
      "A NetworkPolicy that selects a Pod and lists no ingress rules denies every incoming connection to it. Postgres was healthy; the API's connections were silently dropped. The real fix is to allow exactly what should get in: the API Pods, on port 5432.",
  },
  {
    slug: "cache-crashloop",
    title: "The shop fails in waves",
    difficulty: "medium",
    page: "shop-web is failing on and off",
    brief:
      "Someone added a liveness probe to the Redis cache \"so Kubernetes restarts it if it hangs\". Since then the shop fails in waves: fine for a bit, then errors, then fine again.",
    break: (c) =>
      rollout(c, `${SHOP}-cache`, "add a liveness probe", (spec) => {
        spec.template.spec.containers[0].livenessProbe = { tcpSocket: { port: 6380 }, periodSeconds: 5, failureThreshold: 2 };
      }),
    hints: [
      "Look at the RESTARTS column: `kubectl get pods`. Which Pod keeps restarting?",
      "`kubectl describe pod` on it: the Events say the kubelet is killing it. Why does the liveness probe fail?",
      "Redis listens on 6379. Roll back, or fix the probe's port.",
    ],
    fix: "```bash\nkubectl rollout undo deployment shop-cache\n```",
    debrief:
      "The liveness probe checked port 6380, but Redis listens on 6379, so every probe failed and the kubelet killed a perfectly healthy container, again and again, backing off longer each time (CrashLoopBackOff). A liveness probe that's wrong is worse than none: it turns a healthy process into an outage.",
  },
  {
    slug: "node-down",
    title: "The shop is still down after its Pods moved",
    difficulty: "hard",
    page: "shop-web is returning 503s",
    brief:
      "One of the worker machines just lost power. Kubernetes should reschedule everything, right? The web and API Pods moved, but the shop is still down.",
    break: (c) => {
      const node = c.get<Pod>("Pod", "default", `${SHOP}-db-0`).spec?.nodeName;
      if (node) c.state.nodes[node].up = false;
    },
    hints: [
      "`kubectl get nodes` and `kubectl get pods -o wide`: where is shop-db-0, and what state is that Node in?",
      "Kubernetes won't start a second shop-db-0 while it can't tell whether the first one is still running. Even if you force-delete it, look at where its volume lives: `kubectl describe pv`.",
      "Its local-path volume is on the dead Node, so the Pod can only run there. Bring the Node back: drag Chaos from + Add onto it (in a real cluster: restart the machine).",
    ],
    fix: "Drag **Chaos** from **+ Add → Tools** onto the dead Node to power it back on. The kubelet reports in and shop-db-0 starts again, with its data.",
    debrief:
      "A StatefulSet guarantees at most one shop-db-0, so it doesn't replace a Pod on a Node that stopped answering. It can't know the old one is gone. And the database's volume was local-path storage, which lives on one Node's disk, so the Pod could only ever run there. Production databases use network storage (or replication) so they can move.",
  },
  {
    slug: "scaled-to-zero",
    title: "The shop stopped answering its customers",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "Someone wanted to pause the fake customers (shop-users) while they read some logs, so they ran a scale command from their shell history. The customers kept coming. The shop stopped answering them.",
    break: (c) => {
      const d = c.get<Deployment>("Deployment", "default", `${SHOP}-api`);
      c.replace({ ...d, spec: { ...d.spec!, replicas: 0 } });
    },
    hints: [
      "`kubectl get deployments`: compare READY for each one. Which has none?",
      "shop-api says 0/0: it isn't failing, it was asked for zero Pods. `kubectl get endpoints shop-api` agrees.",
      "Scaling isn't a rollout, so `rollout undo` won't bring it back. Scale it back up to 2.",
    ],
    fix: "```bash\nkubectl scale deployment shop-api --replicas=2\n```",
    debrief:
      "The scale command hit shop-api instead of shop-users, so the Deployment did exactly what it was told and removed every API Pod. Nothing crashed and no Event says anything is wrong; the only clue is READY 0/0. Scaling doesn't create a new revision, so the fix is to scale back, not roll back. Check the name before you press Enter, and keep replica counts in the manifest you apply.",
  },
  {
    slug: "wrong-target-port",
    title: "Every request fails though the API Pods are Ready",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "A teammate tidied up the Services so that \"everything uses port 80\". The API Pods are Running and Ready, and its Service still lists them as endpoints. Every request fails anyway.",
    break: (c) => {
      const s = c.get<Service>("Service", "default", `${SHOP}-api`);
      c.replace({ ...s, spec: { ...s.spec, ports: (s.spec?.ports ?? []).map((p) => ({ ...p, targetPort: 80 })) } });
    },
    hints: [
      "`kubectl get endpoints shop-api`: the Pods are there. Look at the port after each address.",
      "Which port does the API container listen on? `kubectl describe pod -l app=shop-api` shows Port.",
      "A Service's targetPort must be the port the container listens on: 8080.",
    ],
    fix: "```bash\nkubectl patch service shop-api -p '{\"spec\":{\"ports\":[{\"port\":80,\"targetPort\":8080}]}}'\n```",
    debrief:
      "A Service has two ports: `port` is what clients call (80), and `targetPort` is where it sends the traffic on the Pod. The API listens on 8080, so with targetPort 80 every connection was refused. Endpoints only list Ready Pods; they don't check that anything listens on the target port. The readiness probe calls 8080 directly, so the Pods stayed Ready the whole time.",
  },
  {
    slug: "bad-image-tag",
    title: "The cache Pod never starts again",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "Someone switched the Redis cache to the smaller alpine image. The cache Deployment uses the Recreate strategy, so the old Pod stopped first. The new one never started.",
    break: (c) =>
      rollout(c, `${SHOP}-cache`, "switch to the alpine image", (spec) => {
        spec.strategy = { type: "Recreate" };
        spec.template.spec.containers[0].image = "redis:alpnie";
      }),
    hints: [
      "`kubectl get pods`: what's the STATUS of the cache Pod?",
      "`kubectl describe pod -l app=shop-cache`: the Events say why the image can't be pulled. Read the tag carefully.",
      "Set the image back to one that exists: redis:7 (or spell alpine correctly).",
    ],
    fix: "```bash\nkubectl set image deployment/shop-cache redis=redis:7\n```",
    debrief:
      "The tag `alpnie` doesn't exist, so the kubelet couldn't pull the image (ErrImagePull) and kept retrying, waiting longer each time (ImagePullBackOff). The Recreate strategy stops every old Pod before it starts a new one, so there was no Redis at all. With RollingUpdate, the old Pod would have kept serving until the new one was Ready, and a bad tag would have cost nothing.",
  },
  {
    slug: "deleted-db-service",
    title: "The API can't find the database",
    difficulty: "medium",
    page: "shop-web is returning 503s",
    brief:
      "During a cleanup, a teammate deleted a Service with no cluster IP: \"it said None, it looked broken\". The database Pod is Running and Ready, but the API can't find it.",
    break: (c) => c.delete("Service", "default", `${SHOP}-db`),
    hints: [
      "What does the API say? `kubectl logs deploy/shop-api` shows the address it can't reach.",
      "The API finds the database by the name shop-db, and names come from Services. `kubectl get services`: is there one called shop-db?",
      "Create it again, headless (no cluster IP), on port 5432. `kubectl create service clusterip` selects Pods labelled app=<name>, which is the database Pod's label.",
    ],
    fix: "```bash\nkubectl create service clusterip shop-db --clusterip=None --tcp=5432:5432\n```",
    debrief:
      "shop-db was a headless Service (clusterIP: None). It has no virtual IP; cluster DNS answers its name with the Pod's own IP, which is how a StatefulSet's Pods get stable names. CLUSTER-IP None is on purpose, not broken. Without the Service the name shop-db didn't exist, so the API couldn't find Postgres even though it was running fine.",
  },
  {
    slug: "renamed-secret-key",
    title: "The database keeps crashing",
    difficulty: "medium",
    page: "shop-web is returning 503s",
    brief:
      "Someone made the Secret keys match the team's style: in Secret shop-db, POSTGRES_PASSWORD is now just `password`. The database Pod was restarted soon after, and it keeps crashing.",
    break: (c) => {
      const s = c.get<Secret>("Secret", "default", `${SHOP}-db`);
      c.replace({ ...s, data: { password: s.data?.POSTGRES_PASSWORD ?? "" } });
      c.delete("Pod", "default", `${SHOP}-db-0`, { force: true });
    },
    hints: [
      "`kubectl get pods`: which Pod keeps restarting?",
      "Kubernetes started it fine; Postgres itself exits. `kubectl logs shop-db-0` says what it's missing.",
      "The Pod loads every key of Secret shop-db as an environment variable (envFrom), named after the key. Add the key POSTGRES_PASSWORD back.",
    ],
    fix: "```bash\nkubectl patch secret shop-db -p '{\"stringData\":{\"POSTGRES_PASSWORD\":\"change-me\"}}'\n```",
    debrief:
      "envFrom turns each key of a Secret into an environment variable with the same name, so renaming the key renamed the variable. Kubernetes saw nothing wrong and started the container. Postgres found no POSTGRES_PASSWORD and exited, again and again (CrashLoopBackOff), and only its logs said why. The kubelet reads the Secret each time it restarts the container, so it picked up the fix on the next try. The API reads the same key by name (secretKeyRef), so its next Pod would have failed too, with CreateContainerConfigError.",
  },
  {
    slug: "drained-nodes",
    title: "Every shop Pod is Pending",
    difficulty: "medium",
    page: "shop-web has stopped getting traffic",
    brief:
      "Ops patched the kernel on both worker Nodes: drain, patch, reboot. The Nodes are back and Ready. Every Pod of the shop is Pending.",
    break: (c) => {
      for (const n of c.list<Node>("Node")) {
        if (n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined) continue;
        c.replace({ ...n, spec: { ...n.spec, unschedulable: true } });
        // Evict what drain --ignore-daemonsets would: everything but DaemonSet and static Pods.
        for (const p of c.list<Pod>("Pod")) {
          const daemon = p.metadata.ownerReferences?.some((o) => o.kind === "DaemonSet") || p.metadata.annotations?.["kubernetes.io/config.source"];
          if (p.spec?.nodeName === n.metadata.name && !daemon) c.deleteObject(p);
        }
      }
    },
    hints: [
      "`kubectl describe pod` on any Pending Pod: what do the scheduler's Events say about the Nodes?",
      "`kubectl get nodes`: Ready, but SchedulingDisabled. Draining a Node cordons it first, and rebooting doesn't undo that.",
      "Mark both workers schedulable again with `kubectl uncordon`.",
    ],
    fix: "```bash\nkubectl uncordon worker-1 worker-2\n```",
    debrief:
      "`kubectl drain` does two things: it cordons the Node (no new Pods may be scheduled there) and evicts the Pods already on it. The cordon stays until someone runs `kubectl uncordon`, even across a reboot. With both workers cordoned and the control plane tainted, the scheduler had nowhere to put anything, including CoreDNS and the customers. Drain one Node at a time, and uncordon it before you move on to the next.",
  },
  {
    slug: "dns-scaled-down",
    title: "The Pods are fine but no customer gets through",
    difficulty: "medium",
    page: "shop-web has stopped getting traffic",
    brief:
      "Someone was trimming kube-system to save memory and scaled down a Deployment they didn't recognise. Every shop Pod is Running and Ready, yet no customer gets through.",
    break: (c) => {
      const d = c.get<Deployment>("Deployment", "kube-system", "coredns");
      c.replace({ ...d, spec: { ...d.spec!, replicas: 0 } });
    },
    hints: [
      "The customers are Pods too. What does `kubectl logs deploy/shop-users` say?",
      "`bad address` means the name didn't resolve. Who answers names in a cluster? `kubectl get pods -n kube-system`",
      "Cluster DNS is the coredns Deployment in kube-system, behind the kube-dns Service. Scale it back up to 2.",
    ],
    fix: "```bash\nkubectl scale deployment coredns -n kube-system --replicas=2\n```",
    debrief:
      "Every Service name (shop-web, shop-api, shop-db) is answered by CoreDNS, an ordinary Deployment in kube-system. With no CoreDNS Pods, every lookup failed, so the customers couldn't even find shop-web, and nothing in the shop showed an error. Everything in kube-system keeps the cluster running; leave it alone unless you know what each piece does.",
  },
  {
    slug: "db-too-big",
    title: "The database Pod went away and never came back",
    difficulty: "hard",
    page: "shop-web is returning 503s",
    brief:
      "The database felt slow, and the DBA asked for 8Gi of memory for Postgres. Someone set it as the memory request on the StatefulSet. shop-db-0 went away and never came back.",
    break: (c) => {
      const s = c.get<StatefulSet>("StatefulSet", "default", `${SHOP}-db`);
      const spec = structuredClone(s.spec!);
      spec.template.spec.containers[0].resources = { ...spec.template.spec.containers[0].resources, requests: { cpu: "100m", memory: "8Gi" } };
      c.replace({ ...s, spec });
    },
    hints: [
      "`kubectl get pods`: shop-db-0 is Pending. `kubectl describe pod shop-db-0`: what do the scheduler's Events say?",
      "No Node has 8Gi to give: `kubectl describe node worker-1` shows Allocatable memory. Lower the request with `kubectl set resources`.",
      "The StatefulSet waits for shop-db-0 to become Ready before it changes it, so it won't replace the stuck Pod. Delete it after fixing the template.",
    ],
    fix: "```bash\nkubectl set resources statefulset shop-db --requests=memory=1Gi\nkubectl delete pod shop-db-0\n```",
    debrief:
      "A memory request is what the scheduler sets aside on a Node for the Pod. Each Node here has about 7.8Gi in total, so a Pod asking for 8Gi fits nowhere and stays Pending. The StatefulSet replaced its only Pod (old one first, so there was no database), and then waited for the new one to become Ready, which it never would. Fixing the template isn't enough in this state: a StatefulSet won't replace a Pod that never became Ready, so you delete it yourself and it comes back from the fixed template.",
  },
  {
    slug: "dns-egress",
    title: "The API can't reach the database or the cache",
    difficulty: "hard",
    page: "shop-web is returning 503s",
    brief:
      "Security asked to restrict what the API can talk to. The new policy allows exactly the database and the cache, each on its own port. Since it went in, the API can't reach either of them.",
    break: (c) =>
      c.create<NetworkPolicy>({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "api-egress", namespace: "default" },
        spec: {
          podSelector: { matchLabels: { app: `${SHOP}-api` } },
          policyTypes: ["Egress"],
          egress: [
            { to: [{ podSelector: { matchLabels: { app: `${SHOP}-db` } } }], ports: [{ port: 5432 }] },
            { to: [{ podSelector: { matchLabels: { app: `${SHOP}-cache` } } }], ports: [{ port: 6379 }] },
          ],
        },
      }),
    hints: [
      "`kubectl describe networkpolicy api-egress`: the database and cache rules look right. What else does the API need before it can connect to shop-db?",
      "It has to look the name up first. Cluster DNS runs in kube-system and listens on port 53, and this policy doesn't allow that.",
      "Add an egress rule for port 53, over UDP and TCP.",
    ],
    fix: "```bash\nkubectl patch networkpolicy api-egress --type=json -p '[{\"op\":\"add\",\"path\":\"/spec/egress/-\",\"value\":{\"ports\":[{\"port\":53,\"protocol\":\"UDP\"},{\"port\":53,\"protocol\":\"TCP\"}]}}]'\n```\n\nOr, tighter, allow DNS only to CoreDNS:\n\n```yaml\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: api-egress\nspec:\n  podSelector:\n    matchLabels:\n      app: shop-api\n  policyTypes: [\"Egress\"]\n  egress:\n  - to:\n    - podSelector:\n        matchLabels:\n          app: shop-db\n    ports:\n    - port: 5432\n  - to:\n    - podSelector:\n        matchLabels:\n          app: shop-cache\n    ports:\n    - port: 6379\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: kube-system\n      podSelector:\n        matchLabels:\n          k8s-app: kube-dns\n    ports:\n    - port: 53\n      protocol: UDP\n    - port: 53\n      protocol: TCP\n```",
    debrief:
      "Once a NetworkPolicy selects a Pod for Egress, everything it doesn't allow is dropped, and that includes DNS lookups to CoreDNS on port 53. The rules for the database and the cache were fine, but the API never got as far as using them: it couldn't turn the name shop-db into an address. Every egress policy needs a rule for DNS. It's one of the most common NetworkPolicy mistakes.",
  },
  {
    slug: "quota-limits",
    title: "The database Pod never came back and nothing is Pending",
    difficulty: "hard",
    page: "shop-web is returning 503s",
    brief:
      "The platform team added a ResourceQuota to every namespace at lunch, and nothing happened. An hour later the database Pod was restarted during Node maintenance. It never came back, and there isn't even a Pending Pod.",
    break: (c) => {
      c.create<ResourceQuota>({
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: { name: "compute", namespace: "default" },
        spec: { hard: { "requests.memory": "4Gi", "limits.memory": "8Gi" } },
      });
      c.delete("Pod", "default", `${SHOP}-db-0`, { force: true });
    },
    hints: [
      "There's no shop-db-0 Pod at all. Who should create it? `kubectl describe statefulset shop-db` and read its Events.",
      "The API server refuses the Pod: the quota `compute` caps limits.memory, so every new Pod must say what its memory limit is. `kubectl describe quota compute`",
      "Give the database container a memory limit with `kubectl set resources`.",
    ],
    fix: "```bash\nkubectl set resources statefulset shop-db --limits=memory=512Mi\n```",
    debrief:
      "A ResourceQuota that caps limits.memory makes every new Pod in the namespace declare a memory limit, or the API server rejects it. Pods that were already running aren't checked, so nothing broke until one was recreated. A rejected Pod is never created, so the error shows up on its controller (the StatefulSet's FailedCreate Events), not on a Pod. The web and API Pods have no limits either and would fail the same way on their next rollout; a LimitRange can give every container a default limit.",
  },
  // ------------------------------------------------------------ the CKA's node and control-plane faults (ADR 0003)
  // Each reproduces a scenario of docs/research/real-cluster-captures-control-plane.md (kind, with kubeadm's paths
  // and text from real-cluster-captures-kubeadm.md). They run on EXAM_NODES and are solved from the terminal alone.
  {
    // Capture Scenario 1: `systemctl stop kubelet` on the worker. Node NotReady ~52 s later, the Pod stays 1/1 Running
    // until eviction, Ready ~3 s after `systemctl start kubelet`.
    slug: "node-not-ready",
    title: "node01 shows NotReady",
    difficulty: "easy",
    nodes: EXAM_NODES,
    start: ["kubectl get nodes", "kubectl get pods -o wide"],
    page: "node01 shows NotReady",
    brief:
      "Ops noticed that node01 went NotReady a few minutes ago. Nobody has touched the cluster since the weekend maintenance. The shop's Pods on it still say Running, but the Node no longer reports in.",
    break: (c) => {
      stopService(c, "node01", "kubelet");
      settle(c, NOT_READY_MS);
    },
    hints: [
      "The control plane has stopped hearing from node01. Whatever should be telling it is on node01 itself, not in the API: log in to the Node.",
      "On the Node, systemd runs the agent that reports to the control plane. Ask it for the state of that service, and read its recent log.",
      "`systemctl status kubelet` shows `inactive (dead)`: the service was stopped cleanly, and nothing is restarting it.",
      "Start the kubelet service (as root), then check from the control plane that the Node is Ready again.",
    ],
    fix: "```bash\nssh node01\nsudo -i\nsystemctl start kubelet\nexit\nexit\n```\n\nThen `kubectl get nodes`: node01 is Ready within a few seconds.",
    debrief:
      "The kubelet on node01 had been stopped. The kubelet is the Node's agent: it posts heartbeats to the API server, so with it gone the Node went NotReady after the 50 s grace period. The containers already running kept running, because the container runtime is a separate service, and the Pods would only have been evicted after another five minutes. `systemctl status kubelet` and `journalctl -u kubelet` on the Node are where to look first, and `systemctl start kubelet` brought it back.",
  },
  {
    // Capture Scenario 2: `systemctl disable kubelet` + `systemctl stop kubelet` ("did not come back after reboot").
    // Recovery with `systemctl enable --now kubelet`, Ready <= 3 s. Resolution here also needs the unit enabled (shopProblem).
    slug: "node-lost-after-reboot",
    title: "node01 did not rejoin after its reboot",
    difficulty: "medium",
    nodes: EXAM_NODES,
    start: ["kubectl get nodes", "kubectl get pods -o wide"],
    page: "node01 is NotReady after its reboot",
    brief:
      "node01 was rebooted for kernel patching, and it never rejoined the cluster. The host itself is up, and you can log in to it.",
    break: (c) => {
      setEnabled(c, "node01", "kubelet", false);
      stopService(c, "node01", "kubelet");
      settle(c, NOT_READY_MS);
    },
    hints: [
      "node01 is up but the control plane hears nothing from it. Log in to the Node and see what its agent is doing.",
      "Ask systemd about the kubelet service. Its status shows two separate settings: whether it is running now, and whether it starts at boot.",
      "`systemctl status kubelet` says `inactive (dead)` and `disabled`. `systemctl is-enabled kubelet` confirms the second one. Starting it alone would fail the same way at the next reboot.",
      "Enable and start it in one command, then check from the control plane that node01 is Ready.",
    ],
    fix: "```bash\nssh node01\nsudo -i\nsystemctl enable --now kubelet\nexit\nexit\n```\n\nThen `kubectl get nodes`: node01 is Ready within a few seconds.",
    debrief:
      "The kubelet was both stopped and disabled, so it did not start when the Node booted. `systemctl start kubelet` would have brought the Node back until the next reboot; `systemctl enable --now kubelet` enables the unit (a symlink in multi-user.target.wants) and starts it in one step. After a Node reboot that does not recover, check `systemctl status kubelet` for both Loaded: …; enabled/disabled and Active:.",
  },
  {
    // Capture 3c: --kubeconfig=/etc/kubernetes/scheduler.conf -> schedulr.conf in kube-scheduler.yaml. The container exits,
    // CrashLoopBackOff 15-60 s later; `crictl logs` shows `stat /etc/kubernetes/schedulr.conf: no such file or directory`;
    // 1/1 again 26 s after the fix; a waiting Pod is Running ~6 s after that.
    slug: "pods-stuck-pending",
    title: "New Pods stay Pending",
    difficulty: "hard",
    nodes: EXAM_NODES,
    start: ["kubectl get pods -o wide", "kubectl get pods -n kube-system"],
    page: "the new shop-web Pods are stuck Pending",
    brief:
      "The shop was scaled up for a sale, and the extra shop-web Pods have sat in Pending ever since, with no events on them. The Pods that were already running are fine, and nothing else in the cluster seems to be misbehaving.",
    break: (c) => {
      hostEdit(c, "controlplane", SCHEDULER_MANIFEST, (t) => t.replace("--kubeconfig=/etc/kubernetes/scheduler.conf", "--kubeconfig=/etc/kubernetes/schedulr.conf"));
      // The kubelet picks the changed manifest up within seconds. Scale up only once the old scheduler is gone, or it would still place the new Pods.
      c.advance(12_000);
      scale(c, `${SHOP}-web`, 5);
      c.advance(2_000); // the new Pods exist, and are Pending, when the Learner arrives
    },
    hints: [
      "A Pod that has no events and no Node was never looked at by anything. Something that is meant to place Pods is not doing it. What runs in kube-system?",
      "Look at the control-plane Pods in kube-system. One of them is not Running.",
      "The control-plane components are static Pods: their manifests are files on the control-plane Node, in /etc/kubernetes/manifests. Log in there and ask the container runtime for the failed container's logs (as root).",
      "The scheduler's log ends with a `stat` error for a file under /etc/kubernetes that does not exist. Compare the path with what `ls /etc/kubernetes` shows.",
      "Correct the path in the scheduler's manifest. The kubelet notices the change on its own within seconds and starts a fresh container; the waiting Pods are then placed.",
    ],
    fix: "```bash\nssh controlplane\nsudo -i\nvi /etc/kubernetes/manifests/kube-scheduler.yaml\nexit\nexit\n```\n\nIn the editor change `--kubeconfig=/etc/kubernetes/schedulr.conf` back to `--kubeconfig=/etc/kubernetes/scheduler.conf` and save. Nothing needs restarting: the kubelet re-reads the manifest.",
    debrief:
      "kube-scheduler's manifest pointed --kubeconfig at a file that does not exist, so the container exited on start and went into CrashLoopBackOff. Without a scheduler nothing assigns Pods to Nodes: new Pods stay Pending with no Node and no events, while Pods already running are unaffected. Static Pod manifests live in /etc/kubernetes/manifests and the kubelet applies an edit by itself. `crictl ps -a` and `crictl logs <id>` show the failed container's own message.",
  },
  {
    // Capture 4a: --etcd-servers=https://127.0.0.1:2379 -> :2399. kubectl fails within seconds, the container retries etcd ~20 s
    // and then exits; kubectl works again ~22 s after the fix.
    slug: "cluster-unreachable",
    title: "Every request to the cluster is refused",
    difficulty: "hard",
    nodes: EXAM_NODES,
    start: ["kubectl get nodes"],
    page: "every request to the cluster is refused",
    brief:
      "A colleague was tuning the control plane and left for the day. Now every command that talks to the cluster fails with `connection refused`, for everyone. The shop's Pods are still serving customers.",
    break: (c) => {
      hostEdit(c, "controlplane", APISERVER_MANIFEST, (t) => t.replace("https://127.0.0.1:2379", "https://127.0.0.1:2399"));
      settle(c, 8_000); // the kubelet's scan picks the change up: kubectl is already refused when the Learner arrives
    },
    hints: [
      "kubectl cannot reach the API server, so it cannot tell you anything about it. Go to where the API server runs: the control-plane Node.",
      "The API server is a static Pod there, so the container runtime sees it even when the API does not answer. Log in as root and list the containers, including the ones that exited.",
      "`crictl ps -a` shows kube-apiserver Exited, with a rising ATTEMPT count. Read the logs of the latest attempt.",
      "The log says it cannot reach etcd at 127.0.0.1:2399. Compare that port with the one etcd's manifest in /etc/kubernetes/manifests listens on for clients.",
      "Fix the --etcd-servers port in kube-apiserver.yaml. The kubelet restarts the container by itself; kubectl works again within half a minute.",
    ],
    fix: "```bash\nssh controlplane\nsudo -i\nvi /etc/kubernetes/manifests/kube-apiserver.yaml\nexit\nexit\n```\n\nIn the editor change `--etcd-servers=https://127.0.0.1:2399` back to `--etcd-servers=https://127.0.0.1:2379` and save. Give it up to half a minute, then `kubectl get nodes`.",
    debrief:
      "The API server's manifest pointed --etcd-servers at port 2399, where nothing listens (etcd serves clients on 2379), so it could not start: it retried for about 20 seconds and then exited. With the API server down kubectl is refused, and nothing in the cluster can be changed or reconciled, while the containers already running keep serving traffic. When kubectl itself is dead, use `crictl` on the control-plane Node: it talks to the container runtime directly. The apiserver's logs name the failing address.",
  },
  {
    // Capture Scenario 5: kube-controller-manager.yaml moved out of /etc/kubernetes/manifests. The mirror Pod is gone in <= 5 s,
    // a scale is accepted but no ReplicaSet or Pod follows; Pods appear ~21 s after the manifest is back.
    slug: "scale-does-nothing",
    title: "Scaling up creates no Pods",
    difficulty: "hard",
    nodes: EXAM_NODES,
    start: ["kubectl get deployments", "kubectl get pods -n kube-system"],
    page: "shop-api was scaled up and no new Pods came",
    brief:
      "Ahead of the sale somebody scaled shop-api from 2 to 4 replicas. The command was accepted, and that was an hour ago. There are still only two API Pods, and none of them is Pending. Nothing else looks wrong.",
    break: (c) => {
      const host = c.state.hosts.controlplane;
      host.files["/tmp/kube-controller-manager.yaml"] = { ...host.files[KCM_MANIFEST], mtime: c.now };
      delete host.files[KCM_MANIFEST];
      c.hostChanged();
      // The kubelet drops the static Pod within seconds. Scale only once the old controller-manager is gone, or it would still create the Pods.
      c.advance(8_000);
      scale(c, `${SHOP}-api`, 4);
    },
    hints: [
      "The Deployment wants 4 and has 2, and there is not even a Pending Pod. Something that turns a Deployment's replica count into ReplicaSets and Pods did not run. Is every component in kube-system there?",
      "List the control-plane Pods in kube-system. One of the four is missing altogether, not crashing.",
      "Those Pods are static Pods, started from manifest files on the control-plane Node. Log in as root and list /etc/kubernetes/manifests.",
      "Only three manifests are there. Somebody moved the fourth one out. Look in /tmp.",
      "Move kube-controller-manager.yaml back into /etc/kubernetes/manifests. The kubelet starts it within seconds; the missing Pods appear about twenty seconds later.",
    ],
    fix: "```bash\nssh controlplane\nsudo -i\nmv /tmp/kube-controller-manager.yaml /etc/kubernetes/manifests/\nexit\nexit\n```\n\nThen `kubectl get deployments`: shop-api reaches 4/4 within about half a minute.",
    debrief:
      "kube-controller-manager's manifest had been moved out of /etc/kubernetes/manifests, so the kubelet removed the static Pod. The API server still accepted the scale (it only stores spec.replicas), but the Deployment and ReplicaSet controllers live in the controller-manager, so no ReplicaSet was updated and no Pod was created. Because nothing was created, nothing was Pending: the missing Pod is not in the list. Putting the manifest back is enough; the kubelet watches the directory.",
  },
  {
    // Capture Scenario 6: containerRuntimeEndpoint in /var/lib/kubelet/config.yaml with one extra `k` + `systemctl restart kubelet`.
    // The service sits in `activating (auto-restart)`, NotReady ~51 s later, Ready ~4 s after the fix.
    slug: "node-notready-after-change",
    title: "node01 stays NotReady",
    difficulty: "hard",
    nodes: EXAM_NODES,
    start: ["kubectl get nodes", "kubectl get pods -o wide"],
    page: "node01 shows NotReady",
    brief:
      "A colleague was working on node01 this morning. Shortly afterwards the Node went NotReady, and it has stayed that way. Its Pods are still running, and the host is up: you can log in to it.",
    break: (c) => {
      hostEdit(c, "node01", KUBELET_CONFIG, (t) => t.replace("containerd.sock", "containerd.sockk"));
      restartService(c, "node01", "kubelet");
      settle(c, NOT_READY_MS);
    },
    hints: [
      "The Node stopped reporting. Log in to node01 and ask whether the agent that reports for it is running.",
      "`systemctl status kubelet` is not `active (running)`: it says `activating (auto-restart)`. It starts, fails and is started again. Read why in `journalctl -u kubelet --no-pager`.",
      "The last lines before each restart say `command failed` and name an endpoint it could not dial: a unix socket path that does not exist.",
      "The path is set in /var/lib/kubelet/config.yaml. Compare it with the socket the container runtime really listens on: `ls /var/run/containerd`.",
      "Correct the containerRuntimeEndpoint in config.yaml, then restart the kubelet. Check from the control plane that node01 is Ready.",
    ],
    fix: "```bash\nssh node01\nsudo -i\nvi /var/lib/kubelet/config.yaml\nsystemctl restart kubelet\nexit\nexit\n```\n\nIn the editor change `containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sockk` back to `unix:///var/run/containerd/containerd.sock` and save. Then `kubectl get nodes`: node01 is Ready within a few seconds.",
    debrief:
      "The kubelet's config.yaml named a container-runtime socket with an extra `k`, so on every start the kubelet failed to connect to containerd and exited; systemd kept restarting it (`activating (auto-restart)`). The containers kept running, as containerd was healthy, but with no kubelet the Node stopped reporting and went NotReady. Edits to config.yaml only take effect when the kubelet restarts, so the fix needs `systemctl restart kubelet` after the edit. For a failing service, `journalctl -u kubelet` names the cause.",
  },
];

export const incidentBySlug = (slug: string) => INCIDENTS.find((i) => i.slug === slug);

// ---------------------------------------------------------------- health

const inWindow = (c: Cluster, times: number[] | undefined) => (times ?? []).filter((t) => c.now - t <= WINDOW_MS).length;

/** Requests per second shop-web served over the last few seconds, and the share that failed. */
export function shopTraffic(c: Cluster): { rps: number; err: number } {
  const svc = c.raw("Service", "default", `${SHOP}-web`) as unknown as Service | undefined;
  let reqs = svc ? inWindow(c, c.state.svcErrs?.[svc.metadata.uid]) : 0;
  let errs = reqs;
  for (const p of c.list<Pod>("Pod", "default")) {
    if (p.metadata.labels?.app !== `${SHOP}-web`) continue;
    for (const ct of Object.values(c.state.pods[p.metadata.uid]?.containers ?? {})) {
      reqs += inWindow(c, ct.reqs);
      errs += inWindow(c, ct.errs);
    }
  }
  return { rps: reqs / (WINDOW_MS / 1000), err: reqs ? errs / reqs : 0 };
}

/** What's still wrong with the shop, or null when it's healthy: serving without errors, every workload at full strength. */
export function shopProblem(c: Cluster): string | null {
  const t = shopTraffic(c);
  if (t.rps === 0) return "No traffic is reaching shop-web.";
  if (t.err >= 0.01) return `${Math.round(t.err * 100)}% of requests are failing.`;
  for (const d of c.list<Deployment>("Deployment", "default")) {
    if (!d.metadata.name.startsWith(SHOP)) continue;
    const want = d.spec?.replicas ?? 1;
    if ((d.status?.readyReplicas ?? 0) < want || (d.status?.updatedReplicas ?? 0) < want) return `Deployment ${d.metadata.name} isn't fully ready.`;
  }
  const db = c.raw("StatefulSet", "default", `${SHOP}-db`) as unknown as StatefulSet | undefined;
  if (!db || (db.status?.readyReplicas ?? 0) < (db.spec?.replicas ?? 1)) return "The database isn't ready.";
  const looping = c.list<Pod>("Pod", "default").find((p) => p.metadata.name.startsWith(SHOP) && p.status?.containerStatuses?.some((s) => s.state.waiting?.reason === "CrashLoopBackOff"));
  if (looping) return `${looping.metadata.name} is crash-looping.`;
  return platformProblem(c);
}

/**
 * What's still wrong beneath the shop, for the Incidents that break a Node's kubelet or the control plane (ADR 0003): a kubelet that
 * is stopped, failing or disabled, an API server that does not answer, a controller-manager or scheduler that is not running. It
 * reads the engine's own state, so it holds while kubectl is refused. The text names a symptom, never the cause: the pager shows it
 * before any hint is asked for. Null on a cluster with no control plane, and on a healthy one.
 */
function platformProblem(c: Cluster): string | null {
  const health = controlPlaneHealth(c);
  if (!health.api) return "The cluster isn't answering.";
  for (const [name, host] of Object.entries(c.state.hosts)) {
    const kubelet = host.services.kubelet;
    if (kubelet.active !== "active") {
      // kubectl shows NotReady once the grace period has run out; until then the Node still says Ready and the message must not claim otherwise.
      const ready = (c.raw("Node", undefined, name) as unknown as Node | undefined)?.status?.conditions.find((q) => q.type === "Ready")?.status === "True";
      return ready ? "The cluster isn't healthy yet." : `Node ${name} isn't reporting in.`;
    }
    // Running but disabled: the Node reports Ready now, and would not rejoin after a restart (capture Scenario 2).
    if (!kubelet.enabled) return "A Node would not rejoin after a restart.";
  }
  if (!health.kcm || !health.scheduler) return "The cluster isn't healthy yet.";
  return null;
}

// ---------------------------------------------------------------- the Daily Incident

/** Day 1 of the Daily Incident. */
const DAILY_EPOCH = Date.UTC(2026, 9, 30);
const DAY_MS = 86_400_000;

/** Today's Daily Incident: its number (counting from 1) and which Incident it is, the same for everyone on a UTC day. */
export function dailyIncident(now = Date.now()): { n: number; incident: Incident; seed: number } {
  const day = Math.max(0, Math.floor((now - DAILY_EPOCH) / DAY_MS));
  // Step through the list with a stride coprime to its length, so consecutive days differ.
  const incident = INCIDENTS[(day * 5 + 2) % INCIDENTS.length];
  return { n: day + 1, incident, seed: 1000 + day };
}

/** "2:41" */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

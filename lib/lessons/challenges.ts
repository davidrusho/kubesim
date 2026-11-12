// Challenges: a broken (or unfinished) cluster and a goal, with no
// step-by-step instructions. Each goal is a Step whose Check tests cluster
// state; hints stay hidden until asked for, and "Show the fix" is a last resort.
// Every Challenge is replayed by lessons.test.ts, so each goal must be solvable.

import type { Deployment, Node, PersistentVolumeClaim, Pod } from "@/lib/engine";
import { egressAllowed, isIsolated } from "@/lib/engine";
import { dnsAllowed } from "@/lib/engine/netpol";
import type { Lesson, Step } from "./lessons";
import { NETWORKING_CHALLENGES } from "./challenge-sets/networking";
import { SECURITY_CHALLENGES } from "./challenge-sets/security";
import { WORKLOADS_CHALLENGES } from "./challenge-sets/workloads";
import { can, deployment, dep, endpointCount, firstContainer, obj, podsWith, reaches, readyCount, rolledOut, service, up } from "./lessons";

/** A Challenge's goal: a Step whose `hints` are an explicit ladder, so it has no single `hint`. */
export interface Goal extends Omit<Step, "hint"> {
  /** 3 or 4 hints, least direct first: where to look (no command), the read-only command, what its output means, what to change. The fix is the rung after these. See lib/lessons/hints.ts. */
  hints: string[];
}

export interface Challenge extends Omit<Lesson, "steps"> {
  steps: Goal[];
  difficulty: "easy" | "medium" | "hard";
  /** The situation, told like a ticket from a colleague. Markdown-ish, like Step bodies. */
  brief: string;
  /** Read-only commands suggested as a first look (defaults to a generic triage pair). */
  start?: string[];
}

const ns = (c: Parameters<NonNullable<Lesson["setup"]>>[0], name: string) => c.create({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
const allPodsOf = (d: Deployment | undefined, check: (p: Deployment["spec"]) => boolean) => !!d && check(d.spec);

const FRONTEND_EGRESS_FIXED = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-egress
spec:
  podSelector:
    matchLabels:
      app: frontend
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: backend
    ports:
    - port: 80
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
`;

const CACHE_FIXED = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cache-data
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cache
  template:
    metadata:
      labels:
        app: cache
    spec:
      containers:
      - name: cache
        image: redis:7
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: cache-data
`;

export const CHALLENGES: Challenge[] = [
  {
    slug: "typo-image",
    difficulty: "easy",
    track: "workloads",
    title: "The site is down",
    summary: "None of the `web` Pods are running and the site is down.",
    brief: "The site has been down for an hour: none of the `web` Pods are Running. The Deployment was changed shortly before it went down. Get it serving again; `web` must still run nginx.",
    minutes: 4,
    concepts: ["ImagePullBackOff", "kubectl describe"],
    setup: (c) => deployment(c, "web", "nginx:stabel", 3),
    warmupMs: 20_000,
    steps: [
      {
        title: "All three web Pods Running and Ready",
        body: "The `web` Deployment has 3 Pods, all Running and Ready.",
        check: (x) => rolledOut(x.cluster, "web") && readyCount(x.cluster, "web") === 3,
        hints: [
          "The Pods were placed on Nodes, but none of them ever becomes Ready. Something stops them before the app can run. Look at what one of the Pods reports about itself.",
          "Describe the Pods and read the Events at the bottom, the lines from the kubelet: `kubectl describe pods -l app=web`.",
          "The kubelet logs `Failed to pull image \"nginx:stabel\"` and then `ImagePullBackOff`. The registry has no image with that tag, so the container never starts. Read the tag letter by letter.",
          "The image is set in the Deployment's Pod template, and the Deployment owns these Pods. Correct it there and let the rollout replace them.",
        ],
        solution: { commands: ["kubectl set image deployment/web web=nginx:stable"] },
      },
    ],
  },
  {
    slug: "service-selector",
    difficulty: "easy",
    track: "networking",
    title: "Connection refused",
    summary: "Calls to a service fail although everything looks healthy.",
    brief: "Calls to the `api` Service fail with `Failed to connect to api port 80`, but both `api` Pods are Running and Ready. Nobody has touched the Deployment. Make the Service work.",
    minutes: 4,
    start: ["kubectl get pods -o wide", "kubectl get events --sort-by=.lastTimestamp", "curl http://api"],
    concepts: ["Service", "Selectors", "EndpointSlices"],
    setup: (c) => {
      deployment(c, "api", "nginxdemos/hello:plain-text", 2);
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "api", labels: { app: "api" } }, spec: { selector: { app: "api-server" }, ports: [{ port: 80 }] } });
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "http://api reaches both Pods",
        body: "The `api` Service sends traffic to both `api` Pods.",
        check: (x) => endpointCount(x.cluster, "api") === 2,
        hints: [
          "The Pods are healthy and the Service exists, so the fault sits in the link between them. Think about how a Service decides which Pods are its backends.",
          "A Service finds its Pods by labels. Compare what the Service selects with the labels the Pods carry: `kubectl describe svc api`, then `kubectl get pods --show-labels`.",
          "The Service shows `Selector: app=api-server` and `Endpoints: <none>`, but the Pods carry `app=api`. No Pod matches the selector, so the Service has nothing to send traffic to.",
          "Make the two agree. The Pods are fine, so change the Service's selector to match their label.",
        ],
        solution: { commands: [`kubectl patch service api -p '{"spec":{"selector":{"app":"api"}}}'`] },
      },
    ],
  },
  {
    slug: "missing-configmap",
    difficulty: "easy",
    track: "config",
    title: "Stuck before it starts",
    summary: "Pods that are stuck and never start running.",
    brief: "The `frontend` Pods have been stuck since last night and none of them is running. The one setting the app needs is `API_URL=http://api:8080`.",
    minutes: 5,
    concepts: ["ConfigMap", "CreateContainerConfigError"],
    setup: (c) => deployment(c, "frontend", "nginx:1.27", 2, "default", { envFrom: [{ configMapRef: { name: "frontend-config" } }] }),
    warmupMs: 10_000,
    steps: [
      {
        title: "frontend running with its config",
        body: "Both `frontend` Pods are Running and Ready, and get `API_URL=http://api:8080` from the ConfigMap they expect.",
        check: (x) => readyCount(x.cluster, "frontend") === 2 && obj<{ data?: Record<string, string> }>(x.cluster, "ConfigMap", "frontend-config")?.data?.API_URL === "http://api:8080",
        hints: [
          "The Pods have a Node and the image was pulled, but the container was never created. Look at the status the Pods report, then at the last warning the kubelet raised for them.",
          "`kubectl get pods` shows the status. `kubectl describe pods -l app=frontend` shows the kubelet's warning in the Events.",
          "The status is `CreateContainerConfigError` and the warning says `configmap \"frontend-config\" not found`. The Pods take their environment from that ConfigMap, and the cleanup deleted it.",
          "Create a ConfigMap with the name the Pods ask for, holding the one setting from the brief. Then watch the Pods.",
        ],
        solution: { commands: ["kubectl create configmap frontend-config --from-literal=API_URL=http://api:8080"] },
      },
    ],
  },
  {
    slug: "postgres-password",
    difficulty: "medium",
    track: "config",
    title: "The database won't stay up",
    summary: "A database that crashes a few seconds after every start.",
    brief: "The `db` Deployment (Postgres) restarts every few seconds. The database password lives in the Secret `db-credentials`; Security says it must not be written into the Deployment.",
    minutes: 6,
    concepts: ["CrashLoopBackOff", "Secret", "kubectl logs --previous"],
    setup: (c) => {
      c.create({ apiVersion: "v1", kind: "Secret", metadata: { name: "db-credentials" }, type: "Opaque", data: { POSTGRES_PASSWORD: btoa("correct-horse-battery") } } as never);
      deployment(c, "db", "postgres:16", 1);
    },
    warmupMs: 20_000,
    steps: [
      {
        title: "db running, password from the Secret",
        body: "The `db` Pod is Running and Ready, and `POSTGRES_PASSWORD` comes from the Secret `db-credentials`.",
        check: (x) => {
          const ct = firstContainer(dep(x.cluster, "db"));
          const fromSecret = !!ct?.env?.some((e) => e.name === "POSTGRES_PASSWORD" && e.valueFrom?.secretKeyRef?.name === "db-credentials") || !!ct?.envFrom?.some((e) => e.secretRef?.name === "db-credentials");
          const plain = !!ct?.env?.some((e) => e.name === "POSTGRES_PASSWORD" && e.value !== undefined);
          return fromSecret && !plain && rolledOut(x.cluster, "db") && readyCount(x.cluster, "db") === 1;
        },
        hints: [
          "The Pod starts, then exits within seconds, again and again. A program usually says why it quit before it does. Look at where a container's output goes.",
          "`kubectl logs deploy/db --previous` prints the output of the run that crashed.",
          "Postgres says `Database is uninitialized and superuser password is not specified` and asks for `POSTGRES_PASSWORD`. The container has no such variable, although the Secret `db-credentials` already holds one.",
          "Give the Deployment's container an environment variable that is filled from the Secret, not a literal value. The `set env` subcommand can read it from a Secret. Check the key name the Secret uses.",
        ],
        solution: { commands: ["kubectl set env deployment/db --from=secret/db-credentials"] },
      },
    ],
  },
  {
    slug: "readiness-wrong-port",
    difficulty: "medium",
    track: "workloads",
    title: "Running, but not serving",
    summary: "Every Pod is Running, none shows Ready, and traffic goes nowhere.",
    brief: "Since this morning's change to `web`, every Pod shows `0/1` under READY and the `web` Service sends traffic nowhere. nginx itself looks fine in the logs. The Deployment must keep a readiness probe.",
    minutes: 6,
    concepts: ["Readiness probe", "EndpointSlices"],
    setup: (c) => {
      deployment(c, "web", "nginx:1.27", 3, "default", { readinessProbe: { httpGet: { path: "/", port: 8080 }, periodSeconds: 5 } });
      service(c, "web", 80);
    },
    warmupMs: 20_000,
    steps: [
      {
        title: "All web Pods Ready and behind the Service",
        body: "All 3 `web` Pods are Ready and receive traffic from the Service, and they still have a readiness probe.",
        check: (x) => readyCount(x.cluster, "web") === 3 && endpointCount(x.cluster, "web") === 3 && podsWith(x.cluster, "app", "web").every((p) => !!p.spec?.containers[0].readinessProbe),
        hints: [
          "Nothing is crashing. The Pods are Running but not Ready, so the Service sends them no traffic. Something in the Pod decides when it counts as ready. Find where that is defined.",
          "`kubectl describe pods -l app=web` shows the probe settings and the latest warning. `kubectl get endpoints web` shows which Pods the Service uses.",
          "The warning says `Readiness probe failed: Get \"http://...:8080/\": ... connection refused`, and the Service has no endpoints. The probe checks port 8080, but nginx listens on port 80 by default.",
          "Keep the probe and correct the port it checks. The probe is part of the Deployment's Pod template, so a rollout replaces the Pods.",
        ],
        solution: { commands: [`kubectl patch deployment web -p '{"spec":{"template":{"spec":{"containers":[{"name":"web","readinessProbe":{"httpGet":{"path":"/","port":80}}}]}}}}'`] },
      },
    ],
  },
  {
    slug: "oversized-request",
    difficulty: "medium",
    track: "config",
    title: "Pending forever",
    summary: "A small app that has been Pending for an hour.",
    brief: "`report` has been Pending for an hour. It's a small reporting app that idles at about 50m CPU and 20Mi of memory.",
    minutes: 5,
    concepts: ["Resource requests", "FailedScheduling"],
    setup: (c) => deployment(c, "report", "nginx:1.27", 2, "default", { resources: { requests: { cpu: "6", memory: "256Mi" } } }),
    warmupMs: 10_000,
    steps: [
      {
        title: "Both report Pods Running",
        body: "Both `report` Pods are Running and Ready.",
        check: (x) => rolledOut(x.cluster, "report") && readyCount(x.cluster, "report") === 2,
        hints: [
          "The Pods never started anywhere. They sit Pending, which is the scheduler's decision and not the container's. Look for what the scheduler says about the Nodes it tried.",
          "`kubectl describe pods -l app=report` shows the scheduler's message in the Events. `kubectl describe nodes` shows how much each Node has to give.",
          "The message says `Insufficient cpu`. The Pods request `cpu: 6`, and each worker has far less than that allocatable. The scheduler places Pods by what they request, not by what they use.",
          "Lower the requests to something close to what the app really uses, with a little headroom. The brief gives the usage.",
        ],
        solution: { commands: ["kubectl set resources deployment report --requests=cpu=100m,memory=64Mi"] },
      },
    ],
  },
  {
    slug: "wrong-storageclass",
    start: ["kubectl get pvc", "kubectl get storageclass"],
    difficulty: "medium",
    track: "storage",
    title: "The cache won't start",
    summary: "A cache Pod that has been Pending since it was deployed.",
    brief: "`cache` (Redis) has been Pending since it was deployed here yesterday. Its data must stay on a persistent volume.",
    minutes: 7,
    concepts: ["PersistentVolumeClaim", "StorageClass", "ProvisioningFailed"],
    setup: (c) => {
      c.create({ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "data" }, spec: { storageClassName: "fast-ssd", accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } } as never);
      c.create({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "cache", labels: { app: "cache" } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "cache" } },
          template: {
            metadata: { labels: { app: "cache" } },
            spec: { containers: [{ name: "cache", image: "redis:7", volumeMounts: [{ name: "data", mountPath: "/data" }] }], volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data" } }] },
          },
        },
      });
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "cache running on a Bound claim",
        body: "The `cache` Pod is Running and Ready, and the claim it mounts is Bound.",
        check: (x) =>
          podsWith(x.cluster, "app", "cache").filter(up).some((p: Pod) => {
            const claim = p.spec?.volumes?.find((v) => v.persistentVolumeClaim)?.persistentVolumeClaim?.claimName;
            return !!claim && obj<PersistentVolumeClaim>(x.cluster, "PersistentVolumeClaim", claim)?.status?.phase === "Bound";
          }),
        hints: [
          "The Pod is Pending, and the scheduler has no complaint about the Nodes. It is waiting on something the Pod mounts. Follow the volume back to the object that should provide it.",
          "`kubectl describe pvc data` shows the claim's Events. `kubectl get storageclass` lists the classes this cluster has.",
          "The claim's Events say `storageclass.storage.k8s.io \"fast-ssd\" not found`. Only `standard` exists here, so nothing can provision the volume and the claim stays Pending.",
          "A claim's storage class can't be changed after it is created, so replace the claim. Create one that uses the cluster's class, or leaves the class out to get the default. If you give it a new name, point the Deployment at it.",
        ],
        solution: { commands: ["kubectl delete pvc data"], yaml: CACHE_FIXED },
      },
    ],
  },
  {
    slug: "forbidden-sa",
    start: ["kubectl get role,rolebinding -n apps", "kubectl describe rolebinding -n apps"],
    difficulty: "medium",
    track: "security",
    title: "The pipeline is Forbidden",
    summary: "A deploy pipeline whose runs all fail with Forbidden.",
    brief: "The deploy pipeline runs as ServiceAccount `deployer` in namespace `apps`. Every run fails with `deployments.apps \"web\" is forbidden: User \"system:serviceaccount:apps:deployer\" cannot patch resource \"deployments\"`. (That `system:serviceaccount:apps:deployer` string is how Kubernetes names the ServiceAccount `deployer` in namespace `apps`.) It must be able to patch Deployments in `apps`, and must not get more access than that.",
    minutes: 7,
    concepts: ["RBAC", "RoleBinding", "kubectl auth can-i"],
    setup: (c) => {
      ns(c, "apps");
      c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "deployer", namespace: "apps" } });
      c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "deploy-manager", namespace: "apps" }, rules: [{ apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list", "watch", "patch", "update"] }] } as never);
      c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "deployer-binding", namespace: "apps" }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "deploy-manager" }, subjects: [{ kind: "ServiceAccount", name: "deployer", namespace: "default" }] } as never);
      deployment(c, "web", "nginx:1.27", 2, "apps");
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "deployer may patch Deployments in apps",
        body: "`system:serviceaccount:apps:deployer` may patch Deployments in `apps`, and still may not read Secrets there.",
        check: (x) => can(x.cluster, "system:serviceaccount:apps:deployer", "patch", "deployments", "apps", "apps") && !can(x.cluster, "system:serviceaccount:apps:deployer", "get", "secrets", "apps"),
        hints: [
          "The Role grants the right verbs on the right resource, so the permission itself looks fine. A permission only counts for whoever it is bound to. Look at who the binding names.",
          "`kubectl auth can-i patch deployments -n apps --as=system:serviceaccount:apps:deployer` asks the API server directly. `kubectl describe rolebinding deployer-binding -n apps` lists the subjects.",
          "The answer is `no`. The binding's subject is the ServiceAccount `deployer` in the namespace `default`, not `apps`. A ServiceAccount is identified by its namespace as well as its name, so the binding grants nothing to `apps:deployer`.",
          "Correct the namespace of the subject so the binding names the ServiceAccount in `apps`. Then ask can-i again, and check that reading Secrets is still refused.",
        ],
        solution: { commands: ["kubectl delete rolebinding deployer-binding -n apps", "kubectl create rolebinding deployer-binding --role=deploy-manager --serviceaccount=apps:deployer -n apps"] },
      },
    ],
  },
  {
    slug: "egress-dns",
    start: ["kubectl get networkpolicy", "kubectl describe networkpolicy", "kubectl exec deploy/frontend -- wget -qO- --timeout=2 http://backend"],
    difficulty: "hard",
    track: "networking",
    title: "Frontend can't reach backend",
    summary: "A request from frontend to backend has failed since yesterday.",
    brief: "Since yesterday's security change, a request from a frontend Pod to `http://backend` fails. Frontend must stay locked down (it may not reach the internet), but it has to reach backend.",
    minutes: 10,
    concepts: ["NetworkPolicy", "Egress", "DNS"],
    setup: (c) => {
      deployment(c, "backend", "nginx:1.27", 2);
      service(c, "backend", 80);
      deployment(c, "frontend", "busybox", 1, "default", { command: ["sh", "-c", "sleep 3600"] });
      c.create({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "frontend-egress" },
        spec: { podSelector: { matchLabels: { app: "frontend" } }, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: { matchLabels: { app: "backend" } } }], ports: [{ port: 80 }] }] },
      } as never);
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "frontend reaches backend by name, and nothing else outside",
        body: "The `frontend` Pod can look up and reach `http://backend`, its egress is still restricted by a NetworkPolicy, and it can't reach addresses outside the cluster.",
        check: (x) => {
          const fe = podsWith(x.cluster, "app", "frontend").find(up);
          if (!fe) return false;
          return isIsolated(x.cluster, fe, "Egress") && dnsAllowed(x.cluster, fe) && reaches(x.cluster, fe, "backend", 80) && !egressAllowed(x.cluster, fe, { ip: "93.184.216.34" }, 443).ok;
        },
        hints: [
          "The request never gets as far as the backend. Before a client can connect to a name, something has to turn that name into an address. Read the error again and decide which of those two steps failed.",
          "`kubectl exec deploy/frontend -- nslookup backend` tests the name lookup on its own. `kubectl describe networkpolicy frontend-egress` shows what frontend is allowed to reach.",
          "The lookup times out, and the policy allows only Pods labelled `app=backend` on port 80. Names are resolved by CoreDNS in `kube-system`, on port 53. Once a policy restricts egress, anything it doesn't list is blocked, DNS included.",
          "Keep the rule for backend and add a second one that lets frontend reach the DNS Pods on port 53, over UDP and TCP. Select them by namespace and label: `kubectl get pods -n kube-system --show-labels` shows both. Don't open egress to everything.",
        ],
        solution: { yaml: FRONTEND_EGRESS_FIXED },
      },
    ],
  },
  {
    slug: "after-maintenance",
    start: ["kubectl get nodes", "kubectl describe nodes"],
    difficulty: "hard",
    track: "operations",
    title: "Nothing new will start",
    summary: "A Deployment stuck Pending, and no new Pod lands anywhere.",
    brief: "Since last night `web` has been stuck Pending, and nothing new gets scheduled on either worker. Don't give `web` special treatment to get around it.",
    minutes: 8,
    concepts: ["Taints", "Cordon", "FailedScheduling"],
    setup: (c) => {
      const w1 = c.get<Node>("Node", undefined, "worker-1");
      c.replace({ ...w1, spec: { ...w1.spec, taints: [{ key: "maintenance", value: "true", effect: "NoSchedule" }] } });
      const w2 = c.get<Node>("Node", undefined, "worker-2");
      c.replace({ ...w2, spec: { ...w2.spec, unschedulable: true } });
      deployment(c, "web", "nginx:1.27", 4);
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "web running, both workers open again",
        body: "All 4 `web` Pods are Running, and both worker Nodes accept new Pods: not cordoned, no leftover taints.",
        check: (x) => {
          const open = ["worker-1", "worker-2"].every((n) => {
            const node = obj<Node>(x.cluster, "Node", n, undefined);
            return !!node && !node.spec?.unschedulable && !(node.spec?.taints ?? []).some((t) => !t.key.startsWith("node.kubernetes.io/"));
          });
          return open && readyCount(x.cluster, "web") === 4 && allPodsOf(dep(x.cluster, "web"), (s) => !s?.template.spec.tolerations?.length);
        },
        hints: [
          "Pods stay Pending and nothing schedules anywhere. No Node is down, but two of them behave differently from the rest. Look at what each Node says about itself, and whether it will accept new Pods.",
          "`kubectl get nodes` shows each Node's status. `kubectl describe node worker-1` and `kubectl describe node worker-2` show their taints. `kubectl describe pods -l app=web` shows the scheduler's message.",
          "`worker-2` is `Ready,SchedulingDisabled`: someone cordoned it. `worker-1` has the taint `maintenance=true:NoSchedule`, which keeps out every Pod that doesn't tolerate it. The scheduler counts both: `1 node(s) were unschedulable, 2 node(s) had untolerated taint(s)`. The control plane's own taint is the second one, and it stays.",
          "Undo each half of the maintenance on its own Node. Remove the taint from `worker-1` and uncordon `worker-2`. Leave the control plane alone.",
        ],
        solution: { commands: ["kubectl taint nodes worker-1 maintenance=true:NoSchedule-", "kubectl uncordon worker-2"] },
      },
    ],
  },
  ...WORKLOADS_CHALLENGES,
  ...NETWORKING_CHALLENGES,
  ...SECURITY_CHALLENGES,
];

export const challengeBySlug = (slug: string) => CHALLENGES.find((c) => c.slug === slug);

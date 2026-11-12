// The v1 curriculum. Each Lesson has a starting cluster and Steps; a Step is
// done when its Check passes against the live cluster (re-checked every frame).

import YAML from "yaml";
import type { Cluster, ConfigMap, CronJob, Deployment, Endpoints, HorizontalPodAutoscaler, Job, Node, PersistentVolume, PersistentVolumeClaim, Pod, Role, Service, StatefulSet } from "@/lib/engine";
import { authorize, connectionAllowed, isIsolated, isPodReady, jobComplete, jobFailed, routeIngress, userFor } from "@/lib/engine";
import { dnsAllowed } from "@/lib/engine/netpol";
import { TRACKS, trackOf, type TrackId } from "./meta";

export interface CheckContext {
  cluster: Cluster;
  /** Command lines the Learner has run, oldest first. */
  history: string[];
}

export interface Step {
  title: string;
  /** Tiny markdown: paragraphs, **bold**, `code`, ```bash / ```yaml fences. */
  body: string;
  check: (ctx: CheckContext) => boolean;
  hint: string;
  /** Commands "Show me" runs, or a YAML manifest it applies. */
  solution: { commands?: string[] | ((c: Cluster) => string[]); yaml?: string };
}

export interface Lesson {
  slug: string;
  title: string;
  /** One or two words for tight spaces, like the track previews on the home page. Defaults to the title. */
  short?: string;
  summary: string;
  minutes: number;
  concepts: string[];
  /** Which part of the curriculum map this Lesson sits in (see TRACKS). */
  track?: TrackId;
  setup?: (c: Cluster) => void;
  warmupMs?: number;
  /** Initial YAML editor contents. */
  editor?: string;
  /** Which dock tab to open first. */
  startTab?: "terminal" | "editor";
  steps: Step[];
}

// ---------------------------------------------------------------- helpers

const ran = (ctx: CheckContext, re: RegExp) => ctx.history.some((h) => re.test(h));
/** `kubectl logs` for a target (a regex source), with flags like -f or --tail anywhere on the line. */
const logsOf = (target: string) => new RegExp(`\\bkubectl logs\\b(?:.*\\s)?(?:${target})(?:\\s|$)`);
/** `kubectl get pods` (or `get all`) scoped to a namespace, however the namespace flag is spelled. */
const listedPodsIn = (ns: string) => new RegExp(`\\bkubectl\\b(?=.*\\sget\\s+(?:pods?|po|all)\\b)(?=.*(?:\\s-n[\\s=]?${ns}\\b|\\s--namespace[\\s=]${ns}\\b|\\s-A\\b|\\s--all-namespaces\\b))`);
const pod = (c: Cluster, name: string, ns = "default") => c.raw("Pod", ns, name) as unknown as Pod | undefined;
const podsWith = (c: Cluster, key: string, value: string, ns = "default") => c.list<Pod>("Pod", ns).filter((p) => p.metadata.labels?.[key] === value && !p.metadata.deletionTimestamp);
const readyCount = (c: Cluster, app: string, ns = "default") => podsWith(c, "app", app, ns).filter(isPodReady).length;
const dep = (c: Cluster, name: string, ns = "default") => c.raw("Deployment", ns, name) as unknown as Deployment | undefined;
const rolledOut = (c: Cluster, name: string, ns = "default") => {
  const d = dep(c, name, ns);
  if (!d) return false;
  const want = d.spec?.replicas ?? 1;
  const s = d.status ?? {};
  return s.updatedReplicas === want && s.availableReplicas === want && (s.replicas ?? 0) === want;
};
const waitingReason = (p: Pod) => p.status?.containerStatuses?.[0]?.state.waiting?.reason;

function deployment(c: Cluster, name: string, image: string, replicas: number, ns = "default", extra: Record<string, unknown> = {}) {
  c.create({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: ns, labels: { app: name } },
    spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image, ...extra }] } } },
  });
}


// ---------------------------------------------------------------- v2 helpers

const obj = <T>(c: Cluster, kind: string, name: string, ns: string | undefined = "default") => c.raw(kind, ns, name) as unknown as T | undefined;
const up = (p: Pod | undefined): p is Pod => !!p && !p.metadata.deletionTimestamp && isPodReady(p);
const restarts = (p?: Pod) => p?.status?.containerStatuses?.[0]?.restartCount ?? 0;
const endpointCount = (c: Cluster, svc: string, ns = "default", which: "addresses" | "notReadyAddresses" = "addresses") =>
  (obj<Endpoints>(c, "Endpoints", svc, ns)?.subsets ?? []).reduce((n, s) => n + (s[which]?.length ?? 0), 0);
const lastExit = (p?: Pod) => {
  const cs = p?.status?.containerStatuses?.[0];
  return cs?.state.terminated?.reason ?? cs?.lastState?.terminated?.reason;
};
const unscheduled = (p: Pod) => !p.spec?.nodeName && !p.metadata.deletionTimestamp && !!p.status?.conditions?.some((x) => x.type === "PodScheduled" && x.status === "False");
const firstContainer = (d?: Deployment) => d?.spec?.template.spec.containers[0];
/** Files in the volume bound to a claim (what `ls` inside a Pod mounting it shows). */
const claimFiles = (c: Cluster, claim: string, ns = "default"): Record<string, string> => {
  const pv = obj<PersistentVolumeClaim>(c, "PersistentVolumeClaim", claim, ns)?.spec?.volumeName;
  return pv ? (c.state.volumes[`pv/${pv}`] ?? {}) : {};
};
/** A stand-in Pod with these labels, for NetworkPolicy Checks: nothing is created. */
const fakePod = (labels: Record<string, string>, ns = "default") =>
  ({ apiVersion: "v1", kind: "Pod", metadata: { name: "check", namespace: ns, labels, uid: "", resourceVersion: "", creationTimestamp: 0 }, spec: { containers: [] }, status: { phase: "Running", podIP: "10.244.1.250" } }) as unknown as Pod;
/** Could a Pod like `from` open a connection to a ready Pod of `app` on `port`? */
const reaches = (c: Cluster, from: Pod, app: string, port: number, ns = "default") =>
  podsWith(c, "app", app, ns).filter(up).some((p) => connectionAllowed(c, { pod: from, ip: from.status!.podIP! }, p, port));
const can = (c: Cluster, who: string, verb: string, resource: string, ns?: string, group = "") => authorize(c, userFor(who), { verb, group, resource, namespace: ns });
const routeTo = (c: Cluster, host: string, path: string) => routeIngress(c, host, path)?.backend.service?.name;

function service(c: Cluster, name: string, port: number, targetPort = port, ns = "default") {
  c.create({ apiVersion: "v1", kind: "Service", metadata: { name, namespace: ns, labels: { app: name } }, spec: { selector: { app: name }, ports: [{ port, targetPort }] } });
}

// ---------------------------------------------------------------- v2 manifests

const WEB_READINESS = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: nginx:1.27
        readinessProbe:
          httpGet:
            path: /
            port: 80
          periodSeconds: 5
`;

const LIVENESS_POD = `apiVersion: v1
kind: Pod
metadata:
  name: liveness
spec:
  containers:
  - name: app
    image: busybox
    command: ["sh", "-c", "touch /tmp/healthy; sleep 3600"]
    livenessProbe:
      exec:
        command: ["cat", "/tmp/healthy"]
      periodSeconds: 5
`;

const BATCH_JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: batch
spec:
  completions: 6
  parallelism: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: worker
        image: busybox
        command: ["sh", "-c", "echo processing one item; sleep 5"]
`;

const FLAKY_JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: flaky
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: task
        image: busybox
        command: ["sh", "-c", "echo connecting to the database...; exit 1"]
`;

const API_RESOURCES = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
      - name: api
        image: nginx:1.27
        resources:
          requests:
            cpu: 250m
            memory: 64Mi
          limits:
            cpu: 500m
            memory: 128Mi
`;

const BIG_DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: big
spec:
  replicas: 3
  selector:
    matchLabels:
      app: big
  template:
    metadata:
      labels:
        app: big
    spec:
      containers:
      - name: big
        image: nginx:1.27
        resources:
          requests:
            cpu: "3"
`;

const MEMORY_DEMO = `apiVersion: v1
kind: Pod
metadata:
  name: memory-demo
spec:
  containers:
  - name: memory-demo-ctr
    image: polinux/stress
    resources:
      requests:
        memory: 50Mi
      limits:
        memory: 100Mi
    command: ["stress"]
    args: ["--vm", "1", "--vm-bytes", "250M", "--vm-hang", "1"]
`;

const APP_ENV_POD = `apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  containers:
  - name: app
    image: busybox
    command: ["sh", "-c", "echo color=$COLOR mode=$MODE; sleep 3600"]
    envFrom:
    - configMapRef:
        name: app-config
`;

const DB_SECRET_POD = `apiVersion: v1
kind: Pod
metadata:
  name: db
spec:
  containers:
  - name: postgres
    image: postgres:16
    env:
    - name: POSTGRES_PASSWORD
      valueFrom:
        secretKeyRef:
          name: db-pass
          key: password
`;

const WEB_CONFIGMAP_VOLUME = `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-html
data:
  index.html: Version 1
---
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
  - name: nginx
    image: nginx:1.27
    volumeMounts:
    - name: html
      mountPath: /usr/share/nginx/html
  volumes:
  - name: html
    configMap:
      name: web-html
`;

const HELLO_INGRESS = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hello
spec:
  ingressClassName: nginx
  rules:
  - host: hello-world.example
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 8080
      - path: /v2
        pathType: Prefix
        backend:
          service:
            name: web2
            port:
              number: 8080
`;

const DEFAULT_DENY = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes:
  - Ingress
`;

const ALLOW_FRONTEND = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-allow-frontend
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    ports:
    - port: 80
`;

const ALLOW_MONITORING = `apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-allow-monitoring
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
`;

const FRONTEND_EGRESS = `apiVersion: networking.k8s.io/v1
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
`;

const FRONTEND_EGRESS_DNS = `${FRONTEND_EGRESS}  - to:
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

const DATA_PVC = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`;

const claimPod = (name: string, script: string) => `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  containers:
  - name: app
    image: busybox
    command: ["sh", "-c", "${script}"]
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: data
`;
const WRITER_POD = claimPod("writer", "date >> /data/log.txt; sleep 3600");
const READER_POD = claimPod("reader", "cat /data/note.txt /data/log.txt; sleep 3600");

const WEB_STATEFULSET = `apiVersion: v1
kind: Service
metadata:
  name: nginx
spec:
  clusterIP: None
  selector:
    app: nginx
  ports:
  - port: 80
    name: web
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: nginx
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.27
        ports:
        - containerPort: 80
          name: web
        volumeMounts:
        - name: www
          mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
  - metadata:
      name: www
    spec:
      accessModes:
      - ReadWriteOnce
      resources:
        requests:
          storage: 1Gi
`;

const SSD_POD = `apiVersion: v1
kind: Pod
metadata:
  name: fast
spec:
  nodeSelector:
    disktype: ssd
  containers:
  - name: nginx
    image: nginx:1.27
`;

const TOLERATING_POD = `apiVersion: v1
kind: Pod
metadata:
  name: db
spec:
  tolerations:
  - key: dedicated
    operator: Equal
    value: db
    effect: NoSchedule
  nodeSelector:
    kubernetes.io/hostname: worker-1
  containers:
  - name: redis
    image: redis:7
`;

const PHP_APACHE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: php-apache
spec:
  selector:
    matchLabels:
      run: php-apache
  template:
    metadata:
      labels:
        run: php-apache
    spec:
      containers:
      - name: php-apache
        image: registry.k8s.io/hpa-example
        ports:
        - containerPort: 80
        resources:
          limits:
            cpu: 500m
          requests:
            cpu: 200m
---
apiVersion: v1
kind: Service
metadata:
  name: php-apache
  labels:
    run: php-apache
spec:
  ports:
  - port: 80
  selector:
    run: php-apache
`;

const LOAD_GENERATOR = `kubectl run load-generator --image=busybox:1.28 --restart=Never -- /bin/sh -c "while sleep 0.01; do wget -q -O- http://php-apache; done"`;
const CI = "system:serviceaccount:dev:ci";

const yamlBlock = (y: string) => "```yaml\n" + y + "```";

// ---------------------------------------------------------------- lessons

export const LESSONS: Lesson[] = [
  {
    slug: "first-pod",
    track: "foundations",
    title: "Your first Pod",
    short: "First Pod",
    summary: "Meet the cluster, run a container in a Pod, read its logs, and see what happens when you delete it.",
    minutes: 6,
    concepts: ["Node", "Pod", "kubectl"],
    steps: [
      {
        title: "Look at the cluster",
        body: "A Kubernetes **cluster** is a group of machines called **Nodes**. On the canvas you can see three: a control-plane (the brain) and two workers (where your apps run).\n\n```illustration architecture```\n\nAsk the cluster for its Nodes:\n\n```bash\nkubectl get nodes\n```",
        check: (x) => ran(x, /kubectl get (nodes|node|no)\b/),
        hint: "Type the command in the Terminal below and press Enter.",
        solution: { commands: ["kubectl get nodes"] },
      },
      {
        title: "Run a Pod",
        body: "The smallest thing Kubernetes runs is a **Pod**: one or more containers that share one IP address and can reach each other on `localhost`. Create one running the `nginx` web server:\n\n```bash\nkubectl run web --image=nginx\n```\n\nWatch the canvas: the Pod appears in the **scheduler queue**, gets placed on a worker, pulls its image, and starts.",
        check: (x) => !!pod(x.cluster, "web"),
        hint: "kubectl run NAME --image=IMAGE",
        solution: { commands: ["kubectl run web --image=nginx"] },
      },
      {
        title: "Wait for it to be Running",
        body: "Check its status. Run this a few times: the `STATUS` column shows `Pending`, then `ContainerCreating`, then `Running`. This step is done once the Pod is Ready, shown as `1/1` under `READY` (one of one containers ready):\n\n```bash\nkubectl get pods -o wide\n```\n\nThe `-o wide` flag adds the Pod's IP address and which Node it landed on.",
        check: (x) => {
          const p = pod(x.cluster, "web");
          return !!p && isPodReady(p) && ran(x, /kubectl get (pods|pod|po)/);
        },
        hint: "Pods take a few seconds to pull their image. Speed up time with the 5× button if you're impatient.",
        solution: { commands: ["kubectl get pods -o wide"] },
      },
      {
        title: "Read its logs",
        body: "Containers write to stdout; Kubernetes keeps it for you. Read the nginx startup messages:\n\n```bash\nkubectl logs web\n```\n\nYou can also click the Pod on the canvas and open **Inspect** to see its logs and events.",
        check: (x) => ran(x, logsOf("(?:pods?/)?web")),
        hint: "kubectl logs POD_NAME",
        solution: { commands: ["kubectl logs web"] },
      },
      {
        title: "Delete it",
        body: "Now delete the Pod:\n\n```bash\nkubectl delete pod web\n```\n\nNotice it's **gone for good**. A bare Pod has nobody watching over it. In the next lessons you'll meet the controllers that bring Pods back.",
        check: (x) => !pod(x.cluster, "web") && ran(x, /kubectl delete (pod|pods|po)[ /]web/),
        hint: "kubectl delete pod NAME",
        solution: { commands: ["kubectl delete pod web"] },
      },
    ],
  },
  {
    slug: "declarative-yaml",
    track: "foundations",
    title: "Declarative YAML",
    short: "YAML",
    summary: "Describe what you want in a manifest and let Kubernetes make it so. Apply, edit, re-apply.",
    minutes: 7,
    concepts: ["Manifest", "kubectl apply", "Desired state"],
    startTab: "editor",
    editor: `# A Pod described as YAML. Press "kubectl apply" to create it.
apiVersion: v1
kind: Pod
metadata:
  name: hello
  labels:
    app: hello
spec:
  containers:
  - name: hello
    image: busybox
    command: ["sh", "-c", "while true; do echo hello from $HOSTNAME; sleep 5; done"]
`,
    steps: [
      {
        title: "Apply a Pod manifest",
        body: "`kubectl run` is handy, but real teams write **manifests**: YAML files that describe the *desired state*. Kubernetes' job is to make reality match.\n\nThe **YAML editor** below has a Pod manifest. Read it, then press **kubectl apply -f manifest.yaml**.\n\nStep through what happens behind the scenes when you apply:\n\n```illustration apply```",
        // Wait for Running so the next Step's `kubectl logs` has output to show.
        check: (x) => pod(x.cluster, "hello")?.status?.phase === "Running",
        hint: "Open the YAML editor tab and click the black Apply button, then give the Pod a few seconds to start.",
        solution: { yaml: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: hello\n  labels:\n    app: hello\nspec:\n  containers:\n  - name: hello\n    image: busybox\n    command: ["sh", "-c", "while true; do echo hello from $HOSTNAME; sleep 5; done"]\n` },
      },
      {
        title: "Watch its output",
        body: "This Pod prints a line every 5 seconds. Read what it has printed so far:\n\n```bash\nkubectl logs hello\n```\n\nAdd `-f` to keep following new lines (Ctrl+C stops).",
        check: (x) => ran(x, logsOf("(?:pods?/)?hello")),
        hint: "Switch to the Terminal tab.",
        solution: { commands: ["kubectl logs hello"] },
      },
      {
        title: "Apply a Deployment",
        body: "Replace the editor's contents with a **Deployment** that asks for 2 copies of nginx, then apply it:\n\n```yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n```\n\nThe **template** is a Pod recipe; the Deployment stamps out `replicas` Pods from it.",
        check: (x) => !!dep(x.cluster, "web"),
        hint: "Use \"Open in editor\" on the YAML block, then Apply.",
        solution: { yaml: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n` },
      },
      {
        title: "Change the desired state",
        body: "Edit the manifest: change `replicas: 2` to `replicas: 5` and apply again. Kubernetes reports `configured`, and the Deployment adds three Pods.\n\nApplying the same file twice with no changes reports `unchanged`. That's the declarative model: you say *what*, not *how*.",
        check: (x) => (dep(x.cluster, "web")?.spec?.replicas ?? 0) === 5 && readyCount(x.cluster, "web") === 5,
        hint: "Edit the number in the editor, apply, then wait for 5 Pods to be ready.",
        solution: { yaml: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 5\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n` },
      },
    ],
  },
  {
    slug: "replicasets-self-healing",
    track: "foundations",
    title: "ReplicaSets & self-healing",
    short: "ReplicaSets",
    summary: "See the control loop that replaces lost Pods, and how labels decide which Pods a ReplicaSet owns.",
    minutes: 7,
    concepts: ["ReplicaSet", "Labels & selectors", "Control loop"],
    setup: (c) => deployment(c, "web", "nginx:1.27", 3),
    warmupMs: 10_000,
    steps: [
      {
        title: "Find the ReplicaSet",
        body: "A Deployment called `web` is already running. On the canvas, follow the lines: **Deployment → ReplicaSet → Pods**. The ReplicaSet is the part that keeps the Pod count right.\n\n```bash\nkubectl get replicasets\n```\n\n`DESIRED` is what it wants; `CURRENT` is what exists.",
        check: (x) => ran(x, /kubectl get (rs|replicasets?)\b/),
        hint: "kubectl get rs is the short form.",
        solution: { commands: ["kubectl get rs"] },
      },
      {
        title: "Delete a Pod and watch it heal",
        body: "Pick any `web` Pod (click one on the canvas to see its name, or use Tab completion) and delete it:\n\n```bash\nkubectl delete pod <name>\n```\n\nWithin a second a replacement appears. The ReplicaSet saw 2 < 3 and fixed it. That loop (observe → compare → act) is how every Kubernetes controller works.",
        check: (x) => ran(x, /kubectl delete (pod|pods|po)[ /]web-/) && readyCount(x.cluster, "web") === 3,
        hint: "Type kubectl delete pod web- and press Tab to complete a name.",
        solution: { commands: (c) => [`kubectl delete pod ${podsWith(c, "app", "web")[0]?.metadata.name}`] },
      },
      {
        title: "Take a Pod out with a label",
        body: "A ReplicaSet finds its Pods by **label** (`app=web`), not by name. Change one Pod's label and it's no longer counted:\n\n```bash\nkubectl label pod <name> app=debug --overwrite\n```\n\nThe ReplicaSet creates a new Pod to get back to 3, and your relabelled Pod keeps running on its own: handy for debugging a live Pod.",
        check: (x) => podsWith(x.cluster, "app", "debug").length > 0 && readyCount(x.cluster, "web") === 3,
        hint: "Use a full Pod name from kubectl get pods.",
        solution: { commands: (c) => [`kubectl label pod ${podsWith(c, "app", "web")[0]?.metadata.name} app=debug --overwrite`] },
      },
      {
        title: "See the labels",
        body: "Show every Pod with its labels:\n\n```bash\nkubectl get pods --show-labels\n```\n\nOr filter with a selector, the same way the ReplicaSet does:\n\n```bash\nkubectl get pods -l app=web\n```",
        check: (x) => ran(x, /kubectl get (pods|pod|po)\b.*(\s-l[\s=]?\S|\s--selector[\s=])/),
        hint: "Try the -l flag.",
        solution: { commands: ["kubectl get pods -l app=web"] },
      },
    ],
  },
  {
    slug: "deployments-scaling",
    track: "workloads",
    title: "Deployments & scaling",
    short: "Deployments",
    summary: "Create a Deployment from the command line and scale it up and down.",
    minutes: 5,
    concepts: ["Deployment", "Scaling", "Scheduling"],
    steps: [
      {
        title: "Create a Deployment",
        body: "```bash\nkubectl create deployment api --image=nginxdemos/hello:plain-text --replicas=2\n```\n\nThe Deployment creates a ReplicaSet, which creates 2 Pods. The scheduler usually spreads them across workers, so one Node failing doesn't take everything down. That spreading is best-effort, not a promise: if you need a guarantee, add `topologySpreadConstraints` to the Pod template.",
        check: (x) => readyCount(x.cluster, "api") === 2,
        hint: "Wait until both Pods show Running.",
        solution: { commands: ["kubectl create deployment api --image=nginxdemos/hello:plain-text --replicas=2"] },
      },
      {
        title: "Scale up",
        body: "Traffic is growing. Ask for 6 replicas:\n\n```bash\nkubectl scale deployment api --replicas=6\n```\n\nWatch the new Pods spread across both workers, usually about evenly (best-effort, as above).",
        check: (x) => (dep(x.cluster, "api")?.spec?.replicas ?? 0) === 6 && readyCount(x.cluster, "api") === 6,
        hint: "kubectl scale deployment NAME --replicas=N",
        solution: { commands: ["kubectl scale deployment api --replicas=6"] },
      },
      {
        title: "Scale down",
        body: "Now scale down to 1. Kubernetes picks which Pods to remove (it prefers ones that aren't ready yet, and Nodes with the most copies).\n\n```bash\nkubectl scale deployment api --replicas=1\n```",
        check: (x) => (dep(x.cluster, "api")?.spec?.replicas ?? 0) === 1 && podsWith(x.cluster, "app", "api").length === 1,
        hint: "Terminating Pods take a moment to disappear.",
        solution: { commands: ["kubectl scale deployment api --replicas=1"] },
      },
      {
        title: "Describe it",
        body: "`describe` gives the full story of an object, including the events that led here:\n\n```bash\nkubectl describe deployment api\n```\n\nLook for the `ScalingReplicaSet` events at the bottom.",
        check: (x) => ran(x, /kubectl describe (deployments?(\.apps)?|deploy)[ /]api\b/),
        hint: "kubectl describe deployment api",
        solution: { commands: ["kubectl describe deployment api"] },
      },
    ],
  },
  {
    slug: "rolling-updates",
    track: "workloads",
    title: "Rolling updates & rollbacks",
    short: "Rollouts",
    summary: "Ship a new version with zero downtime, break a rollout on purpose, and undo it.",
    minutes: 8,
    concepts: ["Rolling update", "Revision history", "Rollback"],
    setup: (c) => deployment(c, "web", "nginx:1.26", 4),
    warmupMs: 12_000,
    steps: [
      {
        title: "Update the image",
        body: "`web` runs `nginx:1.26`. Upgrade it:\n\n```bash\nkubectl set image deployment/web web=nginx:1.27\n```\n\nWatch the canvas: a **new ReplicaSet** (new colour) appears. Pods move over a few at a time. By default a rollout may run 25% more Pods than asked for (`maxSurge`) and have 25% of them unavailable (`maxUnavailable`): with 4 replicas, one old Pod goes straight away while two new ones start, and the rest of the old Pods leave only as new ones become Ready. At least 3 Pods keep serving throughout.",
        check: (x) => rolledOut(x.cluster, "web") && podsWith(x.cluster, "app", "web").every((p) => p.spec!.containers[0].image === "nginx:1.27"),
        hint: "The container is named web, so the argument is web=nginx:1.27.",
        solution: { commands: ["kubectl set image deployment/web web=nginx:1.27"] },
      },
      {
        title: "Check the history",
        body: "Each template change is a **revision**. The old ReplicaSet is kept at 0 Pods so you can go back.\n\n```bash\nkubectl rollout history deployment/web\n```",
        check: (x) => ran(x, /kubectl rollout history/),
        hint: "kubectl rollout history deployment/web",
        solution: { commands: ["kubectl rollout history deployment/web"] },
      },
      {
        title: "Ship a broken version",
        body: "Now make a typo on purpose:\n\n```bash\nkubectl set image deployment/web web=ngnix:1.27\n```\n\nThe two new Pods can't pull their image (`ErrImagePull`, then `ImagePullBackOff`). But look: three old Pods **keep serving**, because `maxUnavailable` stops the rollout from taking down more. The rollout is stuck, not broken.",
        check: (x) => podsWith(x.cluster, "app", "web").some((p) => ["ErrImagePull", "ImagePullBackOff"].includes(waitingReason(p) ?? "")),
        hint: "It takes a couple of seconds for the pull to fail.",
        solution: { commands: ["kubectl set image deployment/web web=ngnix:1.27"] },
      },
      {
        title: "Roll back",
        body: "Undo the last change:\n\n```bash\nkubectl rollout undo deployment/web\n```\n\nThe Deployment switches back to the previous ReplicaSet and the broken Pods are removed.",
        check: (x) => rolledOut(x.cluster, "web") && podsWith(x.cluster, "app", "web").every((p) => p.spec!.containers[0].image === "nginx:1.27"),
        hint: "kubectl rollout undo deployment/web",
        solution: { commands: ["kubectl rollout undo deployment/web"] },
      },
    ],
  },
  {
    slug: "services",
    track: "foundations",
    title: "Services & networking",
    short: "Services",
    summary: "Give a set of Pods one stable address, load-balance across them, and reach them from outside.",
    minutes: 8,
    concepts: ["Service", "EndpointSlice", "DNS", "NodePort"],
    setup: (c) => deployment(c, "hello", "nginxdemos/hello:plain-text", 3),
    warmupMs: 10_000,
    steps: [
      {
        title: "Pods come and go",
        body: "Every Pod gets its own IP, but Pods are replaced all the time, so IPs change. See them:\n\n```bash\nkubectl get pods -o wide\n```",
        check: (x) => ran(x, /kubectl get (pods|pod|po)\b.*-o( |=)?wide/),
        hint: "Add -o wide.",
        solution: { commands: ["kubectl get pods -o wide"] },
      },
      {
        title: "Expose them with a Service",
        body: "A **Service** gives a group of Pods (picked by label) one stable IP and DNS name:\n\n```bash\nkubectl expose deployment hello --port=80\n```\n\nOn the canvas, the Service connects to every ready Pod. Here is how that works under the hood:\n\n```illustration service```",
        check: (x) => !!x.cluster.raw("Service", "default", "hello"),
        hint: "kubectl expose deployment NAME --port=80",
        solution: { commands: ["kubectl expose deployment hello --port=80"] },
      },
      {
        title: "Send traffic",
        body: "Call the Service by name. Run it several times and watch different Pods answer (`Server name`):\n\n```bash\ncurl http://hello\n```\n\nA shortcut: the simulator's terminal can call Services by name, the way a Pod inside the cluster would. On a real cluster a `ClusterIP` Service name only resolves from inside a Pod, not from your laptop; you'd run the same request from a throwaway Pod, e.g. `kubectl run tmp --rm -it --image=busybox -- wget -qO- http://hello`.",
        check: (x) => x.history.filter((h) => /curl .*hello/.test(h)).length >= 3,
        hint: "Run curl at least three times. ↑ recalls the last command.",
        solution: { commands: ["curl http://hello", "curl http://hello", "curl http://hello"] },
      },
      {
        title: "Look at the EndpointSlices",
        body: "Kubernetes keeps a live list of the Pods behind the Service, with their IPs and whether each is ready, in **EndpointSlices**. Each slice is labelled with its Service's name:\n\n```bash\nkubectl get endpointslices -l kubernetes.io/service-name=hello\n```\n\nDelete a Pod and run it again: the old Pod's IP goes and its replacement's appears.\n\nEndpointSlices have been the standard since v1.21. You'll still see `kubectl get endpoints` in older guides: the v1 Endpoints API works, but it has been deprecated since v1.33.",
        check: (x) => ran(x, /kubectl (get|describe) (endpointslices?|endpoints|ep)\b/) || ran(x, /kubectl describe (svc|services?)\b/),
        hint: "kubectl get endpointslices -l kubernetes.io/service-name=hello",
        solution: { commands: ["kubectl get endpointslices -l kubernetes.io/service-name=hello"] },
      },
      {
        title: "Open it to the outside",
        body: "A `ClusterIP` Service only works inside the cluster. A **NodePort** Service also opens a port on every Node:\n\n```bash\nkubectl expose deployment hello --port=80 --type=NodePort --name=hello-public\nkubectl get svc hello-public\n```\n\nThen curl any Node's IP on that port, e.g. `curl http://172.18.0.3:<nodePort>`.",
        check: (x) => (x.cluster.raw("Service", "default", "hello-public") as unknown as Service | undefined)?.spec?.type === "NodePort" && ran(x, /curl .*172\.18\.0\.\d+:\d+/),
        hint: "Find the nodePort in the PORT(S) column: 80:3XXXX/TCP.",
        solution: {
          commands: (c) => {
            const svc = c.raw("Service", "default", "hello-public") as unknown as Service | undefined;
            return svc
              ? [`curl http://172.18.0.3:${svc.spec?.ports?.[0]?.nodePort}`]
              : ["kubectl expose deployment hello --port=80 --type=NodePort --name=hello-public", "kubectl get svc hello-public"];
          },
        },
      },
    ],
  },
  {
    slug: "namespaces",
    track: "foundations",
    title: "Namespaces",
    short: "Namespaces",
    summary: "Split one cluster into separate spaces for teams or environments.",
    minutes: 5,
    concepts: ["Namespace", "Scope", "Context"],
    steps: [
      {
        title: "List namespaces",
        body: "Namespaces group objects so names don't clash. A new cluster already has a few:\n\n```bash\nkubectl get namespaces\n```\n\n`kube-system` holds Kubernetes' own components (toggle **System pods** in the Sandbox to see them).",
        check: (x) => ran(x, /kubectl get (namespaces?|ns)\b/),
        hint: "kubectl get ns is the short form.",
        solution: { commands: ["kubectl get ns"] },
      },
      {
        title: "Create one",
        body: "```bash\nkubectl create namespace team-a\n```",
        check: (x) => !!x.cluster.raw("Namespace", undefined, "team-a"),
        hint: "kubectl create namespace NAME",
        solution: { commands: ["kubectl create namespace team-a"] },
      },
      {
        title: "Deploy into it",
        body: "Most commands take `-n` (or `--namespace`) to pick a namespace. `kubectl create deployment` makes a Deployment without writing YAML:\n\n```bash\nkubectl create deployment shop --image=nginx -n team-a\nkubectl get pods -n team-a\n```\n\nWithout `-n` you're in `default`, so `kubectl get pods` alone won't show them. Try `kubectl get pods -A` to see every namespace.",
        check: (x) => readyCount(x.cluster, "shop", "team-a") >= 1 && ran(x, listedPodsIn("team-a")),
        hint: "Remember the -n team-a flag on both commands.",
        solution: { commands: ["kubectl create deployment shop --image=nginx -n team-a", "kubectl get pods -n team-a"] },
      },
      {
        title: "Delete the namespace",
        body: "Deleting a namespace deletes **everything in it**:\n\n```bash\nkubectl delete namespace team-a\n```\n\nIt shows `Terminating` while its contents shut down.",
        check: (x) => !x.cluster.raw("Namespace", undefined, "team-a"),
        hint: "It takes a few seconds for the Pods to stop.",
        solution: { commands: ["kubectl delete namespace team-a"] },
      },
    ],
  },
  {
    slug: "troubleshooting",
    track: "operations",
    title: "Troubleshooting",
    short: "Troubleshooting",
    summary: "Three things are broken. Use get, describe, logs and events to find and fix each one.",
    minutes: 10,
    concepts: ["Debugging", "ImagePullBackOff", "CrashLoopBackOff", "Selectors"],
    setup: (c) => {
      deployment(c, "shop", "nginx:latestt", 2);
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "shop", labels: { app: "shop" } }, spec: { selector: { app: "shopp" }, ports: [{ port: 80 }] } });
      c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "worker", labels: { app: "worker" } }, spec: { containers: [{ name: "worker", image: "postgres:16" }] } });
    },
    warmupMs: 25_000,
    startTab: "terminal",
    editor: `apiVersion: v1
kind: Service
metadata:
  name: shop
spec:
  selector:
    app: shopp
  ports:
  - port: 80
`,
    steps: [
      {
        title: "Survey the damage",
        body: "Start broad:\n\n```bash\nkubectl get pods\n```\n\nTwo kinds of trouble: `shop` Pods stuck in `ImagePullBackOff`, and a `worker` Pod in `CrashLoopBackOff`. The canvas shows them in red.",
        check: (x) => ran(x, /kubectl get (pods|po|all)/),
        hint: "kubectl get pods",
        solution: { commands: ["kubectl get pods"] },
      },
      {
        title: "Fix the image",
        body: "Describe the `shop` Pods and read the **Events** at the bottom. The pull errors are recorded on the Pods, not on the Deployment:\n\n```bash\nkubectl describe pods -l app=shop\nkubectl get events\n```\n\nThe tag `latestt` has a typo. Fix it:\n\n```bash\nkubectl set image deployment/shop shop=nginx:1.27\n```",
        check: (x) => readyCount(x.cluster, "shop") === 2,
        hint: "The container is called shop.",
        solution: { commands: ["kubectl set image deployment/shop shop=nginx:1.27"] },
      },
      {
        title: "Find why it crashes",
        body: "`worker` keeps restarting. Its logs from the *previous* run say why:\n\n```bash\nkubectl logs worker --previous\n```\n\nPostgres refuses to start without a password. A Pod's environment variables can't be changed in place (only a few fields, like a container's image, can), so delete the Pod. You'll re-create it in the next Step:\n\n```bash\nkubectl delete pod worker\n```",
        check: (x) => {
          const p = pod(x.cluster, "worker");
          const fixed = !!p?.spec?.containers[0].env?.some((e) => e.name === "POSTGRES_PASSWORD");
          return ran(x, logsOf("(?:pods?/)?worker")) && (!p || fixed);
        },
        hint: "kubectl logs worker --previous, then kubectl delete pod worker. Wait for it to disappear.",
        solution: { commands: ["kubectl logs worker --previous", "kubectl delete pod worker"] },
      },
      {
        title: "Re-create it with a password",
        body: "Re-create `worker` in the YAML editor, with an environment variable under the container:\n\n```yaml\nenv:\n- name: POSTGRES_PASSWORD\n  value: secret\n```\n\n(In a real app the password would come from a Secret; the Configuration track shows how.)",
        check: (x) => {
          const p = pod(x.cluster, "worker");
          return !!p && isPodReady(p);
        },
        hint: "Apply a Pod named worker, image postgres:16, with the env var above.",
        solution: { yaml: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: worker\n  labels:\n    app: worker\nspec:\n  containers:\n  - name: worker\n    image: postgres:16\n    env:\n    - name: POSTGRES_PASSWORD\n      value: secret\n` },
      },
      {
        title: "Fix the Service",
        body: "`curl http://shop` fails even though the Pods are healthy now. Check which Pods the Service found:\n\n```bash\nkubectl describe service shop\nkubectl get endpointslices -l kubernetes.io/service-name=shop\n```\n\nNo endpoints: the selector says `app=shopp`, but the Pods are labelled `app=shop`. Fix the selector in the YAML editor and apply.",
        check: (x) => ((x.cluster.raw("Endpoints", "default", "shop") as unknown as Endpoints | undefined)?.subsets?.[0]?.addresses?.length ?? 0) > 0,
        hint: "Change shopp to shop in the editor's Service manifest.",
        solution: { yaml: `apiVersion: v1\nkind: Service\nmetadata:\n  name: shop\nspec:\n  selector:\n    app: shop\n  ports:\n  - port: 80\n` },
      },
    ],
  },
  {
    slug: "health-checks",
    track: "workloads",
    title: "Health checks: readiness & liveness",
    short: "Health checks",
    summary: "Tell Kubernetes how to check your app. Break a Pod on purpose and watch readiness take it out of the Service, then liveness restart a stuck container.",
    minutes: 10,
    concepts: ["Readiness probe", "Liveness probe", "Startup probe", "kubectl exec"],
    setup: (c) => {
      deployment(c, "web", "nginx:1.27", 3);
      service(c, "web", 80);
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "Add a readiness probe",
        body: "A running container isn't always a working one. **Probes** are small checks the **kubelet** (the agent on each Node that starts and watches its containers) runs against each container on a timer, to ask the app how it's doing.\n\n```illustration probes```\n\nThe `web` Deployment has no probes yet. Give it a **readiness probe**: an HTTP GET on `/` every 5 seconds. Apply this in the YAML editor:\n\n" + yamlBlock(WEB_READINESS) + "\n\nA new Pod counts as Ready only once its probe passes. Watch the rollout replace all three Pods.",
        check: (x) => {
          const ps = podsWith(x.cluster, "app", "web");
          return ps.length === 3 && ps.every((p) => up(p) && !!p.spec?.containers[0].readinessProbe?.httpGet) && rolledOut(x.cluster, "web");
        },
        hint: "Use \"Open in editor\" on the YAML block, then Apply.",
        solution: { yaml: WEB_READINESS },
      },
      {
        title: "Break one Pod",
        body: "`kubectl exec` runs a command inside a container. The pattern is `kubectl exec POD -- COMMAND`: everything after `--` is the command that runs inside, not a kubectl flag. Delete nginx's home page in one Pod (type `kubectl exec web-` and press Tab to complete a name):\n\n```bash\nkubectl exec <pod> -- rm /usr/share/nginx/html/index.html\n```\n\nnginx now answers `/` with `403 Forbidden`. After 3 failed probes in a row (about 15 seconds) that Pod shows `0/1` under READY, but its STATUS is still `Running`:\n\n```bash\nkubectl get pods\n```",
        check: (x) => podsWith(x.cluster, "app", "web").some((p) => p.status?.phase === "Running" && !isPodReady(p) && restarts(p) === 0) && readyCount(x.cluster, "web") === 2,
        hint: "kubectl exec POD -- COMMAND. Everything after -- runs inside the container.",
        solution: { commands: (c) => [`kubectl exec ${(podsWith(c, "app", "web").find(isPodReady) ?? podsWith(c, "app", "web")[0])?.metadata.name} -- rm /usr/share/nginx/html/index.html`] },
      },
      {
        title: "Traffic skips it",
        body: "A Service only sends traffic to **Ready** Pods. The Service's `Endpoints:` line now lists just two IPs. Its EndpointSlice still lists all three Pods, with the broken one marked `Ready: false`:\n\n```bash\nkubectl describe service web\nkubectl describe endpointslices -l kubernetes.io/service-name=web\n```\n\nOn the canvas the broken Pod has lost its line to the Service, and `curl http://web` still works every time. The Pod's events say why: `Readiness probe failed: HTTP probe failed with statuscode: 403`.\n\n```bash\nkubectl get events --field-selector reason=Unhealthy\n```",
        check: (x) => ran(x, /kubectl (get|describe) (endpoints|ep|endpointslices?)\b/) || ran(x, /kubectl describe (svc|services?)\b/),
        hint: "kubectl describe service web",
        solution: { commands: ["kubectl describe service web"] },
      },
      {
        title: "Readiness never restarts",
        body: "Look at RESTARTS: still 0. A failing readiness probe only takes a Pod out of rotation. The kubelet leaves the container alone, so it stays broken until someone fixes it. Put a page back:\n\n```bash\nkubectl exec <pod> -- sh -c 'echo fixed > /usr/share/nginx/html/index.html'\n```\n\nThe next probe passes and the Pod rejoins the Service.",
        check: (x) => readyCount(x.cluster, "web") === 3 && endpointCount(x.cluster, "web") === 3,
        hint: "Use the name of the Pod that shows 0/1. Deleting that Pod works too: its replacement starts from a fresh image.",
        solution: {
          commands: (c) => {
            const p = podsWith(c, "app", "web").find((q) => !isPodReady(q)) ?? podsWith(c, "app", "web")[0];
            return [`kubectl exec ${p?.metadata.name} -- sh -c 'echo fixed > /usr/share/nginx/html/index.html'`];
          },
        },
      },
      {
        title: "Add a liveness probe",
        body: "A **liveness probe** asks a different question: is the process stuck? When it fails 3 times in a row, the kubelet kills the container and starts it again.\n\nThis Pod creates `/tmp/healthy`, then sleeps. Its liveness probe is an `exec` probe: it runs `cat /tmp/healthy` inside the container, and exit code 0 means healthy.\n\n" + yamlBlock(LIVENESS_POD),
        check: (x) => !!pod(x.cluster, "liveness")?.spec?.containers[0].livenessProbe?.exec && up(pod(x.cluster, "liveness")),
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: LIVENESS_POD },
      },
      {
        title: "Break it and watch the restart",
        body: "Delete the file the probe checks, then watch the Pod:\n\n```bash\nkubectl exec liveness -- rm /tmp/healthy\nkubectl get pod liveness -w\n```\n\nAfter 3 failed probes the kubelet stops the container. `sh` ignores the polite stop signal, so the kubelet waits out the 30-second grace period, then kills it. RESTARTS becomes 1, and the Pod is healthy again: the new container starts with a fresh filesystem and creates `/tmp/healthy` again. Press Ctrl+C to stop watching.\n\nFor apps that take a long time to start, add a **startupProbe** too. Liveness and readiness checks wait until it has passed once.",
        check: (x) => restarts(pod(x.cluster, "liveness")) >= 1,
        hint: "It takes about a minute. Speed up time if you're impatient.",
        solution: { commands: ["kubectl exec liveness -- rm /tmp/healthy"] },
      },
    ],
  },
  {
    slug: "jobs-and-cronjobs",
    track: "workloads",
    title: "Jobs & CronJobs",
    short: "Jobs",
    summary: "Run work that finishes: one-off Jobs, parallel batches, retries that give up, and Jobs on a schedule.",
    minutes: 9,
    concepts: ["Job", "CronJob", "completions & parallelism", "backoffLimit"],
    steps: [
      {
        title: "Run a Job",
        body: "A Deployment keeps its Pods running forever. A **Job** runs Pods until they *finish*. Create one that computes 100 digits of pi:\n\n```bash\nkubectl create job pi --image=perl:5.34.0 -- perl -Mbignum=bpi -wle \"print bpi(100)\"\n```\n\nOn the canvas the Job's Pod runs, then turns `Completed`. Nobody restarts it: the work is done.",
        check: (x) => (obj<Job>(x.cluster, "Job", "pi")?.status?.succeeded ?? 0) >= 1,
        hint: "Everything after -- is the container's command.",
        solution: { commands: ['kubectl create job pi --image=perl:5.34.0 -- perl -Mbignum=bpi -wle "print bpi(100)"'] },
      },
      {
        title: "Read the result",
        body: "`kubectl get jobs` shows `1/1` completions. The finished Pod is kept, so you can read its output:\n\n```bash\nkubectl get jobs\nkubectl logs job/pi\n```",
        check: (x) => ran(x, logsOf("jobs?(?:\\.batch)?/pi|pi-\\S+")),
        hint: "kubectl logs job/pi picks the Job's Pod for you.",
        solution: { commands: ["kubectl get jobs", "kubectl logs job/pi"] },
      },
      {
        title: "Many Pods, two at a time",
        body: "`completions` is how many Pods must succeed; `parallelism` is how many may run at once. Apply this Job and watch the canvas: two Pods at a time, until six have completed.\n\n" + yamlBlock(BATCH_JOB) + "\n\nNote `restartPolicy: Never`. A Job's Pods must use `Never` or `OnFailure`, not the usual `Always`.",
        check: (x) => (obj<Job>(x.cluster, "Job", "batch")?.status?.succeeded ?? 0) >= 6,
        hint: "Open the YAML in the editor and Apply, then wait about 20 seconds.",
        solution: { yaml: BATCH_JOB },
      },
      {
        title: "When it keeps failing",
        body: "A Job retries a failed Pod, waiting longer each time (10s, 20s, 40s…). `backoffLimit` is how many retries it gets. This one always fails:\n\n" + yamlBlock(FLAKY_JOB) + "\n\nAfter 3 failed Pods (the first try plus 2 retries) the Job gives up and is marked `Failed`. Look for `BackoffLimitExceeded` in its events. The failed Pods are kept so you can read their logs.\n\n```bash\nkubectl get job flaky\nkubectl describe job flaky\n```",
        check: (x) => {
          const j = obj<Job>(x.cluster, "Job", "flaky");
          return !!j && jobFailed(j);
        },
        hint: "It takes about 40 seconds to use up its retries.",
        solution: { yaml: FLAKY_JOB },
      },
      {
        title: "Run it on a schedule",
        body: "A **CronJob** creates a Job on a schedule, in cron format: minute, hour, day of month, month, day of week. `*/1 * * * *` means every minute.\n\n```bash\nkubectl create cronjob hello --image=busybox --schedule=\"*/1 * * * *\" -- sh -c \"date; echo Hello from the cluster\"\n```\n\nWithin a minute a Job named `hello-` plus a number appears on the canvas, runs and completes. The CronJob keeps the last 3 successful Jobs and deletes older ones.\n\n```bash\nkubectl get cronjobs\nkubectl get jobs\n```",
        check: (x) => x.cluster.list<Job>("Job", "default").some((j) => j.metadata.ownerReferences?.some((o) => o.kind === "CronJob" && o.name === "hello") && jobComplete(j)),
        hint: "Wait for the next full minute. Speed up time to get there faster.",
        solution: { commands: ['kubectl create cronjob hello --image=busybox --schedule="*/1 * * * *" -- sh -c "date; echo Hello from the cluster"'] },
      },
      {
        title: "Pause it",
        body: "Set `suspend: true` to stop new runs without deleting the CronJob:\n\n```bash\nkubectl patch cronjob hello -p '{\"spec\":{\"suspend\":true}}'\nkubectl get cronjob hello\n```\n\nSUSPEND now reads `True`. To run it once by hand anyway, make a Job from its template: `kubectl create job hello-now --from=cronjob/hello`.",
        check: (x) => obj<CronJob>(x.cluster, "CronJob", "hello")?.spec?.suspend === true,
        hint: "kubectl patch takes a JSON fragment with -p.",
        solution: { commands: [`kubectl patch cronjob hello -p '{"spec":{"suspend":true}}'`] },
      },
    ],
  },
  {
    slug: "resources-and-limits",
    track: "config",
    title: "Resources & limits",
    short: "Resources",
    summary: "Reserve CPU and memory for containers, see a Pod that can't be scheduled, watch a container get OOMKilled, and measure real usage.",
    minutes: 10,
    concepts: ["Requests & limits", "QoS class", "Insufficient cpu", "OOMKilled", "kubectl top"],
    steps: [
      {
        title: "Requests and limits",
        body: "Containers on a Node share its CPU and memory. **Requests** are what a container is promised: the scheduler only puts a Pod on a Node with that much unreserved room. **Limits** are the most it may use.\n\nCPU is counted in cores (`250m` is a quarter of a core), memory in bytes (`64Mi` is 64 mebibytes). Apply this Deployment:\n\n" + yamlBlock(API_RESOURCES) + "\n\nIts Pods get the **QoS class** `Burstable`, because requests are below limits. Requests equal to limits make a Pod `Guaranteed`; none at all make it `BestEffort`, the first to be evicted when a Node runs short of memory.\n\n```bash\nkubectl get pods -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass\n```",
        check: (x) => !!firstContainer(dep(x.cluster, "api"))?.resources?.requests?.cpu && readyCount(x.cluster, "api") === 2,
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: API_RESOURCES },
      },
      {
        title: "See what's reserved",
        body: "Each worker has 4 CPUs and about 8 GiB of memory. Describe one and scroll to **Allocated resources**, where the requests of its Pods are added up:\n\n```bash\nkubectl describe node worker-1\n```",
        check: (x) => ran(x, /kubectl describe (nodes?|no)\b/),
        hint: "kubectl describe node worker-1",
        solution: { commands: ["kubectl describe node worker-1"] },
      },
      {
        title: "Ask for more than fits",
        body: "Each of these Pods asks for 3 whole CPUs. Each worker can fit one, so the third Pod has nowhere to go and waits in the **scheduler queue** on the canvas:\n\n" + yamlBlock(BIG_DEPLOYMENT) + "\n\nAsk the scheduler why:\n\n```bash\nkubectl get events --field-selector reason=FailedScheduling\n```\n\n`2 Insufficient cpu`: the scheduler counts requests, not real usage. These Pods are idle, but the CPU is promised to them.",
        check: (x) => podsWith(x.cluster, "app", "big").some(unscheduled),
        hint: "Open the YAML in the editor and Apply. One of the three Pods stays Pending.",
        solution: { yaml: BIG_DEPLOYMENT },
      },
      {
        title: "Make it fit",
        body: "Lower the request so all three fit:\n\n```bash\nkubectl set resources deployment big --requests=cpu=500m\n```\n\nThe Deployment rolls out Pods with the smaller request, and the queue empties.",
        check: (x) => rolledOut(x.cluster, "big") && readyCount(x.cluster, "big") === 3 && !podsWith(x.cluster, "app", "big").some(unscheduled),
        hint: "Scaling down to 2 replicas would also do it, but try the smaller request.",
        solution: { commands: ["kubectl set resources deployment big --requests=cpu=500m"] },
      },
      {
        title: "Go over the memory limit",
        body: "A container over its CPU limit is only slowed down. A container over its **memory** limit is killed. This Pod, from the Kubernetes docs, tries to use 250 MB with a 100 Mi limit:\n\n" + yamlBlock(MEMORY_DEMO) + "\n\nThe kernel kills it: `OOMKilled` (out of memory), exit code 137. It restarts, is killed again, and ends up in `CrashLoopBackOff`. In the describe output, look at **Last State**.\n\n```bash\nkubectl get pod memory-demo\nkubectl describe pod memory-demo\n```",
        check: (x) => lastExit(pod(x.cluster, "memory-demo")) === "OOMKilled",
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: MEMORY_DEMO },
      },
      {
        title: "Measure real usage",
        body: "Requests are a promise. `kubectl top` shows what containers really use, as collected by **metrics-server** every 15 seconds:\n\n```bash\nkubectl top pods\nkubectl top nodes\n```\n\nA good request is a little above typical usage. The autoscaling Lesson uses these same numbers.",
        check: (x) => ran(x, /kubectl top (pods?|po|nodes?|no)\b/),
        hint: "kubectl top pods",
        solution: { commands: ["kubectl top pods", "kubectl top nodes"] },
      },
    ],
  },
  {
    slug: "configmaps-and-secrets",
    track: "config",
    title: "ConfigMaps & Secrets",
    short: "ConfigMaps",
    summary: "Keep settings out of your images: environment variables and files from ConfigMaps, passwords from Secrets, and what happens when one is missing.",
    minutes: 10,
    concepts: ["ConfigMap", "Secret", "envFrom", "Volumes", "CreateContainerConfigError"],
    steps: [
      {
        title: "Create a ConfigMap",
        body: "Don't bake settings into images. A **ConfigMap** stores plain key-value settings in the cluster:\n\n```bash\nkubectl create configmap app-config --from-literal=COLOR=blue --from-literal=MODE=production\nkubectl describe configmap app-config\n```\n\nIt appears on the canvas with the other config objects.",
        check: (x) => !!obj<ConfigMap>(x.cluster, "ConfigMap", "app-config")?.data?.COLOR,
        hint: "Each --from-literal adds one KEY=value.",
        solution: { commands: ["kubectl create configmap app-config --from-literal=COLOR=blue --from-literal=MODE=production"] },
      },
      {
        title: "Use it as environment variables",
        body: "`envFrom` turns every key of the ConfigMap into an environment variable, like `docker run --env-file`:\n\n" + yamlBlock(APP_ENV_POD) + "\n\nThen read what the app printed. Click the Pod on the canvas: its line to `app-config` shows what it uses.\n\n```bash\nkubectl logs app\n```",
        check: (x) => up(pod(x.cluster, "app")) && !!pod(x.cluster, "app")?.spec?.containers[0].envFrom?.some((e) => e.configMapRef?.name === "app-config"),
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: APP_ENV_POD },
      },
      {
        title: "Point at a Secret that doesn't exist",
        body: "Passwords go in a **Secret**. This Pod reads `POSTGRES_PASSWORD` from a Secret called `db-pass`, which doesn't exist yet. Apply it anyway:\n\n" + yamlBlock(DB_SECRET_POD) + "\n\nThe Pod is scheduled, but the kubelet can't build the container's environment. Its status is `CreateContainerConfigError`:\n\n```bash\nkubectl get pod db\n```",
        check: (x) => {
          const p = pod(x.cluster, "db");
          return !!p && (waitingReason(p) === "CreateContainerConfigError" || !!obj(x.cluster, "Secret", "db-pass"));
        },
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: DB_SECRET_POD },
      },
      {
        title: "Create the Secret",
        body: "```bash\nkubectl create secret generic db-pass --from-literal=password=s3cr3t\n```\n\nThe kubelet keeps retrying, so the Pod starts on its own within a few seconds. No need to re-create it.\n\nSecret values are only **base64-encoded**, not encrypted. Anyone allowed to read Secrets can decode them:\n\n```bash\nkubectl get secret db-pass -o jsonpath='{.data.password}' | base64 -d\n```",
        check: (x) => up(pod(x.cluster, "db")),
        hint: "The key must be called password, because that's what the Pod asks for.",
        solution: { commands: ["kubectl create secret generic db-pass --from-literal=password=s3cr3t"] },
      },
      {
        title: "Mount config as files",
        body: "A ConfigMap can also be mounted as a directory: each key becomes a file. This one replaces nginx's web page:\n\n" + yamlBlock(WEB_CONFIGMAP_VOLUME) + "\n\n```bash\nkubectl exec web -- cat /usr/share/nginx/html/index.html\n```",
        check: (x) => up(pod(x.cluster, "web")) && !!pod(x.cluster, "web")?.spec?.volumes?.some((v) => v.configMap?.name === "web-html"),
        hint: "The YAML has two objects separated by ---. Apply both at once.",
        solution: { yaml: WEB_CONFIGMAP_VOLUME },
      },
      {
        title: "Change it while it runs",
        body: "Edit the ConfigMap:\n\n```bash\nkubectl patch configmap web-html -p '{\"data\":{\"index.html\":\"Version 2\"}}'\n```\n\nThe kubelet refreshes mounted files every so often, so within about a minute the file changes, with no restart. Run this now and then until it does:\n\n```bash\nkubectl exec web -- cat /usr/share/nginx/html/index.html\n```\n\nEnvironment variables are different: they're read once, when the container starts. Changing `app-config` now wouldn't change what `app` sees until its container is re-created.",
        check: (x) => {
          const cm = obj<ConfigMap>(x.cluster, "ConfigMap", "web-html");
          const p = pod(x.cluster, "web");
          const shown = p ? x.cluster.state.pods[p.metadata.uid]?.projected?.html?.["index.html"] : undefined;
          return !!cm?.data?.["index.html"] && cm.data["index.html"] !== "Version 1" && shown === cm.data["index.html"];
        },
        hint: "Wait up to a minute after the patch. Speed up time to get there faster.",
        solution: { commands: [`kubectl patch configmap web-html -p '{"data":{"index.html":"Version 2"}}'`] },
      },
    ],
  },
  {
    slug: "ingress",
    track: "networking",
    title: "Ingress",
    short: "Ingress",
    summary: "Put one HTTP entrance in front of several Services and route by hostname and path, with the ingress-nginx controller.",
    minutes: 8,
    concepts: ["Ingress", "Ingress controller", "Host & path routing"],
    setup: (c) => {
      deployment(c, "web", "gcr.io/google-samples/hello-app:1.0", 2, "default", { ports: [{ containerPort: 8080 }] });
      deployment(c, "web2", "gcr.io/google-samples/hello-app:2.0", 1, "default", { ports: [{ containerPort: 8080 }] });
      service(c, "web", 8080);
      service(c, "web2", 8080);
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "Meet the Ingress controller",
        body: "An **Ingress** routes HTTP traffic from outside the cluster to Services, by hostname and URL path. One entrance, many apps.\n\n```illustration ingress```\n\nAn Ingress is only a set of rules. Something has to act on them: an **Ingress controller**. This cluster runs ingress-nginx, the controller most Ingress guides were written for. That project was retired in March 2026 (no more releases), but the Ingress API itself is stable and other controllers implement it; for new setups, the **Gateway API** is where Kubernetes networking is heading. The Ingress rules in this Lesson are standard; the 404 and 503 pages you'll see are ingress-nginx's own. Have a look at the controller:\n\n```bash\nkubectl get pods -n ingress-nginx\nkubectl get ingressclass\n```",
        check: (x) => ran(x, /ingress-nginx|kubectl get (ingressclass(es)?)\b/),
        hint: "kubectl get pods -n ingress-nginx",
        solution: { commands: ["kubectl get pods -n ingress-nginx", "kubectl get ingressclass"] },
      },
      {
        title: "Route a hostname",
        body: "Two Deployments are running: `web` (version 1) and `web2` (version 2), each behind a Service on port 8080. Send everything for `hello-world.example` to `web`:\n\n```bash\nkubectl create ingress hello --class=nginx --rule=\"hello-world.example/*=web:8080\"\n```\n\n`/*` means every path under `/` (pathType `Prefix`). On the canvas the Ingress appears in front of the Service.",
        check: (x) => routeTo(x.cluster, "hello-world.example", "/") === "web",
        hint: "The rule format is HOST/PATH=SERVICE:PORT.",
        solution: { commands: ['kubectl create ingress hello --class=nginx --rule="hello-world.example/*=web:8080"'] },
      },
      {
        title: "Send a request",
        body: "This time use the terminal the way you'd use your laptop, from outside the cluster. ingress-nginx listens on `localhost`, and `hello-world.example` points there too, as if it were in `/etc/hosts`:\n\n```bash\ncurl http://hello-world.example/\ncurl -H 'Host: hello-world.example' http://localhost/\ncurl http://localhost/\n```\n\nThe first two match the rule: ingress-nginx picks the rule by the request's `Host` header. The last one matches no rule, so ingress-nginx answers `404 Not Found` itself.",
        check: (x) => ran(x, /curl .*hello-world\.example/),
        hint: "Run the first curl.",
        solution: { commands: ["curl http://hello-world.example/", "curl http://localhost/"] },
      },
      {
        title: "Route by path",
        body: "Add a second path that goes to `web2`. Apply this in the YAML editor:\n\n" + yamlBlock(HELLO_INGRESS) + "\n\n```bash\ncurl http://hello-world.example/v2\ncurl http://hello-world.example/\n```\n\nWhen several paths match, the longest wins: `/v2` beats `/`.",
        check: (x) => routeTo(x.cluster, "hello-world.example", "/v2") === "web2" && routeTo(x.cluster, "hello-world.example", "/") === "web",
        hint: "Applying an Ingress with the same name replaces its rules.",
        solution: { yaml: HELLO_INGRESS },
      },
      {
        title: "When the backend is down",
        body: "Scale `web2` to zero and try again:\n\n```bash\nkubectl scale deployment web2 --replicas=0\ncurl http://hello-world.example/v2\n```\n\nThe rule still matches, but the Service has no ready Pods, so ingress-nginx returns `503 Service Temporarily Unavailable`. A 404 means no rule matched; a 503 means a rule matched but nothing is behind it.",
        check: (x) => routeTo(x.cluster, "hello-world.example", "/v2") === "web2" && !!obj(x.cluster, "Service", "web2") && endpointCount(x.cluster, "web2") === 0,
        hint: "kubectl scale deployment web2 --replicas=0",
        solution: { commands: ["kubectl scale deployment web2 --replicas=0", "curl http://hello-world.example/v2"] },
      },
    ],
  },
  {
    slug: "network-policies",
    track: "networking",
    title: "Network policies",
    short: "NetworkPolicy",
    summary: "Firewall rules for Pods: deny everything, allow only what's needed, across namespaces, and remember DNS when you limit outgoing traffic.",
    minutes: 12,
    concepts: ["NetworkPolicy", "podSelector", "namespaceSelector", "Egress", "DNS"],
    setup: (c) => {
      deployment(c, "backend", "nginx:1.27", 2);
      service(c, "backend", 80);
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "Everything is open",
        body: "By default any Pod can reach any other Pod, in any namespace. Test it from a throwaway Pod labelled `app=frontend`. `--rm -it` runs one command in a new Pod, then deletes it:\n\n```bash\nkubectl run test --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://backend\n```\n\nThe nginx welcome page comes back.\n\n```illustration network-policy```",
        check: (x) => ran(x, /kubectl run .*wget.*backend/),
        hint: "Run the command as it is.",
        solution: { commands: ["kubectl run test --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://backend"] },
      },
      {
        title: "Deny all incoming traffic",
        body: "A **NetworkPolicy** picks Pods with `podSelector` and lists what may reach them. `{}` selects every Pod in the namespace, and with no rules, nothing may come in:\n\n" + yamlBlock(DEFAULT_DENY) + "\n\nThe backend Pods now show as isolated on the canvas. Run the same test again. It times out: blocked traffic is dropped silently, not refused.\n\n```bash\nkubectl run test --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://backend\n```",
        check: (x) => !reaches(x.cluster, fakePod({ app: "frontend" }), "backend", 80),
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: DEFAULT_DENY },
      },
      {
        title: "Allow the frontend",
        body: "Policies only ever **allow**, and the rules of every policy that selects a Pod add up. `default-deny` stays; this one opens a door for Pods labelled `app=frontend`, on port 80:\n\n" + yamlBlock(ALLOW_FRONTEND) + "\n\nCompare a frontend Pod with any other Pod:\n\n```bash\nkubectl run test --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://backend\nkubectl run test --rm -it --image=busybox --labels=app=other -- wget -qO- --timeout=2 http://backend\n```",
        check: (x) => reaches(x.cluster, fakePod({ app: "frontend" }), "backend", 80) && !reaches(x.cluster, fakePod({ app: "other" }), "backend", 80),
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: ALLOW_FRONTEND },
      },
      {
        title: "Allow another namespace",
        body: "A `podSelector` under `from` only matches Pods in the policy's own namespace. To let in Pods from elsewhere, use a `namespaceSelector`. Every namespace carries a `kubernetes.io/metadata.name` label with its own name:\n\n" + yamlBlock(ALLOW_MONITORING) + "\n\nA Pod in `monitoring` gets through, whatever its labels:\n\n```bash\nkubectl run test -n monitoring --rm -it --image=busybox -- wget -qO- --timeout=2 http://backend.default\n```",
        check: (x) => reaches(x.cluster, fakePod({ run: "test" }, "monitoring"), "backend", 80) && !reaches(x.cluster, fakePod({ app: "other" }), "backend", 80),
        hint: "The YAML creates the namespace too.",
        solution: { yaml: ALLOW_MONITORING },
      },
      {
        title: "Limit outgoing traffic",
        body: "An `Egress` policy limits what the selected Pods may *send*. This one lets frontend Pods talk only to the backend, on port 80:\n\n" + yamlBlock(FRONTEND_EGRESS) + "\n\n```bash\nkubectl run test --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://backend\n```\n\n`wget: bad address 'backend'`. Looking up a name is traffic too: a DNS query to CoreDNS on port 53, and nothing allows it.",
        check: (x) => isIsolated(x.cluster, fakePod({ app: "frontend" }), "Egress") && !dnsAllowed(x.cluster, fakePod({ app: "frontend" })),
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: FRONTEND_EGRESS },
      },
      {
        title: "Allow DNS",
        body: "Add a second egress rule for DNS: port 53 to the CoreDNS Pods in `kube-system`. When `namespaceSelector` and `podSelector` are in the same entry, both must match.\n\n" + yamlBlock(FRONTEND_EGRESS_DNS) + "\n\nRun the test again and the page is back. Almost every egress policy needs a DNS rule like this.\n\n```bash\nkubectl run test --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://backend\n```",
        check: (x) => {
          const fe = fakePod({ app: "frontend" });
          return isIsolated(x.cluster, fe, "Egress") && dnsAllowed(x.cluster, fe) && reaches(x.cluster, fe, "backend", 80);
        },
        hint: "Applying a policy with the same name replaces it.",
        solution: { yaml: FRONTEND_EGRESS_DNS },
      },
    ],
  },
  {
    slug: "persistent-storage",
    track: "storage",
    title: "Persistent storage",
    short: "Volumes",
    summary: "Claim a volume, see why it waits for a Pod, and keep data when the Pod that wrote it is gone.",
    minutes: 9,
    concepts: ["PersistentVolumeClaim", "PersistentVolume", "StorageClass", "WaitForFirstConsumer"],
    steps: [
      {
        title: "Storage classes",
        body: "A container's filesystem is thrown away when the container is replaced. For data that must last, Kubernetes has **PersistentVolumes** (PV), pieces of storage, and **PersistentVolumeClaims** (PVC), a Pod's request for one.\n\n```illustration pv-pvc```\n\nYou rarely create PVs by hand: a **StorageClass** makes them on demand. This cluster has one, `standard`, marked as the default:\n\n```bash\nkubectl get storageclass\n```",
        check: (x) => ran(x, /kubectl get (storageclass(es)?|sc)\b/),
        hint: "kubectl get sc is the short form.",
        solution: { commands: ["kubectl get storageclass"] },
      },
      {
        title: "Claim some storage",
        body: "Ask for 1 GiB that one Node at a time may mount read-write (`ReadWriteOnce`):\n\n" + yamlBlock(DATA_PVC) + "\n\n```bash\nkubectl get pvc\nkubectl describe pvc data\n```\n\nIt stays `Pending`, and that's expected. `standard` uses `WaitForFirstConsumer`: no volume is made until a Pod needs one, so that it's made on the Node where that Pod runs.",
        check: (x) => !!obj(x.cluster, "PersistentVolumeClaim", "data"),
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: DATA_PVC },
      },
      {
        title: "Use it from a Pod",
        body: "Mount the claim at `/data`. The container adds the time to `/data/log.txt` when it starts:\n\n" + yamlBlock(WRITER_POD) + "\n\nOnce the Pod is scheduled, the provisioner creates a PV on that Node and binds it to the claim. Both are `Bound`:\n\n```bash\nkubectl get pvc,pv\n```",
        check: (x) => obj<PersistentVolumeClaim>(x.cluster, "PersistentVolumeClaim", "data")?.status?.phase === "Bound" && up(pod(x.cluster, "writer")),
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: WRITER_POD },
      },
      {
        title: "Write a note",
        body: "Write a file into the volume:\n\n```bash\nkubectl exec writer -- sh -c 'echo hello from the first Pod > /data/note.txt'\nkubectl exec writer -- ls /data\n```",
        check: (x) => claimFiles(x.cluster, "data")["note.txt"] !== undefined,
        hint: "The path must be under /data, where the volume is mounted.",
        solution: { commands: ["kubectl exec writer -- sh -c 'echo hello from the first Pod > /data/note.txt'"] },
      },
      {
        title: "Replace the Pod",
        body: "Delete the Pod, then start a new one that mounts the same claim and prints its files:\n\n```bash\nkubectl delete pod writer\n```\n\n" + yamlBlock(READER_POD) + "\n\n```bash\nkubectl logs reader\n```\n\nThe note is still there, and so is the first Pod's line in `log.txt`. The data lives in the volume, not in the Pod. The new Pod lands on the same Node as before, because a local-path volume exists on one Node only.",
        check: (x) => !pod(x.cluster, "writer") && up(pod(x.cluster, "reader")),
        hint: "The old Pod takes up to 30 seconds to stop.",
        solution: { commands: ["kubectl delete pod writer"], yaml: READER_POD },
      },
      {
        title: "Delete the claim",
        body: "```bash\nkubectl delete pod reader\nkubectl delete pvc data\nkubectl get pvc,pv\n```\n\nWhile a Pod still uses a claim, the claim stays `Terminating` instead of disappearing (pvc-protection). Once the Pod is gone, the claim goes, and its PV with it, because the StorageClass's reclaim policy is `Delete`. With `Retain`, the PV and its data would be kept.",
        check: (x) => !obj(x.cluster, "PersistentVolumeClaim", "data") && !x.cluster.list<PersistentVolume>("PersistentVolume").some((v) => v.spec?.claimRef?.namespace === "default" && v.spec.claimRef.name === "data"),
        hint: "Delete the Pod first, or the claim waits for it.",
        solution: { commands: ["kubectl delete pod reader", "kubectl delete pvc data"] },
      },
    ],
  },
  {
    slug: "statefulsets",
    track: "storage",
    title: "StatefulSets",
    short: "StatefulSets",
    summary: "Run Pods that keep their identity: ordered start, stable names and DNS, and a volume each that follows them.",
    minutes: 10,
    concepts: ["StatefulSet", "Headless Service", "volumeClaimTemplates", "Stable DNS"],
    steps: [
      {
        title: "Create a StatefulSet",
        body: "Deployment Pods are interchangeable: random names, any order, and if they mount a claim, they all share the same one. Databases and other clustered apps need each member to keep its identity. That's what a **StatefulSet** is for.\n\nApply this example from the Kubernetes docs: a **headless** Service (`clusterIP: None`) and a StatefulSet with a volume claim template.\n\n" + yamlBlock(WEB_STATEFULSET) + "\n\nWatch the canvas: `web-0` starts first. `web-1` is only created once `web-0` is Running and Ready, then `web-2`.",
        check: (x) => !!obj(x.cluster, "StatefulSet", "web") && [0, 1, 2].every((i) => up(pod(x.cluster, `web-${i}`))),
        hint: "Open the YAML in the editor and Apply. The three Pods take about half a minute.",
        solution: { yaml: WEB_STATEFULSET },
      },
      {
        title: "Stable names, own storage",
        body: "```bash\nkubectl get pods -l app=nginx\nkubectl get pvc\n```\n\nThe Pods are called `web-0`, `web-1` and `web-2`: the StatefulSet's name plus an **ordinal**. Each got its own claim from the template (`www-web-0` and so on), and no other Pod uses it.",
        check: (x) => ran(x, /kubectl get (pvc|persistentvolumeclaims?)\b/),
        hint: "kubectl get pvc",
        solution: { commands: ["kubectl get pods -l app=nginx", "kubectl get pvc"] },
      },
      {
        title: "Give each Pod a page",
        body: "The volumes start empty, so nginx has no page yet. Write each Pod's hostname into its own volume:\n\n```bash\nkubectl exec web-0 -- sh -c 'echo \"$(hostname)\" > /usr/share/nginx/html/index.html'\nkubectl exec web-1 -- sh -c 'echo \"$(hostname)\" > /usr/share/nginx/html/index.html'\nkubectl exec web-2 -- sh -c 'echo \"$(hostname)\" > /usr/share/nginx/html/index.html'\n```",
        check: (x) => [0, 1, 2].every((i) => (claimFiles(x.cluster, `www-web-${i}`)["index.html"] ?? "").includes(`web-${i}`)),
        hint: "Run all three lines.",
        solution: { commands: [0, 1, 2].map((i) => `kubectl exec web-${i} -- sh -c 'echo "$(hostname)" > /usr/share/nginx/html/index.html'`) },
      },
      {
        title: "Call a Pod by name",
        body: "The headless Service gives every Pod its own DNS name: the Pod's name, then the Service's. Ask for `web-1` directly:\n\n```bash\nkubectl run tmp --rm -it --image=busybox -- wget -qO- http://web-1.nginx\nkubectl run tmp --rm -it --image=busybox:1.28 -- nslookup web-0.nginx\n```\n\nA normal Service picks a Pod for you. Here the client chooses: a database client can always find the primary at `web-0.nginx`.",
        check: (x) => ran(x, /(wget|curl|nslookup).*web-\d\.nginx/),
        hint: "Run the wget line.",
        solution: { commands: ["kubectl run tmp --rm -it --image=busybox -- wget -qO- http://web-1.nginx"] },
      },
      {
        title: "Delete a Pod",
        body: "```bash\nkubectl delete pod web-0\nkubectl get pods -l app=nginx -o wide\n```\n\nThe replacement has the same name and mounts the same claim, but gets a new IP. The DNS name follows it, so `http://web-0.nginx` still answers `web-0`, from the page you wrote to its volume.",
        check: (x) => ran(x, /kubectl delete (pods?|po)[ /]web-0\b/) && up(pod(x.cluster, "web-0")),
        hint: "kubectl delete pod web-0",
        solution: { commands: ["kubectl delete pod web-0"] },
      },
      {
        title: "Scale down",
        body: "```bash\nkubectl scale statefulset web --replicas=1\nkubectl get pvc\n```\n\nPods go in reverse order: `web-2` first, then `web-1`. Their claims stay, so scaling back up gives each Pod its old data.",
        check: (x) => obj<StatefulSet>(x.cluster, "StatefulSet", "web")?.spec?.replicas === 1 && podsWith(x.cluster, "app", "nginx").length === 1 && !!pod(x.cluster, "web-0") && !!obj(x.cluster, "PersistentVolumeClaim", "www-web-2"),
        hint: "kubectl scale works on StatefulSets too (sts for short).",
        solution: { commands: ["kubectl scale statefulset web --replicas=1"] },
      },
    ],
  },
  {
    slug: "scheduling",
    track: "operations",
    title: "Scheduling: selectors, taints & drains",
    short: "Scheduling",
    summary: "Steer Pods onto the right Nodes with labels, keep them off with taints, and empty a Node safely before maintenance.",
    minutes: 10,
    concepts: ["nodeSelector", "Taints & tolerations", "Cordon & drain", "DaemonSet"],
    steps: [
      {
        title: "Pick Nodes by label",
        body: "Nodes have labels too. Label worker-2, then create a Pod that may only run on Nodes with that label:\n\n```bash\nkubectl label node worker-2 disktype=ssd\n```\n\n" + yamlBlock(SSD_POD) + "\n\n`nodeSelector` is a hard rule: if no Node matches, the Pod stays Pending.",
        check: (x) => {
          const p = pod(x.cluster, "fast");
          const n = p?.spec?.nodeName ? obj<Node>(x.cluster, "Node", p.spec.nodeName, undefined) : undefined;
          return up(p) && n?.metadata.labels?.disktype === "ssd";
        },
        hint: "Label the Node first, then apply the Pod.",
        solution: { commands: ["kubectl label node worker-2 disktype=ssd"], yaml: SSD_POD },
      },
      {
        title: "Taint a Node",
        body: "A **taint** works the other way round: it keeps Pods *off* a Node. The control-plane already has one, which is why your Pods never land there. Taint worker-1, then start 4 Pods:\n\n```bash\nkubectl taint nodes worker-1 dedicated=db:NoSchedule\nkubectl create deployment web --image=nginx --replicas=4\n```\n\nAll four go to worker-2. The canvas marks worker-1 as tainted.",
        check: (x) => {
          const n = obj<Node>(x.cluster, "Node", "worker-1", undefined);
          return !!n?.spec?.taints?.some((t) => t.key === "dedicated" && t.effect === "NoSchedule") && readyCount(x.cluster, "web") === 4 && podsWith(x.cluster, "app", "web").every((p) => p.spec?.nodeName !== "worker-1");
        },
        hint: "Taint first, so the Pods are scheduled after it.",
        solution: { commands: ["kubectl taint nodes worker-1 dedicated=db:NoSchedule", "kubectl create deployment web --image=nginx --replicas=4"] },
      },
      {
        title: "Tolerate the taint",
        body: "A **toleration** lets a Pod onto a tainted Node. It doesn't send it there, so pair it with a `nodeSelector`. Every Node has a `kubernetes.io/hostname` label:\n\n" + yamlBlock(TOLERATING_POD) + "\n\n`db` runs on worker-1, the only one of your Pods there.",
        check: (x) => up(pod(x.cluster, "db")) && pod(x.cluster, "db")?.spec?.nodeName === "worker-1",
        hint: "Open the YAML in the editor and Apply.",
        solution: { yaml: TOLERATING_POD },
      },
      {
        title: "Drain a Node",
        body: "Before maintenance you **drain** a Node: mark it unschedulable (cordon), then evict its Pods: ask the API to remove each one politely, giving it time to shut down so its controller can start a replacement elsewhere.\n\n```bash\nkubectl drain worker-2\n```\n\nIt refuses, and says why. `kube-proxy` belongs to a **DaemonSet**, which runs one Pod on every Node (`kubectl get daemonsets -n kube-system`), so evicting it is pointless. And `fast` has no controller, so nothing would re-create it. Accept both:\n\n```bash\nkubectl drain worker-2 --ignore-daemonsets --force\n```\n\nThe `web` Pods are evicted. worker-1 is tainted and worker-2 is cordoned (hatched on the canvas), so their replacements wait in the scheduler queue. `fast` is gone for good.",
        check: (x) => {
          const n = obj<Node>(x.cluster, "Node", "worker-2", undefined);
          const left = x.cluster.list<Pod>("Pod").filter((p) => p.spec?.nodeName === "worker-2" && !p.metadata.deletionTimestamp && !p.metadata.ownerReferences?.some((o) => o.kind === "DaemonSet"));
          return !!n?.spec?.unschedulable && left.length === 0;
        },
        hint: "Both flags are needed: --ignore-daemonsets and --force.",
        solution: { commands: ["kubectl drain worker-2 --ignore-daemonsets --force"] },
      },
      {
        title: "Bring it back",
        body: "Maintenance is done:\n\n```bash\nkubectl uncordon worker-2\n```\n\nThe waiting Pods are scheduled straight away. Uncordoning doesn't move running Pods back: the scheduler only places new ones.",
        check: (x) => !obj<Node>(x.cluster, "Node", "worker-2", undefined)?.spec?.unschedulable && readyCount(x.cluster, "web") === 4,
        hint: "kubectl uncordon worker-2",
        solution: { commands: ["kubectl uncordon worker-2"] },
      },
    ],
  },
  {
    slug: "autoscaling",
    track: "operations",
    title: "Autoscaling with the HPA",
    short: "Autoscaling",
    summary: "The official HorizontalPodAutoscaler walkthrough: put CPU load on php-apache, watch it scale out, then scale back in.",
    minutes: 10,
    concepts: ["HorizontalPodAutoscaler", "metrics-server", "Stabilization window"],
    setup: (c) => {
      for (const d of YAML.parseAllDocuments(PHP_APACHE)) c.create(d.toJS());
    },
    warmupMs: 30_000,
    steps: [
      {
        title: "The app and its CPU request",
        body: "`php-apache` serves a PHP page that burns CPU on every request. Its container requests `200m` of CPU. A **HorizontalPodAutoscaler** (HPA) adds or removes Pods to keep average CPU near a target, measured as a percentage of that request.\n\n```illustration hpa```\n\nSee what it uses now:\n\n```bash\nkubectl top pods\n```",
        check: (x) => ran(x, /kubectl top (pods?|po|nodes?|no)\b/),
        hint: "kubectl top pods",
        solution: { commands: ["kubectl top pods"] },
      },
      {
        title: "Create the autoscaler",
        body: "Keep average CPU at 50% of the request, with between 1 and 10 Pods:\n\n```bash\nkubectl autoscale deployment php-apache --cpu=50% --min=1 --max=10\nkubectl get hpa\n```\n\nThe HPA checks every 15 seconds. TARGETS reads `cpu: <unknown>/50%` until it has a first reading, then `cpu: 0%/50%`.",
        check: (x) =>
          x.cluster.list<HorizontalPodAutoscaler>("HorizontalPodAutoscaler", "default").some(
            (h) =>
              h.spec?.scaleTargetRef.kind === "Deployment" &&
              h.spec.scaleTargetRef.name === "php-apache" &&
              (h.spec.minReplicas ?? 1) === 1 &&
              h.spec.maxReplicas === 10 &&
              !!h.spec.metrics?.some((m) => m.type === "Resource" && m.resource?.name === "cpu" && m.resource.target.type === "Utilization" && m.resource.target.averageUtilization === 50),
          ),
        hint: "kubectl autoscale deployment NAME --cpu=N% --min=N --max=N (older guides use --cpu-percent=N, now deprecated)",
        solution: { commands: ["kubectl autoscale deployment php-apache --cpu=50% --min=1 --max=10"] },
      },
      {
        title: "Generate load",
        body: "Start a Pod that calls the Service in a tight loop, as in the Kubernetes docs (which also add `-i --tty --rm` so you can stop it with Ctrl+C; here you'll delete it instead):\n\n```bash\n" + LOAD_GENERATOR + "\nkubectl get hpa php-apache --watch\n```\n\nWithin a minute CPU goes far above 50% and the HPA raises the Deployment's replicas. New Pods appear on the canvas and share the load, so the percentage comes down. Press Ctrl+C to stop watching.",
        check: (x) => (dep(x.cluster, "php-apache")?.spec?.replicas ?? 1) >= 4,
        hint: "Copy the whole line, quotes included.",
        solution: { commands: [LOAD_GENERATOR] },
      },
      {
        title: "Stop the load",
        body: "```bash\nkubectl delete pod load-generator\nkubectl get hpa php-apache --watch\n```\n\nCPU falls to 0% within a minute, but the Pods stay. The HPA only scales down after its recommendations have been low for a whole **stabilization window**, 5 minutes by default, so a short lull doesn't remove Pods you'll need a minute later.",
        check: (x) => {
          const h = obj<HorizontalPodAutoscaler>(x.cluster, "HorizontalPodAutoscaler", "php-apache");
          const util = h?.status?.currentMetrics?.[0]?.resource?.current.averageUtilization;
          return !pod(x.cluster, "load-generator") && util !== undefined && util < 50;
        },
        hint: "The load generator takes up to 30 seconds to stop.",
        solution: { commands: ["kubectl delete pod load-generator"] },
      },
      {
        title: "Shorten the window",
        body: "Five minutes is sensible in production. Here, cut the window to 30 seconds with the HPA's `behavior` field:\n\n```bash\nkubectl patch hpa php-apache -p '{\"spec\":{\"behavior\":{\"scaleDown\":{\"stabilizationWindowSeconds\":30}}}}'\n```\n\nAbout half a minute later the Deployment is back to 1 Pod. `minReplicas` stops it from going lower.",
        check: (x) => obj<HorizontalPodAutoscaler>(x.cluster, "HorizontalPodAutoscaler", "php-apache")?.spec?.behavior?.scaleDown?.stabilizationWindowSeconds === 30 && dep(x.cluster, "php-apache")?.spec?.replicas === 1,
        hint: "kubectl patch hpa takes a JSON fragment with -p.",
        solution: { commands: [`kubectl patch hpa php-apache -p '{"spec":{"behavior":{"scaleDown":{"stabilizationWindowSeconds":30}}}}'`] },
      },
    ],
  },
  {
    slug: "rbac",
    track: "security",
    title: "RBAC & ServiceAccounts",
    short: "RBAC",
    summary: "Give a CI pipeline its own identity, see it get Forbidden, then grant exactly what it needs with a Role and a RoleBinding.",
    minutes: 9,
    concepts: ["ServiceAccount", "Role", "RoleBinding", "kubectl auth can-i", "Impersonation"],
    setup: (c) => {
      c.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: "dev" } });
      deployment(c, "api", "nginx:1.27", 2, "dev");
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "Who are you?",
        body: "Every request to the API server comes from someone: a user, or a **ServiceAccount**, an identity for software such as a CI pipeline or a controller. **RBAC** (role-based access control) decides what each may do.\n\n```illustration rbac```\n\nIn this terminal you are the cluster admin, allowed to do anything:\n\n```bash\nkubectl auth whoami\nkubectl auth can-i delete nodes\n```",
        check: (x) => ran(x, /kubectl auth (whoami|can-i)/),
        hint: "kubectl auth whoami",
        solution: { commands: ["kubectl auth whoami", "kubectl auth can-i delete nodes"] },
      },
      {
        title: "Create a ServiceAccount",
        body: "A pipeline that deploys to `dev` should get its own identity, not your admin credentials:\n\n```bash\nkubectl create serviceaccount ci -n dev\n```\n\nIts username is `system:serviceaccount:dev:ci`.",
        check: (x) => !!obj(x.cluster, "ServiceAccount", "ci", "dev"),
        hint: "Don't forget -n dev.",
        solution: { commands: ["kubectl create serviceaccount ci -n dev"] },
      },
      {
        title: "Nothing is allowed yet",
        body: "`--as` makes kubectl act as someone else (impersonation), so you can test permissions without their credentials:\n\n```bash\nkubectl get deployments -n dev --as=" + CI + "\nkubectl auth can-i list deployments -n dev --as=" + CI + "\n```\n\n`Forbidden`, and `no`. A new ServiceAccount can do almost nothing: RBAC denies whatever no rule allows.",
        check: (x) => ran(x, /--as[= ]system:serviceaccount:dev:ci\b/),
        hint: "Run either line.",
        solution: { commands: [`kubectl get deployments -n dev --as=${CI}`] },
      },
      {
        title: "Write a Role",
        body: "A **Role** lists what's allowed in one namespace: verbs (`get`, `list`, `patch`…) on resources (`deployments`, `pods`…). Let the pipeline read and update Deployments, but not delete them:\n\n```bash\nkubectl create role deployer --verb=get,list,watch,patch --resource=deployments -n dev\nkubectl describe role deployer -n dev\n```\n\nA Role on its own changes nothing: nobody has it yet.",
        check: (x) => {
          const rules = (obj<Role>(x.cluster, "Role", "deployer", "dev")?.rules ?? []).filter((r) => r.resources?.some((res) => res === "deployments" || res === "*"));
          return rules.some((r) => r.verbs.includes("patch")) && !rules.some((r) => r.verbs.includes("delete") || r.verbs.includes("*"));
        },
        hint: "--verb and --resource take comma-separated lists.",
        solution: { commands: ["kubectl create role deployer --verb=get,list,watch,patch --resource=deployments -n dev"] },
      },
      {
        title: "Bind it",
        body: "A **RoleBinding** gives a Role to subjects (users, groups or ServiceAccounts) in the binding's namespace:\n\n```bash\nkubectl create rolebinding ci-deployer --role=deployer --serviceaccount=dev:ci -n dev\nkubectl auth can-i patch deployments -n dev --as=" + CI + "\nkubectl auth can-i delete deployments -n dev --as=" + CI + "\nkubectl auth can-i patch deployments -n default --as=" + CI + "\n```\n\n`yes`, `no`, `no`: exactly what the Role says, and only in `dev`.",
        check: (x) => can(x.cluster, CI, "patch", "deployments", "dev", "apps") && !can(x.cluster, CI, "delete", "deployments", "dev", "apps"),
        hint: "--serviceaccount takes NAMESPACE:NAME.",
        solution: { commands: ["kubectl create rolebinding ci-deployer --role=deployer --serviceaccount=dev:ci -n dev"] },
      },
      {
        title: "Act as the pipeline",
        body: "Restart the `api` Deployment the way the pipeline would, then try to delete it:\n\n```bash\nkubectl rollout restart deployment api -n dev --as=" + CI + "\nkubectl delete deployment api -n dev --as=" + CI + "\n```\n\nThe restart works (it's a patch); the delete is Forbidden. A Pod with `serviceAccountName: ci` gets this identity's token mounted at `/var/run/secrets/kubernetes.io/serviceaccount/token`, and any client using it gets exactly these permissions.",
        check: (x) => !!dep(x.cluster, "api", "dev")?.spec?.template.metadata?.annotations?.["kubectl.kubernetes.io/restartedAt"] && ran(x, /kubectl rollout restart .*--as[= ]system:serviceaccount:dev:ci\b/),
        hint: "kubectl rollout restart deployment api -n dev --as=…",
        solution: { commands: [`kubectl rollout restart deployment api -n dev --as=${CI}`] },
      },
    ],
  },
];

export { TRACKS, trackOf, type TrackId };

export function solutionCommands(step: Pick<Step, "solution">, c: Cluster): string[] {
  const s = step.solution.commands;
  return typeof s === "function" ? s(c) : (s ?? []);
}

export const lessonBySlug = (slug: string) => LESSONS.find((l) => l.slug === slug);

/** Check and setup helpers, shared with Challenges and practice exams. */
export { ran, pod, podsWith, readyCount, dep, rolledOut, waitingReason, deployment, service, obj, up, restarts, endpointCount, lastExit, unscheduled, firstContainer, claimFiles, fakePod, reaches, can, routeTo, yamlBlock };

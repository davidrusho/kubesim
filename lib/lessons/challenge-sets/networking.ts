// More Challenges (see ../challenges.ts for the format and the rules).
// Networking (Ingress, NetworkPolicy), scheduling (nodeSelector, anti-affinity,
// taints on DaemonSets) and operations (the HPA).

import YAML from "yaml";
import type { Cluster, DaemonSet, Deployment, HorizontalPodAutoscaler, NetworkPolicy, Node, Pod, Service } from "@/lib/engine";
import { connectionAllowed, isPodReady, routeIngress } from "@/lib/engine";
import { resolveTargetPort } from "@/lib/engine/controllers/endpoints";
import { listenPorts, lookupImage } from "@/lib/engine/images";
import type { Challenge } from "../challenges";
import { dep, deployment, endpointCount, fakePod, obj, podsWith, reaches, readyCount, rolledOut, service, up } from "../lessons";

// ---------------------------------------------------------------- helpers

const node = (c: Cluster, name: string) => obj<Node>(c, "Node", name, undefined);
const hasTaint = (c: Cluster, name: string, key: string, value: string, effect: string) => !!node(c, name)?.spec?.taints?.some((t) => t.key === key && (t.value ?? "") === value && t.effect === effect);
/** Ready Pods of an app, not being deleted. */
const readyPods = (c: Cluster, app: string, ns = "default") => podsWith(c, "app", app, ns).filter(up);

/** Does some ready endpoint of this Service port actually have a container listening on its target port? */
function serves(c: Cluster, svc: Service, svcPort: number): boolean {
  const sp = svc.spec?.ports?.find((p) => p.port === svcPort);
  if (!sp || endpointCount(c, svc.metadata.name, svc.metadata.namespace) === 0) return false;
  const sel = svc.spec?.selector ?? {};
  return c
    .list<Pod>("Pod", svc.metadata.namespace)
    .filter((p) => up(p) && Object.entries(sel).every(([k, v]) => p.metadata.labels?.[k] === v))
    .some((p) => {
      const port = resolveTargetPort(p, sp);
      return port !== undefined && (p.spec?.containers ?? []).some((ct) => listenPorts(lookupImage(ct.image).info, ct).includes(port));
    });
}

/** ingress-nginx routes host+path to this Service, on one of its ports, and something answers behind it. */
function ingressServes(c: Cluster, host: string, path: string, svcName: string): boolean {
  const r = routeIngress(c, host, path);
  const b = r?.backend.service;
  if (!r || !b || b.name !== svcName) return false;
  const svc = obj<Service>(c, "Service", svcName, r.ingress.metadata.namespace);
  const sp = svc?.spec?.ports?.find((p) => (b.port.number !== undefined ? p.port === b.port.number : p.name === b.port.name));
  return !!svc && !!sp && serves(c, svc, sp.port);
}

/** A default-deny ingress policy, still selecting every Pod and allowing nothing. */
function denyAllIntact(c: Cluster, name: string, ns = "default"): boolean {
  const np = obj<NetworkPolicy>(c, "NetworkPolicy", name, ns);
  const sel = np?.spec?.podSelector;
  const selectsAll = !Object.keys(sel?.matchLabels ?? {}).length && !sel?.matchExpressions?.length;
  return !!np && selectsAll && JSON.stringify(np.spec?.policyTypes) === '["Ingress"]' && !np.spec?.ingress?.length && !np.spec?.egress?.length;
}

const ingressController = (c: Cluster) => c.list<Pod>("Pod", "ingress-nginx").find((p) => p.metadata.labels?.["app.kubernetes.io/component"] === "controller" && up(p));

// ---------------------------------------------------------------- manifests

const SHOP_INGRESS = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  ingressClassName: traefik
  rules:
  - host: shop.example
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: shop
            port:
              number: 80
`;

const ALLOW_FRONTEND = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-allow-frontend
spec:
  podSelector:
    matchLabels:
      app: api
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

const STOREFRONT = `apiVersion: v1
kind: Namespace
metadata:
  name: shop
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: shop
  labels:
    app: storefront
spec:
  replicas: 2
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      containers:
      - name: storefront
        image: gcr.io/google-samples/hello-app:1.0
        ports:
        - name: web
          containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: storefront
  namespace: shop
  labels:
    app: storefront
spec:
  selector:
    app: storefront
  ports:
  - name: http
    port: 80
    targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: storefront
  namespace: shop
spec:
  ingressClassName: nginx
  rules:
  - host: shop.example
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: storefront
            port:
              name: http
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: shop
spec:
  podSelector: {}
  policyTypes:
  - Ingress
`;

const ALLOW_INGRESS_NGINX = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-nginx
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: storefront
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
    ports:
    - port: 8080
`;

const PHP_APACHE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: php-apache
  labels:
    app: php-apache
spec:
  replicas: 1
  selector:
    matchLabels:
      app: php-apache
  template:
    metadata:
      labels:
        app: php-apache
    spec:
      containers:
      - name: php-apache
        image: registry.k8s.io/hpa-example
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: 200m
          limits:
            cpu: 500m
      - name: log-shipper
        image: busybox
        command: ["sh", "-c", "sleep 3600"]
---
apiVersion: v1
kind: Service
metadata:
  name: php-apache
  labels:
    app: php-apache
spec:
  selector:
    app: php-apache
  ports:
  - port: 80
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: php-apache
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: php-apache
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
---
apiVersion: v1
kind: Pod
metadata:
  name: load-generator
  labels:
    run: load-generator
spec:
  containers:
  - name: load-generator
    image: busybox:1.28
    command: ["/bin/sh", "-c", "while sleep 0.01; do wget -q -O- http://php-apache; done"]
`;

const createAll = (c: Cluster, yaml: string) => {
  for (const d of YAML.parseAllDocuments(yaml)) c.create(d.toJS());
};

// ---------------------------------------------------------------- challenges

export const NETWORKING_CHALLENGES: Challenge[] = [
  {
    slug: "nodeselector-typo",
    start: ["kubectl get pods -o wide", "kubectl get nodes --show-labels"],
    difficulty: "easy",
    track: "operations",
    title: "Waiting for the fast disk",
    summary: "Two Pods that have been Pending since this morning's deploy.",
    brief: "`search` has to run on the Node with the SSD. Both `search` Pods have been Pending since it was deployed this morning. Other teams rely on the Nodes exactly as they are: leave them alone.",
    minutes: 4,
    concepts: ["nodeSelector", "Node labels", "FailedScheduling"],
    setup: (c) => {
      const w2 = c.get<Node>("Node", undefined, "worker-2");
      c.replace({ ...w2, metadata: { ...w2.metadata, labels: { ...(w2.metadata.labels ?? {}), disktype: "ssd" } } });
      deployment(c, "search", "nginx:1.27", 2, "default");
      const d = c.get<Deployment>("Deployment", "default", "search");
      c.replace({ ...d, spec: { ...d.spec!, template: { ...d.spec!.template, spec: { ...d.spec!.template.spec, nodeSelector: { disktype: "sdd" } } } } });
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "search running on the SSD Node",
        body: "Both `search` Pods are Running and Ready on the Node labelled `disktype=ssd`, and only `worker-2` carries a `disktype` label, as before.",
        check: (x) => {
          const labelled = x.cluster.list<Node>("Node").filter((n) => n.metadata.labels?.disktype !== undefined);
          if (labelled.length !== 1 || labelled[0].metadata.name !== "worker-2" || labelled[0].metadata.labels?.disktype !== "ssd") return false;
          const pods = readyPods(x.cluster, "search");
          return rolledOut(x.cluster, "search") && pods.length === 2 && pods.every((p) => p.spec?.nodeName === "worker-2");
        },
        hints: [
          "Both Pods are Pending, so the scheduler found no Node it was willing to use. The Pods may be asking for something specific. Look at what they require of a Node.",
          "`kubectl describe pods -l app=search` shows the scheduler's message. `kubectl get deployment search -o yaml` shows what the Pods ask for, and `kubectl get nodes --show-labels` shows what the Nodes offer.",
          "The message says `2 node(s) didn't match Pod's node affinity/selector`. The Pods select `disktype: sdd`, and `worker-2` carries `disktype=ssd`. Two letters are swapped.",
          "The Node labels are right and other teams rely on them. Correct the `nodeSelector` in the Deployment's Pod template.",
        ],
        solution: { commands: [`kubectl patch deployment search -p '{"spec":{"template":{"spec":{"nodeSelector":{"disktype":"ssd"}}}}}'`] },
      },
    ],
  },
  {
    slug: "ingress-ignored",
    start: ["kubectl get ingress", "kubectl get ingressclass", "curl http://shop.example/"],
    difficulty: "easy",
    track: "networking",
    title: "404 at the front door",
    summary: "Healthy Pods, but the public URL returns 404.",
    brief: "The `shop` Deployment, Service and Ingress went in yesterday. The Pods are Ready and the Service has endpoints, but from outside, a request to `http://shop.example/` returns a `404 Not Found` page. Customers must reach `shop` at `http://shop.example/`.",
    minutes: 4,
    concepts: ["Ingress", "IngressClass", "ingress-nginx"],
    setup: (c) => {
      deployment(c, "shop", "gcr.io/google-samples/hello-app:1.0", 2, "default", { ports: [{ containerPort: 8080 }] });
      service(c, "shop", 80, 8080);
      createAll(c, SHOP_INGRESS);
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "http://shop.example/ reaches shop",
        body: "ingress-nginx routes `http://shop.example/` to the `shop` Service, on a port the Service has, and `shop` Pods answer behind it.",
        check: (x) => ingressServes(x.cluster, "shop.example", "/", "shop"),
        hints: [
          "The 404 page comes from ingress-nginx itself, so the request reached the controller and found no route. Look at what the Ingress says about which controller should handle it.",
          "`kubectl get ingress` has a CLASS column. `kubectl get ingressclass` lists the classes this cluster has.",
          "The Ingress asks for the class `traefik`. The only IngressClass here is `nginx`, owned by ingress-nginx. No controller claims the Ingress, so no route is built for it.",
          "Change the Ingress's class to the one this cluster has, then request the host again.",
        ],
        solution: { commands: [`kubectl patch ingress shop -p '{"spec":{"ingressClassName":"nginx"}}'`] },
      },
    ],
  },
  {
    slug: "allow-frontend",
    start: ["kubectl get networkpolicy", "kubectl describe networkpolicy", "kubectl exec deploy/frontend -- wget -qO- --timeout=2 http://api"],
    difficulty: "medium",
    track: "networking",
    title: "Checkout calls time out",
    summary: "The frontend's calls to the API have timed out since this morning.",
    brief: "Since this morning's security rollout, the frontend's calls to the API time out. Don't remove or edit anything security put in place. `api` must accept traffic from `frontend` and from nothing else.",
    minutes: 7,
    concepts: ["NetworkPolicy", "Default deny", "Ingress rules"],
    setup: (c) => {
      deployment(c, "api", "nginxdemos/hello:plain-text", 2);
      service(c, "api", 80);
      deployment(c, "frontend", "busybox", 1, "default", { command: ["sh", "-c", "sleep 3600"] });
      c.create({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "default-deny-ingress" }, spec: { podSelector: {}, policyTypes: ["Ingress"] } } as never);
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "frontend reaches api, nobody else does",
        body: "The `frontend` Pod can open connections to the `api` Pods on port 80, a Pod with any other label can't, and `default-deny-ingress` is unchanged.",
        check: (x) => {
          const fe = readyPods(x.cluster, "frontend")[0];
          if (!denyAllIntact(x.cluster, "default-deny-ingress") || !fe || readyCount(x.cluster, "api") < 2) return false;
          const other = fakePod({ app: "debug" });
          return reaches(x.cluster, fe, "api", 80) && !reaches(x.cluster, other, "api", 80);
        },
        hints: [
          "The Pods are fine. The packets are dropped on the way in. Find which object decides what may reach the `api` Pods, and what it allows now.",
          "`kubectl describe networkpolicy default-deny-ingress` shows what the policy selects and allows. `kubectl get pods --show-labels` shows the labels you can select on.",
          "The policy selects every Pod in the namespace and lists no ingress rules: `Selected pods are isolated for ingress connectivity`. With nothing allowed, every connection to `api` is dropped, which matches the timeout.",
          "That policy has to stay as it is, and policies add up: a Pod accepts what any policy selecting it allows. Add a second policy that selects only the `api` Pods and allows ingress from the `frontend` Pods on port 80.",
        ],
        solution: { yaml: ALLOW_FRONTEND },
      },
    ],
  },
  {
    slug: "daemonset-tainted-node",
    start: ["kubectl get daemonset", "kubectl get pods -o wide", "kubectl describe nodes"],
    difficulty: "medium",
    track: "operations",
    title: "No logs from worker-2",
    summary: "The logging dashboard has nothing from one of the workers.",
    brief: "`log-agent` is supposed to run on every worker Node, but the logging dashboard has had nothing from `worker-2` for a week. `worker-2` is reserved for GPU jobs, and ordinary apps must still keep off it.",
    minutes: 6,
    concepts: ["DaemonSet", "Taints", "Tolerations"],
    setup: (c) => {
      const w2 = c.get<Node>("Node", undefined, "worker-2");
      c.replace({ ...w2, spec: { ...w2.spec, taints: [{ key: "gpu", value: "true", effect: "NoSchedule" }] } });
      c.create<DaemonSet>({
        apiVersion: "apps/v1",
        kind: "DaemonSet",
        metadata: { name: "log-agent", namespace: "default", labels: { app: "log-agent" } },
        spec: {
          selector: { matchLabels: { app: "log-agent" } },
          template: { metadata: { labels: { app: "log-agent" } }, spec: { containers: [{ name: "log-agent", image: "busybox", command: ["sh", "-c", "sleep 3600"] }] } },
        },
      });
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "log-agent on both workers, worker-2 still reserved",
        body: "A Ready `log-agent` Pod runs on `worker-1` and on `worker-2`, and `worker-2` still has its `gpu=true:NoSchedule` taint.",
        check: (x) => {
          if (!hasTaint(x.cluster, "worker-2", "gpu", "true", "NoSchedule")) return false;
          const on = new Set(readyPods(x.cluster, "log-agent").map((p) => p.spec?.nodeName));
          return on.has("worker-1") && on.has("worker-2");
        },
        hints: [
          "The DaemonSet wants a Pod on every worker, and one Node is missing a Pod. The scheduler skipped it on purpose. Look at what that Node says about who may run there.",
          "`kubectl describe node worker-2` shows its Taints. `kubectl get pods -o wide` shows where the agents run.",
          "`worker-2` has `Taints: gpu=true:NoSchedule`. A Pod without a matching toleration is kept off that Node, and the `log-agent` Pods have no tolerations.",
          "Leave the taint, so ordinary apps stay away. Add a toleration for it to the DaemonSet's Pod template, and the DaemonSet controller places the missing Pod.",
        ],
        solution: { commands: [`kubectl patch daemonset log-agent -p '{"spec":{"template":{"spec":{"tolerations":[{"key":"gpu","operator":"Equal","value":"true","effect":"NoSchedule"}]}}}}'`] },
      },
    ],
  },
  {
    slug: "hpa-stuck",
    start: ["kubectl get hpa", "kubectl describe hpa php-apache", "kubectl top pods"],
    difficulty: "medium",
    track: "operations",
    title: "The autoscaler that never scales",
    summary: "Heavy load, an HPA in place, and still a single Pod.",
    brief: "`php-apache` has been under heavy load all afternoon (the `load-generator` Pod is still running) and is slow, but it has stayed at 1 replica although it has an HPA. The HPA's settings were agreed with the team: target 50% CPU, 1 to 10 replicas. Leave them as they are, and don't drop the `log-shipper` sidecar: we need its logs. Get the HPA scaling the Deployment on its own.",
    minutes: 10,
    concepts: ["HorizontalPodAutoscaler", "Resource requests", "Sidecars"],
    setup: (c) => createAll(c, PHP_APACHE),
    warmupMs: 45_000,
    steps: [
      {
        title: "The HPA measures CPU and has scaled out",
        body: "The `php-apache` HPA (still CPU at 50%, 1 to 10 replicas, targeting the `php-apache` Deployment) reads a CPU utilization, is `ScalingActive`, and has raised the Deployment above 1 replica. The Pods still run the `log-shipper` sidecar.",
        check: (x) => {
          const c = x.cluster;
          const h = obj<HorizontalPodAutoscaler>(c, "HorizontalPodAutoscaler", "php-apache");
          const s = h?.spec;
          const m = s?.metrics ?? [];
          const settings =
            s?.scaleTargetRef.kind === "Deployment" && s.scaleTargetRef.name === "php-apache" && (s.minReplicas ?? 1) === 1 && s.maxReplicas === 10 && m.length === 1 && m[0].type === "Resource" && m[0].resource?.name === "cpu" && m[0].resource.target.type === "Utilization" && m[0].resource.target.averageUtilization === 50;
          const active = !!h?.status?.conditions?.some((cd) => cd.type === "ScalingActive" && cd.status === "True");
          const util = h?.status?.currentMetrics?.[0]?.resource?.current.averageUtilization;
          const d = dep(c, "php-apache");
          const sidecar = !!d?.spec?.template.spec.containers.some((ct) => ct.name === "log-shipper");
          const running = podsWith(c, "app", "php-apache").filter(isPodReady).length;
          return settings && active && util !== undefined && sidecar && (d?.spec?.replicas ?? 1) > 1 && running > 1;
        },
        hints: [
          "The HPA exists and the load is real, but it never acts. An autoscaler can only act on a number it can compute. Look at what it reports it is measuring.",
          "`kubectl get hpa` shows the TARGETS column. `kubectl describe hpa php-apache` shows its conditions and warnings.",
          "TARGETS reads `cpu: <unknown>/50%`, and the warning says `missing request for cpu in container log-shipper`. Utilization is usage divided by the request, over every container in the Pod, and one container has no CPU request. The Kubernetes docs say the autoscaler then takes no action for that metric.",
          "Give the container that has no CPU request a small one. Keep the sidecar and leave the HPA's settings alone. Check that TARGETS shows a number, then give it a minute to scale.",
        ],
        solution: { commands: ["kubectl set resources deployment php-apache -c log-shipper --requests=cpu=10m"] },
      },
    ],
  },
  {
    slug: "anti-affinity-third-replica",
    start: ["kubectl get pods -o wide", "kubectl get nodes"],
    difficulty: "hard",
    track: "operations",
    title: "The third replica",
    summary: "Scaled from 2 to 3 replicas, and the new Pod stays Pending.",
    brief: "We scaled `cache` from 2 to 3 replicas last night, and the new one has been Pending ever since. We need all 3 running, still spread over both workers so that losing one Node can't take every replica down. Keep it at 3 replicas, keep a rule in the Deployment that spreads the replicas across Nodes, and keep app Pods off the control-plane Node. A short restart of `cache` is fine.",
    minutes: 12,
    concepts: ["Pod anti-affinity", "Topology spread constraints", "FailedScheduling"],
    setup: (c) => {
      deployment(c, "cache", "redis:7", 3, "default");
      const d = c.get<Deployment>("Deployment", "default", "cache");
      const anti = { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: { app: "cache" } }, topologyKey: "kubernetes.io/hostname" }] };
      c.replace({ ...d, spec: { ...d.spec!, template: { ...d.spec!.template, spec: { ...d.spec!.template.spec, affinity: { podAntiAffinity: anti } } } } });
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "3 cache replicas Ready, on both workers",
        body: "The `cache` Deployment has 3 Ready Pods spread over `worker-1` and `worker-2`, its Pod template still spreads replicas across Nodes (preferred anti-affinity or a topology spread constraint on `kubernetes.io/hostname`), and the control-plane Node still keeps app Pods off.",
        check: (x) => {
          const d = dep(x.cluster, "cache");
          const spec = d?.spec?.template.spec;
          const host = "kubernetes.io/hostname";
          const spreads =
            !!spec?.affinity?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution?.some((w) => w.podAffinityTerm.topologyKey === host) || !!spec?.topologySpreadConstraints?.some((t) => t.topologyKey === host);
          const cpTainted = hasTaint(x.cluster, "control-plane", "node-role.kubernetes.io/control-plane", "", "NoSchedule");
          const pods = readyPods(x.cluster, "cache");
          const nodes = new Set(pods.map((p) => p.spec?.nodeName));
          return d?.spec?.replicas === 3 && spreads && cpTainted && rolledOut(x.cluster, "cache") && pods.length === 3 && nodes.has("worker-1") && nodes.has("worker-2") && !nodes.has("control-plane");
        },
        hints: [
          "Two replicas run and one is Pending. The third Pod isn't broken. It has nowhere it is allowed to go. Look at the rule the scheduler quotes for it.",
          "`kubectl describe pods -l app=cache` shows the Events, including the Pending Pod's. `kubectl get pods -o wide` shows which Node each replica is on.",
          "The Pending Pod's message mentions `pod anti-affinity rules`. The Deployment requires that no two `cache` Pods share a `kubernetes.io/hostname`. The two workers hold two replicas already, and the control plane is tainted, so the third has no Node.",
          "A required rule is a hard limit. A preferred rule spreads replicas when it can and allows doubling up when it can't. Switch the Deployment to a preferred rule, or to a topology spread constraint. If the rollout stalls, describe the new Pending Pod: the old Pods still carry the required rule, and a rolling update keeps them until the new ones are Ready.",
        ],
        solution: {
          commands: [
            `kubectl patch deployment cache -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null},"template":{"spec":{"affinity":{"podAntiAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":null,"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":100,"podAffinityTerm":{"labelSelector":{"matchLabels":{"app":"cache"}},"topologyKey":"kubernetes.io/hostname"}}]}}}}}}'`,
          ],
        },
      },
    ],
  },
  {
    slug: "storefront-gateway",
    start: ["kubectl get ingress -n shop", "kubectl describe ingress storefront -n shop", "kubectl get networkpolicy -n shop", "curl http://shop.example/"],
    difficulty: "hard",
    track: "networking",
    title: "The shop won't load",
    summary: "A new storefront that nobody outside can load.",
    brief: "The new `storefront` in namespace `shop` went live this morning and nobody outside can load it: a request to `http://shop.example/` fails. The Pods are Ready and look healthy in their logs. `shop` is a locked-down namespace: its `default-deny-ingress` policy must stay exactly as it is, and the storefront Pods may only accept traffic from the ingress controller, not from other Pods in `shop` or anywhere else in the cluster.",
    minutes: 14,
    concepts: ["Ingress", "Named ports", "NetworkPolicy", "namespaceSelector"],
    setup: (c) => createAll(c, STOREFRONT),
    warmupMs: 12_000,
    steps: [
      {
        title: "http://shop.example/ loads, and only through the Ingress",
        body: "ingress-nginx routes `http://shop.example/` to a port of the `storefront` Service and the controller may connect to the storefront Pods; other Pods, in `shop` or in other namespaces, still can't; `default-deny-ingress` in `shop` is unchanged.",
        check: (x) => {
          const c = x.cluster;
          const ctrl = ingressController(c);
          const pods = readyPods(c, "storefront", "shop");
          if (!ctrl || pods.length < 2 || !denyAllIntact(c, "default-deny-ingress", "shop") || !ingressServes(c, "shop.example", "/", "storefront")) return false;
          const fromCtrl = pods.every((p) => connectionAllowed(c, { pod: ctrl, ip: ctrl.status?.podIP ?? "" }, p, 8080));
          const strangers = [fakePod({ app: "debug" }, "shop"), fakePod({ app: "debug" }, "default"), fakePod({ "app.kubernetes.io/component": "controller" }, "default")];
          return fromCtrl && strangers.every((f) => !reaches(c, f, "storefront", 8080, "shop"));
        },
        hints: [
          "The error page comes from the ingress controller, so the request gets that far. Which error it is tells you how far along the path it got. Read the status code, not only the page.",
          "`curl http://shop.example/` shows the code. `kubectl get endpoints -n shop` shows whether the Service has any backends, and `kubectl describe svc storefront -n shop` shows where it forwards.",
          "A 503 with `<none>` under ENDPOINTS means the Service has no backends. Port 80 forwards to the named port `http`, but the Pods only name a port `web`, so no container port matches.",
          "Point the Service's `targetPort` at a port the Pods have. If the request then ends in a 504, the controller can't reach the Pods, because `default-deny-ingress` blocks it like everything else. The controller is a Pod too, in the `ingress-nginx` namespace. Add a policy that lets that namespace reach only the storefront Pods, on their port.",
        ],
        solution: { commands: [`kubectl patch service storefront -n shop --type=json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":"web"}]'`], yaml: ALLOW_INGRESS_NGINX },
      },
    ],
  },
];

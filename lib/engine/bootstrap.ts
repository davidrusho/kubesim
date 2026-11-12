// Builds a fresh cluster like `kind create cluster` would (built-in namespaces, Nodes, the
// `kubernetes` and `kube-dns` Services, the default RBAC roles and bindings, and optionally the
// kube-system Pods, plus kind's local-path provisioner as the default StorageClass "standard"),
// PLUS add-ons a plain kind cluster does NOT ship: ingress-nginx pre-installed (IngressClass
// "nginx", not the default, but it also serves Ingresses with no class) and metrics-server.
// So Ingress, `kubectl top` and the HPA work out of the box here, whereas on a real fresh kind
// cluster you'd install an Ingress controller and metrics-server first.

import type { Cluster } from "./cluster";
import { addNode } from "./nodes";
import { parseImage } from "./images";
import { SYSTEM_IMAGES } from "./host";
import { bootstrapStaticPods } from "./controllers/staticpods";
import { BUILTIN_CLUSTER_ROLES, BUILTIN_CLUSTER_ROLE_BINDINGS, runClusterRoleAggregation } from "./rbac";
import { SYSTEM_PRIORITY_CLASSES } from "./policy";
import type { DaemonSet, Deployment, Endpoints, EndpointSlice, Pod, Service } from "./types";

export const SYSTEM_NAMESPACES = new Set(["kube-system", "kube-public", "kube-node-lease", "local-path-storage", "ingress-nginx"]);

export function bootstrap(cluster: Cluster): void {
  const sys = cluster.state.config.systemPods;
  for (const name of ["default", "kube-node-lease", "kube-public", "kube-system", ...(sys ? ["local-path-storage", "ingress-nginx"] : [])]) {
    cluster.create({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
  }
  for (const pc of SYSTEM_PRIORITY_CLASSES) {
    cluster.create({ apiVersion: "scheduling.k8s.io/v1", kind: "PriorityClass", metadata: { name: pc.name }, value: pc.value, description: pc.description, preemptionPolicy: "PreemptLowerPriority" } as never);
  }
  for (const n of cluster.state.config.nodes) addNode(cluster, n.name, n.role);
  const cp = cluster.state.config.nodes.find((n) => n.role === "control-plane")?.name ?? cluster.state.config.nodes[0]?.name;

  for (const r of BUILTIN_CLUSTER_ROLES) {
    cluster.create({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: r.name, labels: { "kubernetes.io/bootstrapping": "rbac-defaults", ...(r.labels ?? {}) }, annotations: { "rbac.authorization.kubernetes.io/autoupdate": "true" } },
      ...(r.aggregationRule ? { aggregationRule: r.aggregationRule, rules: [] } : { rules: r.rules }),
    } as never);
  }
  for (const b of BUILTIN_CLUSTER_ROLE_BINDINGS) {
    cluster.create({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: b.name, labels: { "kubernetes.io/bootstrapping": "rbac-defaults" }, annotations: { "rbac.authorization.kubernetes.io/autoupdate": "true" } },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: b.role },
      ...(b.subjects ? { subjects: b.subjects } : {}),
    } as never);
  }
  // The clusterrole-aggregation controller fills admin/edit/view before anyone can use them.
  runClusterRoleAggregation(cluster, 5);

  cluster.create<Service>({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "kubernetes", namespace: "default", labels: { component: "apiserver", provider: "kubernetes" } },
    spec: { clusterIP: "10.96.0.1", ports: [{ name: "https", port: 443, protocol: "TCP", targetPort: 6443 }] },
  });
  cluster.put<Endpoints>({
    apiVersion: "v1",
    kind: "Endpoints",
    metadata: { name: "kubernetes", namespace: "default", uid: cluster.uid(), resourceVersion: "", creationTimestamp: cluster.now, labels: { "endpointslice.kubernetes.io/skip-mirror": "true" } },
    subsets: [{ addresses: [{ ip: "172.18.0.2" }], ports: [{ name: "https", port: 6443, protocol: "TCP" }] }],
  });
  // The apiserver's endpoint reconciler writes this slice itself: fixed name, no managed-by label.
  const apiSvc = cluster.raw("Service", "default", "kubernetes")!;
  cluster.put<EndpointSlice>({
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: { name: "kubernetes", namespace: "default", uid: `${apiSvc.metadata.uid.slice(0, 24)}5e1ce0000001`, resourceVersion: "", creationTimestamp: cluster.now, generation: 1, labels: { "kubernetes.io/service-name": "kubernetes" } },
    addressType: "IPv4",
    endpoints: [{ addresses: ["172.18.0.2"], conditions: { ready: true } }],
    ports: [{ name: "https", port: 6443, protocol: "TCP" }],
  });

  if (!sys) return;

  // Pre-pulled on every Node, so system Pods start fast.
  for (const rt of Object.values(cluster.state.nodes)) rt.images.push(...Object.values(SYSTEM_IMAGES).map((i) => parseImage(i).full));

  cluster.create({
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: { name: "standard", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
    provisioner: "rancher.io/local-path",
    reclaimPolicy: "Delete",
    volumeBindingMode: "WaitForFirstConsumer",
  } as never);
  cluster.create({
    apiVersion: "networking.k8s.io/v1",
    kind: "IngressClass",
    metadata: { name: "nginx", labels: { "app.kubernetes.io/component": "controller", "app.kubernetes.io/instance": "ingress-nginx", "app.kubernetes.io/name": "ingress-nginx" } },
    spec: { controller: "k8s.io/ingress-nginx" },
  } as never);

  cluster.create<Service>({
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: "kube-dns",
      namespace: "kube-system",
      labels: { "k8s-app": "kube-dns", "kubernetes.io/cluster-service": "true", "kubernetes.io/name": "CoreDNS" },
    },
    spec: {
      clusterIP: "10.96.0.10",
      selector: { "k8s-app": "kube-dns" },
      ports: [
        { name: "dns", port: 53, protocol: "UDP", targetPort: 53 },
        { name: "dns-tcp", port: 53, protocol: "TCP", targetPort: 53 },
        { name: "metrics", port: 9153, protocol: "TCP", targetPort: 9153 },
      ],
    },
  });

  if (cp) {
    // The control plane runs from the manifests on the host: the kubelet's static-Pod source turns each into a mirror Pod (ADR 0003).
    bootstrapStaticPods(cluster);
    // kind's ingress guide labels the control-plane Node for the ingress controller.
    const node = cluster.raw("Node", undefined, cp)!;
    cluster.put({ ...node, metadata: { ...node.metadata, labels: { ...(node.metadata.labels ?? {}), "ingress-ready": "true" } } });
  }

  cluster.create<DaemonSet>({
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: "kube-proxy", namespace: "kube-system", labels: { "k8s-app": "kube-proxy" } },
    spec: {
      selector: { matchLabels: { "k8s-app": "kube-proxy" } },
      template: {
        metadata: { labels: { "k8s-app": "kube-proxy" } },
        spec: {
          hostNetwork: true,
          priorityClassName: "system-node-critical",
          nodeSelector: { "kubernetes.io/os": "linux" },
          tolerations: [{ operator: "Exists" }],
          containers: [{ name: "kube-proxy", image: SYSTEM_IMAGES["kube-proxy"], command: ["/usr/local/bin/kube-proxy", "--config=/var/lib/kube-proxy/config.conf", "--hostname-override=$(NODE_NAME)"] }],
        },
      },
    },
  });

  const deploy = (ns: string, name: string, labels: Record<string, string>, spec: Pod["spec"] & object, replicas = 1) =>
    cluster.create<Deployment>({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace: ns, labels },
      spec: { replicas, selector: { matchLabels: labels }, strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: 1 } }, template: { metadata: { labels }, spec } },
    });

  deploy(
    "kube-system",
    "coredns",
    { "k8s-app": "kube-dns" },
    {
      priorityClassName: "system-cluster-critical",
      tolerations: [
        { key: "CriticalAddonsOnly", operator: "Exists" },
        { key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" },
      ],
      containers: [
        {
          name: "coredns",
          image: SYSTEM_IMAGES.coredns,
          args: ["-conf", "/etc/coredns/Corefile"],
          resources: { requests: { cpu: "100m", memory: "70Mi" }, limits: { memory: "170Mi" } },
          ports: [
            { containerPort: 53, name: "dns", protocol: "UDP" },
            { containerPort: 53, name: "dns-tcp", protocol: "TCP" },
            { containerPort: 9153, name: "metrics", protocol: "TCP" },
          ],
        },
      ],
    },
    2,
  );

  deploy("kube-system", "metrics-server", { "k8s-app": "metrics-server" }, {
    priorityClassName: "system-cluster-critical",
    containers: [{ name: "metrics-server", image: SYSTEM_IMAGES["metrics-server"], args: ["--cert-dir=/tmp", "--secure-port=10250", "--kubelet-insecure-tls", "--metric-resolution=15s"], resources: { requests: { cpu: "100m", memory: "200Mi" } }, ports: [{ containerPort: 10250, name: "https", protocol: "TCP" }] }],
  });
  cluster.create<Service>({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "metrics-server", namespace: "kube-system", labels: { "k8s-app": "metrics-server" } },
    spec: { selector: { "k8s-app": "metrics-server" }, ports: [{ name: "https", port: 443, protocol: "TCP", targetPort: "https" }] },
  });
  // From metrics-server's components.yaml: lets view/edit/admin read metrics.k8s.io (kubectl top).
  cluster.create({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: { name: "system:aggregated-metrics-reader", labels: { "k8s-app": "metrics-server", "rbac.authorization.k8s.io/aggregate-to-admin": "true", "rbac.authorization.k8s.io/aggregate-to-edit": "true", "rbac.authorization.k8s.io/aggregate-to-view": "true" } },
    rules: [{ apiGroups: ["metrics.k8s.io"], resources: ["pods", "nodes"], verbs: ["get", "list", "watch"] }],
  } as never);
  runClusterRoleAggregation(cluster, 5);

  deploy("local-path-storage", "local-path-provisioner", { app: "local-path-provisioner" }, {
    tolerations: [{ key: "node-role.kubernetes.io/control-plane", operator: "Exists", effect: "NoSchedule" }],
    nodeSelector: { "kubernetes.io/os": "linux" },
    containers: [{ name: "local-path-provisioner", image: SYSTEM_IMAGES["local-path"], command: ["local-path-provisioner", "--debug", "start", "--helper-image", "docker.io/kindest/local-path-helper:v20250516-5dbe5e3f", "--config", "/etc/config/config.json"] }],
  });

  const ingLabels = { "app.kubernetes.io/component": "controller", "app.kubernetes.io/instance": "ingress-nginx", "app.kubernetes.io/name": "ingress-nginx" };
  deploy("ingress-nginx", "ingress-nginx-controller", ingLabels, {
    nodeSelector: { "ingress-ready": "true", "kubernetes.io/os": "linux" },
    tolerations: [{ key: "node-role.kubernetes.io/control-plane", operator: "Equal", effect: "NoSchedule" }],
    terminationGracePeriodSeconds: 0,
    containers: [
      {
        name: "controller",
        image: SYSTEM_IMAGES["ingress-nginx"],
        args: ["/nginx-ingress-controller", "--election-id=ingress-nginx-leader", "--controller-class=k8s.io/ingress-nginx", "--ingress-class=nginx", "--watch-ingress-without-class=true", "--publish-status-address=localhost"],
        resources: { requests: { cpu: "100m", memory: "90Mi" } },
        ports: [
          { containerPort: 80, name: "http", protocol: "TCP", hostPort: 80 } as never,
          { containerPort: 443, name: "https", protocol: "TCP", hostPort: 443 } as never,
        ],
      },
    ],
  });
  cluster.create<Service>({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "ingress-nginx-controller", namespace: "ingress-nginx", labels: ingLabels },
    spec: {
      type: "NodePort",
      selector: ingLabels,
      ports: [
        { name: "http", port: 80, protocol: "TCP", targetPort: "http" },
        { name: "https", port: 443, protocol: "TCP", targetPort: "https" },
      ],
    },
  });
}

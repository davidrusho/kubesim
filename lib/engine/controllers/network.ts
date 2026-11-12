// Small controllers around networking and namespaces:
//  - service-lb: gives LoadBalancer Services an external IP from a local pool,
//    like cloud-provider-kind or MetalLB on a kind cluster;
//  - ingress-nginx status: once the controller runs, Ingresses get ADDRESS
//    "localhost" (kind's port mapping);
//  - serviceaccount + root-ca-cert-publisher: every namespace has a
//    `default` ServiceAccount and a `kube-root-ca.crt` ConfigMap.

import type { Cluster } from "../cluster";
import type { Ingress, Namespace, Pod, Service } from "../types";

const LB_DELAY_MS = 2_000;
const INGRESS_SYNC_MS = 3_000;
const ROOT_CA = "-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIKubeSimCA0AwDQYJKoZIhvcNAQELBQAwFTETMBEGA1UE\nAxMKa3ViZXJuZXRlczAeFw0yNjAxMDEwOTAwMDBaFw0zNjAxMDEwOTAwMDBaMBUx\n-----END CERTIFICATE-----\n";

export function ensureNamespaceDefaults(cluster: Cluster, ns: string): void {
  const n = cluster.raw("Namespace", undefined, ns) as unknown as Namespace | undefined;
  if (!n || n.status?.phase === "Terminating") return;
  if (!cluster.raw("ServiceAccount", ns, "default")) {
    cluster.put({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "default", namespace: ns, uid: cluster.uid(), resourceVersion: "", creationTimestamp: cluster.now } });
  }
  if (!cluster.raw("ConfigMap", ns, "kube-root-ca.crt")) {
    cluster.put({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "kube-root-ca.crt", namespace: ns, uid: cluster.uid(), resourceVersion: "", creationTimestamp: cluster.now, annotations: { "kubernetes.io/description": "Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters." } },
      data: { "ca.crt": ROOT_CA },
    } as never);
  }
}

/** The local LoadBalancer pool, like a MetalLB range on the kind network: 172.18.255.200-250. */
const LB_FIRST = 200;
const LB_SIZE = 51;

/** Next free pool address after the last one handed out (freed addresses are reused, wrapping around). */
function allocLbIp(cluster: Cluster): string | undefined {
  const used = new Set<string>();
  for (const s of cluster.list<Service>("Service")) for (const i of s.status?.loadBalancer?.ingress ?? []) if (i.ip) used.add(i.ip);
  for (let k = 0; k < LB_SIZE; k++) {
    const n = (cluster.state.lbNext + k) % LB_SIZE;
    const ip = `172.18.255.${LB_FIRST + n}`;
    if (used.has(ip)) continue;
    cluster.state.lbNext = (n + 1) % LB_SIZE;
    return ip;
  }
  return undefined;
}

/** `kcmUp` is false while kube-controller-manager is down: the default ServiceAccount and kube-root-ca.crt are its work, the LoadBalancer and Ingress addresses are not. */
export function runNetworkControllers(cluster: Cluster, kcmUp = true): void {
  const now = cluster.now;
  const timers = cluster.state.timers;

  for (const svc of cluster.list<Service>("Service")) {
    if (svc.spec?.type !== "LoadBalancer") {
      if (svc.status?.loadBalancer?.ingress?.length) cluster.update(svc, (x) => void (x.status = { loadBalancer: {} }));
      continue;
    }
    if (svc.status?.loadBalancer?.ingress?.length) continue;
    const key = `lb/${svc.metadata.uid}`;
    timers[key] ??= now + LB_DELAY_MS;
    if (now < timers[key]) continue;
    const ip = allocLbIp(cluster);
    if (!ip) continue; // pool exhausted: stays <pending> until an address frees up
    delete timers[key];
    cluster.update(svc, (x) => void (x.status = { loadBalancer: { ingress: [{ ip, ipMode: "VIP" }] } }));
    cluster.record(svc, "Normal", "EnsuringLoadBalancer", "Ensuring load balancer", "service-controller");
    cluster.record(svc, "Normal", "EnsuredLoadBalancer", "Ensured load balancer", "service-controller");
  }

  if (now % 1000 === 0) {
    const controller = cluster.list<Pod>("Pod", "ingress-nginx").find((p) => p.metadata.labels?.["app.kubernetes.io/component"] === "controller" && p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"));
    for (const ing of cluster.list<Ingress>("Ingress")) {
      if (ing.spec?.ingressClassName && ing.spec.ingressClassName !== "nginx") continue;
      const has = !!ing.status?.loadBalancer?.ingress?.length;
      if (!controller) continue;
      if (has) continue;
      const key = `ing/${ing.metadata.uid}`;
      if (timers[key] === undefined) {
        timers[key] = now + INGRESS_SYNC_MS;
        cluster.record(ing, "Normal", "Sync", "Scheduled for sync", "nginx-ingress-controller", controller.spec?.nodeName);
      }
      if (now < timers[key]) continue;
      delete timers[key];
      cluster.update(ing, (x) => void (x.status = { loadBalancer: { ingress: [{ hostname: "localhost" }] } }));
    }
    if (kcmUp) for (const ns of cluster.list<Namespace>("Namespace")) ensureNamespaceDefaults(cluster, ns.metadata.name);
  }
}

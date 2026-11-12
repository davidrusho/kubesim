// More Challenges (see ../challenges.ts for the format and the rules).
// Security: RBAC and securityContext, plus three multi-fault incidents.
import type { Cluster, Container, NetworkPolicy, PodSpec, Service } from "@/lib/engine";
import { connectionAllowed, isIsolated } from "@/lib/engine";
import type { Challenge } from "../challenges";
import { can, dep, endpointCount, fakePod, obj, podsWith, readyCount, rolledOut, service, up } from "../lessons";

const ns = (c: Cluster, name: string) => c.create({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
const RBAC = "rbac.authorization.k8s.io";

/** A Deployment with full control over the Pod template (securityContext, serviceAccountName, volumes). */
function workload(c: Cluster, name: string, namespace: string, replicas: number, spec: Record<string, unknown>, labels: Record<string, string> = { app: name }) {
  c.create({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels: { app: name } },
    spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels }, spec } },
  } as never);
}

type Sc = { runAsNonRoot?: boolean; runAsUser?: number; readOnlyRootFilesystem?: boolean };
const scOf = (x: unknown): Sc => ((x as { securityContext?: Sc } | undefined)?.securityContext ?? {});
/** Every container runs with runAsNonRoot in force (container settings override the Pod's) and a non-zero UID. */
const nonRootUser = (spec: PodSpec | undefined) =>
  !!spec?.containers.length &&
  spec.containers.every((ct) => {
    const sc = { ...scOf(spec), ...scOf(ct) };
    return sc.runAsNonRoot === true && typeof sc.runAsUser === "number" && sc.runAsUser > 0;
  });
/** All Pods of a Deployment are current, Ready, and pass `ok`; so does the template. */
const allPods = (c: Cluster, app: string, namespace: string, n: number, ok: (s: PodSpec | undefined) => boolean) => {
  const pods = podsWith(c, "app", app, namespace);
  return rolledOut(c, app, namespace) && readyCount(c, app, namespace) === n && pods.length === n && pods.every((p) => up(p) && ok(p.spec)) && ok(dep(c, app, namespace)?.spec?.template.spec);
};

const sa = (namespace: string, name: string) => `system:serviceaccount:${namespace}:${name}`;

// ---------------------------------------------------------------- manifests

const AGENT_FIXED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent
spec:
  replicas: 2
  selector:
    matchLabels:
      app: agent
  template:
    metadata:
      labels:
        app: agent
    spec:
      containers:
      - name: agent
        image: busybox
        command: ["sh", "-c", "while true; do date > /tmp/heartbeat; sleep 5; done"]
        securityContext:
          readOnlyRootFilesystem: true
        readinessProbe:
          exec:
            command: ["cat", "/tmp/heartbeat"]
          periodSeconds: 5
        volumeMounts:
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: tmp
        emptyDir: {}
`;

const AGENT_SCRIPT = "while true; do date > /tmp/heartbeat; sleep 5; done";
const PAYMENTS_DB_PASSWORD = "pay-2026-k8s";

/** The volume mounted at `path` in this container is writable scratch or storage, not a projected file. */
const writableAt = (spec: PodSpec | undefined, ct: Container | undefined, path: string) => {
  const m = ct?.volumeMounts?.find((x) => x.mountPath.replace(/\/+$/, "") === path && !x.subPath);
  const v = m && spec?.volumes?.find((x) => x.name === m.name);
  return !!v && !m!.readOnly && !!(v.emptyDir || v.persistentVolumeClaim || v.hostPath);
};

/** The Service's port `port` forwards to `want` on the Pods (by number, or by a named containerPort). */
const forwardsTo = (c: Cluster, svc: string, namespace: string, port: number, want: number) => {
  const sp = obj<Service>(c, "Service", svc, namespace)?.spec?.ports?.find((p) => p.port === port);
  if (!sp) return false;
  const tp = sp.targetPort ?? sp.port;
  if (typeof tp === "number") return tp === want;
  if (/^\d+$/.test(tp)) return +tp === want;
  const pods = podsWith(c, "app", svc, namespace).filter(up);
  return pods.length > 0 && pods.every((p) => p.spec?.containers.some((ct) => ct.ports?.some((x) => x.name === tp && x.containerPort === want)));
};

export const SECURITY_CHALLENGES: Challenge[] = [
  {
    slug: "run-as-nonroot",
    start: ["kubectl get pods", "kubectl describe pods -l app=worker"],
    difficulty: "easy",
    track: "security",
    title: "Pods that won't start",
    summary: "Neither Pod of a Deployment has started since this morning's change.",
    brief:
      "Since this morning's change neither `worker` Pod has started. `worker` is a plain busybox loop that doesn't care which user it runs as. The Deployment must keep `runAsNonRoot: true`: removing it or setting it to `false` doesn't count.",
    minutes: 4,
    concepts: ["securityContext", "runAsNonRoot", "CreateContainerConfigError"],
    setup: (c) =>
      workload(c, "worker", "default", 2, {
        securityContext: { runAsNonRoot: true },
        containers: [{ name: "worker", image: "busybox", command: ["sh", "-c", "while true; do echo processed a batch; sleep 10; done"] }],
      }),
    warmupMs: 15_000,
    steps: [
      {
        title: "worker running as a non-root user",
        body: "Both `worker` Pods are Running and Ready, `runAsNonRoot` is still in force, and they run as a non-zero UID.",
        check: (x) => allPods(x.cluster, "worker", "default", 2, nonRootUser),
        hints: [
          "The Pods never run a container. The image is pulled, and then something stops the container being created. Look at the last warning the kubelet raised.",
          "`kubectl describe pods -l app=worker` shows the warning in the Events.",
          "The warning says `container has runAsNonRoot and image will run as root`. The Kubernetes docs say that with `runAsNonRoot: true` the kubelet checks the image and fails to start the container if it would run as UID 0. The busybox image doesn't name a user, so the kubelet sees root.",
          "Keep `runAsNonRoot` and name a user: a non-zero UID in the securityContext. A Pod-level securityContext applies to every container in it.",
        ],
        solution: { commands: [`kubectl patch deployment worker -p '{"spec":{"template":{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000}}}}}'`] },
      },
    ],
  },
  {
    slug: "readonly-tmp",
    start: ["kubectl get pods -l app=agent", "kubectl logs deploy/agent"],
    difficulty: "medium",
    track: "security",
    title: "Running, never Ready",
    summary: "Both Pods are Running but neither becomes Ready.",
    brief:
      "Since yesterday both `agent` Pods are Running but show `0/1` under READY, and the rollout never finishes. The read-only root filesystem must stay on, and so must the readiness probe.",
    minutes: 7,
    concepts: ["securityContext", "readOnlyRootFilesystem", "emptyDir", "Readiness probe"],
    setup: (c) =>
      workload(c, "agent", "default", 2, {
        containers: [
          {
            name: "agent",
            image: "busybox",
            command: ["sh", "-c", AGENT_SCRIPT],
            securityContext: { readOnlyRootFilesystem: true },
            readinessProbe: { exec: { command: ["cat", "/tmp/heartbeat"] }, periodSeconds: 5 },
          },
        ],
      }),
    warmupMs: 20_000,
    steps: [
      {
        title: "agent Ready with a read-only root filesystem",
        body: "Both `agent` Pods are Ready. Their root filesystem is still read-only, the readiness probe still reads `/tmp/heartbeat`, and `/tmp` is a writable volume.",
        check: (x) =>
          allPods(x.cluster, "agent", "default", 2, (s) => {
            const ct = s?.containers.find((k) => k.name === "agent");
            return scOf(ct).readOnlyRootFilesystem === true && JSON.stringify(ct?.readinessProbe?.exec?.command) === JSON.stringify(["cat", "/tmp/heartbeat"]) && writableAt(s, ct, "/tmp");
          }),
        hints: [
          "The Pods are Running but never Ready, so the readiness check fails while the app is alive. Look at what the check does, and at what the app is meant to produce for it.",
          "`kubectl describe pods -l app=agent` shows the failing probe. `kubectl logs deploy/agent` shows what the app complains about.",
          "The probe reads `/tmp/heartbeat` and fails with `No such file`. The app logs `can't create /tmp/heartbeat: Read-only file system`. The root filesystem is read-only, so the app can't write the file the probe wants.",
          "Keep the root filesystem read-only and give the app somewhere writable. Mount a volume at `/tmp`: an `emptyDir` is enough for scratch files.",
        ],
        solution: { yaml: AGENT_FIXED },
      },
    ],
  },
  {
    slug: "node-reader",
    start: ["kubectl get role,rolebinding -n monitoring", "kubectl auth can-i list nodes --as=system:serviceaccount:monitoring:capacity-report"],
    difficulty: "medium",
    track: "security",
    title: "Nodes are forbidden",
    summary: "A report that fails with `nodes is forbidden`.",
    brief:
      "The capacity report runs as ServiceAccount `capacity-report` in namespace `monitoring`. It fails with `nodes is forbidden: User \"system:serviceaccount:monitoring:capacity-report\" cannot list resource \"nodes\" in API group \"\" at the cluster scope`. It needs to read Nodes and nothing more: no cluster-admin, no changes to Nodes, no Secrets or Pods.",
    minutes: 7,
    concepts: ["RBAC", "ClusterRole", "ClusterRoleBinding", "kubectl auth can-i"],
    setup: (c) => {
      ns(c, "monitoring");
      c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "capacity-report", namespace: "monitoring" } });
      c.create({ apiVersion: `${RBAC}/v1`, kind: "Role", metadata: { name: "node-reader", namespace: "monitoring" }, rules: [{ apiGroups: [""], resources: ["nodes"], verbs: ["get", "list", "watch"] }] } as never);
      c.create({
        apiVersion: `${RBAC}/v1`,
        kind: "RoleBinding",
        metadata: { name: "capacity-report", namespace: "monitoring" },
        roleRef: { apiGroup: RBAC, kind: "Role", name: "node-reader" },
        subjects: [{ kind: "ServiceAccount", name: "capacity-report", namespace: "monitoring" }],
      } as never);
    },
    warmupMs: 5_000,
    steps: [
      {
        title: "capacity-report may read Nodes, and nothing more",
        body: "`system:serviceaccount:monitoring:capacity-report` may get, list and watch Nodes. It may not create, change or delete Nodes, and may not read Secrets or Pods.",
        check: (x) => {
          const who = sa("monitoring", "capacity-report");
          const c = x.cluster;
          return (
            ["get", "list", "watch"].every((v) => can(c, who, v, "nodes")) &&
            !["create", "update", "patch", "delete"].some((v) => can(c, who, v, "nodes")) &&
            !can(c, who, "list", "secrets") &&
            !can(c, who, "get", "secrets", "monitoring") &&
            !can(c, who, "list", "pods") &&
            !can(c, who, "list", "pods", "kube-system")
          );
        },
        hints: [
          "The Role and the RoleBinding exist and look right, and access is still denied. Think about where Nodes live. Some objects belong to a namespace and some don't.",
          "`kubectl api-resources` has a NAMESPACED column. `kubectl auth can-i list nodes --as=system:serviceaccount:monitoring:capacity-report` asks the API server directly.",
          "`nodes` shows `false` under NAMESPACED, and the answer to can-i is `no`. A Role sets permissions within one namespace, so a Role on `nodes` can never apply. The RBAC docs say a ClusterRole is the one to use to define permissions on cluster-scoped resources.",
          "Grant access with the cluster-wide pair: a ClusterRole with the read verbs on `nodes`, and a ClusterRoleBinding that binds it to the ServiceAccount, with its namespace. Keep it to get, list and watch.",
        ],
        solution: {
          commands: [
            "kubectl create clusterrole node-reader --verb=get,list,watch --resource=nodes",
            "kubectl create clusterrolebinding capacity-report-nodes --clusterrole=node-reader --serviceaccount=monitoring:capacity-report",
          ],
        },
      },
    ],
  },
  {
    slug: "hardening-rollout",
    start: ["kubectl get all -n shop", "kubectl get networkpolicy -n shop", "kubectl exec deploy/frontend -- wget -qO- --timeout=2 http://shop.shop"],
    difficulty: "hard",
    track: "security",
    title: "Three things broke on Monday",
    summary: "A storefront that times out, a pipeline that is Forbidden and a Pod that won't start.",
    brief:
      "**Pager, Monday 09:12: shop namespace.** A security hardening change went out over the weekend. Since then:\n\n- The storefront is unreachable: a request from a frontend Pod to `http://shop.shop` times out.\n- The CI pipeline, running as ServiceAccount `ci` in `shop`, fails with `deployments.apps \"shop\" is forbidden: User \"system:serviceaccount:shop:ci\" cannot patch resource \"deployments\" in API group \"apps\" in the namespace \"shop\"`.\n- The `audit` Pod never starts.\n\nKeep the hardening: the `default-deny` policy stays and only `shop` may receive traffic, `audit` keeps `runAsNonRoot`, and CI gets no cluster-admin, no delete and no Secrets.",
    minutes: 12,
    concepts: ["NetworkPolicy", "RBAC", "API groups", "runAsNonRoot"],
    setup: (c) => {
      ns(c, "shop");
      c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "ci", namespace: "shop" } });
      c.create({ apiVersion: `${RBAC}/v1`, kind: "Role", metadata: { name: "ci-deployer", namespace: "shop" }, rules: [{ apiGroups: [""], resources: ["deployments"], verbs: ["get", "list", "watch", "patch", "update"] }] } as never);
      c.create({
        apiVersion: `${RBAC}/v1`,
        kind: "RoleBinding",
        metadata: { name: "ci-deployer", namespace: "shop" },
        roleRef: { apiGroup: RBAC, kind: "Role", name: "ci-deployer" },
        subjects: [{ kind: "ServiceAccount", name: "ci", namespace: "shop" }],
      } as never);
      c.create({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "default-deny", namespace: "shop" }, spec: { podSelector: {}, policyTypes: ["Ingress"] } } as never);
      c.create({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-shop", namespace: "shop" },
        spec: { podSelector: { matchLabels: { app: "storefront" } }, policyTypes: ["Ingress"], ingress: [{ ports: [{ port: 80 }] }] },
      } as never);
      workload(c, "shop", "shop", 2, { containers: [{ name: "shop", image: "nginx:1.27", ports: [{ containerPort: 80 }] }] });
      service(c, "shop", 80, 80, "shop");
      workload(c, "audit", "shop", 1, {
        securityContext: { runAsNonRoot: true },
        containers: [{ name: "audit", image: "busybox", command: ["sh", "-c", "while true; do echo audit: checked recent events; sleep 30; done"], securityContext: { runAsUser: 0 } }],
      });
      workload(c, "frontend", "default", 1, { containers: [{ name: "frontend", image: "busybox", command: ["sh", "-c", "sleep 3600"] }] });
    },
    warmupMs: 15_000,
    steps: [
      {
        title: "shop reachable again, behind default-deny",
        body: "Pods outside `shop` (like `frontend`) can open connections to both `shop` Pods on port 80. The `default-deny` policy is still in place, so other Pods in `shop` still accept no traffic.",
        check: (x) => {
          const c = x.cluster;
          const deny = obj<NetworkPolicy>(c, "NetworkPolicy", "default-deny", "shop");
          const sel = deny?.spec?.podSelector;
          const denyIntact = !!deny && !Object.keys(sel?.matchLabels ?? {}).length && !(sel?.matchExpressions ?? []).length && (deny.spec?.policyTypes ?? []).includes("Ingress") && !(deny.spec?.ingress ?? []).length;
          const fe = fakePod({ app: "frontend" });
          const from = { pod: fe, ip: fe.status!.podIP! };
          const shopPods = podsWith(c, "app", "shop", "shop").filter(up);
          return (
            denyIntact &&
            shopPods.length === 2 &&
            endpointCount(c, "shop", "shop") === 2 &&
            shopPods.every((p) => isIsolated(c, p, "Ingress") && connectionAllowed(c, from, p, 80)) &&
            !connectionAllowed(c, from, fakePod({ app: "audit" }, "shop"), 80)
          );
        },
        hints: [
          "A timeout, not a refusal: the packets are dropped before they reach the app. Something in the namespace decides which Pods may receive traffic.",
          "`kubectl describe networkpolicy -n shop` shows what each policy selects. `kubectl get pods -n shop --show-labels` shows the labels the Pods carry.",
          "`allow-shop` selects `app=storefront` and lets port 80 in, but the Pods are labelled `app=shop`. Nothing allows them, and `default-deny` drops everything else.",
          "Leave `default-deny` alone. Correct the selector of the allow policy so it matches the Pods that should be reachable. The `audit` Pods stay closed.",
        ],
        solution: { commands: [`kubectl patch networkpolicy allow-shop -n shop -p '{"spec":{"podSelector":{"matchLabels":{"app":"shop"}}}}'`] },
      },
      {
        title: "CI can deploy shop, and no more",
        body: "`system:serviceaccount:shop:ci` may get and patch Deployments in `shop`. It may not delete them, read Secrets, or touch Deployments outside `shop`.",
        check: (x) => {
          const c = x.cluster;
          const who = sa("shop", "ci");
          return (
            can(c, who, "get", "deployments", "shop", "apps") &&
            can(c, who, "patch", "deployments", "shop", "apps") &&
            !can(c, who, "delete", "deployments", "shop", "apps") &&
            !can(c, who, "get", "secrets", "shop") &&
            !can(c, who, "patch", "deployments", "default", "apps")
          );
        },
        hints: [
          "CI is denied a verb on a resource it should be allowed to use. Ask the API server what it says, then read the rule that was meant to grant it.",
          "`kubectl auth can-i patch deployments.apps -n shop --as=system:serviceaccount:shop:ci` asks the API server. `kubectl describe role ci-deployer -n shop` shows the rule.",
          "The answer is `no`. The rule lists `deployments` with no group after it, which means the core API group. Deployments live in the `apps` group, and kubectl would print that as `deployments.apps`. The binding is fine, but the rule matches nothing CI needs.",
          "Change the rule's API group to the one Deployments are in. Keep the verbs as they are, then check that delete and reading Secrets are still refused.",
        ],
        solution: { commands: [`kubectl patch role ci-deployer -n shop --type=json -p '[{"op":"replace","path":"/rules/0/apiGroups","value":["apps"]}]'`] },
      },
      {
        title: "audit running as non-root",
        body: "The `audit` Pod is Running and Ready, with `runAsNonRoot` still in force and a non-zero UID.",
        check: (x) => allPods(x.cluster, "audit", "shop", 1, nonRootUser),
        hints: [
          "The `audit` Pod isn't running. Read the kubelet's last warning about it.",
          "`kubectl describe pods -n shop -l app=audit` shows the warning in the Events.",
          "The warning says `container's runAsUser breaks non-root policy`. The Pod sets `runAsNonRoot: true`, and the audit container sets `runAsUser: 0` itself. The Kubernetes docs say a value in the container's securityContext takes precedence over the Pod's, and 0 is root.",
          "Keep `runAsNonRoot`. Change the container's `runAsUser` to a non-zero UID.",
        ],
        solution: { commands: [`kubectl patch deployment audit -n shop -p '{"spec":{"template":{"spec":{"containers":[{"name":"audit","securityContext":{"runAsUser":1000}}]}}}}'`] },
      },
    ],
  },
  {
    slug: "payments-onboarding",
    start: ["kubectl get all -n payments", "kubectl get rolebindings -A", "kubectl exec deploy/frontend -- wget -qO- --timeout=2 http://payments-api.payments"],
    difficulty: "hard",
    track: "security",
    title: "The new team can't launch",
    summary: "A new team is blocked: a Forbidden error, a stuck Pod and failing requests.",
    brief:
      "**Pager: payments launch blocked.** The `payments` namespace was set up yesterday. This morning:\n\n- Alice (user `alice`) gets `Error from server (Forbidden): deployments.apps is forbidden: User \"alice\" cannot list resource \"deployments\" in API group \"apps\" in the namespace \"payments\"`.\n- The `payments-api` Pods have been stuck in ContainerCreating since they were created.\n- Requests from `frontend` to `http://payments-api.payments` fail.\n\nAlice should have the built-in `edit` access in `payments` and no access anywhere else. `payments-api` must keep reading its database password from the Secret `payments-db`.",
    minutes: 12,
    concepts: ["RoleBinding", "Namespaces", "Secret volume", "FailedMount", "targetPort"],
    setup: (c) => {
      ns(c, "payments");
      c.create({
        apiVersion: `${RBAC}/v1`,
        kind: "RoleBinding",
        metadata: { name: "payments-devs", namespace: "default" },
        roleRef: { apiGroup: RBAC, kind: "ClusterRole", name: "edit" },
        subjects: [{ apiGroup: RBAC, kind: "User", name: "alice" }],
      } as never);
      c.create({ apiVersion: "v1", kind: "Secret", metadata: { name: "payments-db", namespace: "default" }, type: "Opaque", data: { password: btoa(PAYMENTS_DB_PASSWORD) } } as never);
      workload(c, "payments-api", "payments", 2, {
        containers: [{ name: "payments-api", image: "nginx:1.27", ports: [{ containerPort: 80 }], volumeMounts: [{ name: "db", mountPath: "/etc/payments-db", readOnly: true }] }],
        volumes: [{ name: "db", secret: { secretName: "payments-db" } }],
      });
      service(c, "payments-api", 80, 8080, "payments");
      workload(c, "frontend", "default", 1, { containers: [{ name: "frontend", image: "busybox", command: ["sh", "-c", "sleep 3600"] }] });
    },
    warmupMs: 15_000,
    steps: [
      {
        title: "Alice can work in payments, and only there",
        body: "`alice` may create Deployments and read Pods in `payments` (the `edit` ClusterRole), may not manage RBAC there, and has no access in any other namespace or to Nodes.",
        check: (x) => {
          const c = x.cluster;
          return (
            can(c, "alice", "create", "deployments", "payments", "apps") &&
            can(c, "alice", "get", "pods", "payments") &&
            !can(c, "alice", "create", "rolebindings", "payments", RBAC) &&
            !can(c, "alice", "get", "pods", "default") &&
            !can(c, "alice", "create", "deployments", "default", "apps") &&
            !can(c, "alice", "list", "nodes")
          );
        },
        hints: [
          "Alice is refused in a namespace where she should have access. Access is granted by a binding, and a binding lives in one namespace. Find where hers is.",
          "`kubectl get rolebindings -A` lists the bindings with their namespaces. `kubectl auth can-i list deployments -n payments --as=alice` asks the API server directly.",
          "The binding `payments-devs` is in `default`, not `payments`. The RBAC docs say a RoleBinding grants permissions within a specific namespace, so it gives Alice `edit` in the wrong place.",
          "Create the binding in `payments` and remove the stray one in `default`, so Alice has no access there. Bind the `edit` ClusterRole, as the brief asks.",
        ],
        solution: { commands: ["kubectl delete rolebinding payments-devs -n default", "kubectl create rolebinding payments-devs --clusterrole=edit --user=alice -n payments"] },
      },
      {
        title: "payments-api running with its credentials",
        body: "Both `payments-api` Pods are Running and Ready, mounting the Secret `payments-db` from `payments`, which holds the database `password`.",
        check: (x) => {
          const c = x.cluster;
          const s = obj<{ data?: Record<string, string> }>(c, "Secret", "payments-db", "payments");
          return s?.data?.password === btoa(PAYMENTS_DB_PASSWORD) && allPods(c, "payments-api", "payments", 2, (sp) => !!sp?.volumes?.some((v) => v.secret?.secretName === "payments-db"));
        },
        hints: [
          "The Pods have a Node but no container yet. Read what the kubelet reports against them.",
          "`kubectl describe pods -n payments` shows the Events. `kubectl get secrets -A` shows where Secrets exist.",
          "The Event says `MountVolume.SetUp failed for volume \"db\" : secret \"payments-db\" not found`. The Secret exists, but in `default`, and the Pods run in `payments`.",
          "Create a Secret with the same name and the same `password` value in `payments`. To read the value from the original, `kubectl get secret payments-db -o yaml` shows it base64-encoded.",
        ],
        solution: { commands: [`kubectl create secret generic payments-db -n payments --from-literal=password=${PAYMENTS_DB_PASSWORD}`] },
      },
      {
        title: "frontend reaches payments-api",
        body: "`http://payments-api.payments` answers from `frontend`: the Service sends traffic to both `payments-api` Pods, on the port nginx listens on.",
        check: (x) => endpointCount(x.cluster, "payments-api", "payments") === 2 && forwardsTo(x.cluster, "payments-api", "payments", 80, 80),
        hints: [
          "Once the Pods run, a request from `frontend` still fails. Look at what the failure says, then at how the Service connects to the Pods.",
          "`kubectl exec deploy/frontend -- wget -qO- --timeout=2 http://payments-api.payments` repeats the request. `kubectl describe svc payments-api -n payments` shows where the Service forwards.",
          "`Connection refused` means the request arrived and nothing was listening on that port. The Service forwards to `TargetPort: 8080/TCP`, and the Pods' container port is `80/TCP`, where nginx listens.",
          "Change the Service's `targetPort` to the port nginx listens on. The Service's own port can stay as it is.",
        ],
        solution: { commands: [`kubectl patch service payments-api -n payments --type=json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":80}]'`] },
      },
    ],
  },
  {
    slug: "audit-cleanup",
    start: ["kubectl get all -n blog", "kubectl get rolebindings -A"],
    difficulty: "hard",
    track: "security",
    title: "After the security audit",
    summary: "Deploys are Forbidden, a Service refuses connections and a Pod never starts.",
    brief:
      "**Pager: blog down since Friday's audit cleanup.** Since then:\n\n- Deploys to `blog` fail with `deployments.apps \"blog\" is forbidden: User \"system:serviceaccount:ops:release-bot\" cannot patch resource \"deployments\" in API group \"apps\" in the namespace \"blog\"`. Deploys to `shop` still work.\n- `http://blog.blog` refuses connections, though both `blog` Pods are Running.\n- `comments` never starts.\n\nDon't undo the audit: no cluster-admin and nothing cluster-wide for `release-bot`, and the comments password stays in the Secret `blog-db`.",
    minutes: 12,
    concepts: ["RoleBinding", "roleRef", "ClusterRole", "Service selector", "secretKeyRef"],
    setup: (c) => {
      for (const n of ["ops", "blog", "shop"]) ns(c, n);
      c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "release-bot", namespace: "ops" } });
      c.create({ apiVersion: `${RBAC}/v1`, kind: "ClusterRole", metadata: { name: "release" }, rules: [{ apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list", "watch", "patch", "update"] }] } as never);
      const binding = (namespace: string, kind: "Role" | "ClusterRole") =>
        c.create({
          apiVersion: `${RBAC}/v1`,
          kind: "RoleBinding",
          metadata: { name: "release-bot", namespace },
          roleRef: { apiGroup: RBAC, kind, name: "release" },
          subjects: [{ kind: "ServiceAccount", name: "release-bot", namespace: "ops" }],
        } as never);
      binding("shop", "ClusterRole");
      binding("blog", "Role");
      workload(c, "shop", "shop", 1, { containers: [{ name: "shop", image: "nginx:1.27" }] });
      workload(c, "blog", "blog", 2, { containers: [{ name: "blog", image: "nginx:1.27", ports: [{ containerPort: 80 }] }] });
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "blog", namespace: "blog", labels: { app: "blog" } }, spec: { selector: { app: "blog", tier: "web" }, ports: [{ port: 80, targetPort: 80 }] } });
      c.create({ apiVersion: "v1", kind: "Secret", metadata: { name: "blog-db", namespace: "blog" }, type: "Opaque", data: { password: btoa("c0mments-db") } } as never);
      workload(c, "comments", "blog", 1, {
        containers: [
          {
            name: "comments",
            image: "busybox",
            command: ["sh", "-c", "while true; do echo comments: moderated queue; sleep 30; done"],
            env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "blog-db", key: "db-password" } } }],
          },
        ],
      });
    },
    warmupMs: 15_000,
    steps: [
      {
        title: "release-bot can deploy blog and shop, and no more",
        body: "`system:serviceaccount:ops:release-bot` may get and patch Deployments in `blog` and `shop`. It may not delete them, read Secrets, or touch Deployments in any other namespace.",
        check: (x) => {
          const c = x.cluster;
          const who = sa("ops", "release-bot");
          return (
            ["blog", "shop"].every((n) => can(c, who, "get", "deployments", n, "apps") && can(c, who, "patch", "deployments", n, "apps") && !can(c, who, "delete", "deployments", n, "apps") && !can(c, who, "get", "secrets", n)) &&
            !can(c, who, "patch", "deployments", "default", "apps") &&
            !can(c, who, "patch", "deployments", "ops", "apps")
          );
        },
        hints: [
          "Deploys to `blog` are refused, but the same bot deploys to `shop` fine. Compare the two namespaces side by side.",
          "`kubectl get rolebindings -A` lists both bindings. `kubectl get rolebinding release-bot -n blog -o yaml` and the same with `-n shop` show what each one refers to.",
          "In `shop` the binding refers to `ClusterRole/release`, and in `blog` to `Role/release`. `kubectl get role -n blog` finds no Role there, so the binding points at nothing and grants nothing.",
          "The RBAC docs say you can't change a binding's roleRef: remove the binding and create a replacement. Recreate the one in `blog` so it refers to the ClusterRole. A RoleBinding that refers to a ClusterRole still grants access only inside `blog`.",
        ],
        solution: { commands: ["kubectl delete rolebinding release-bot -n blog", "kubectl create rolebinding release-bot --clusterrole=release --serviceaccount=ops:release-bot -n blog"] },
      },
      {
        title: "blog serving behind its Service",
        body: "Both `blog` Pods are Ready and receive traffic from the `blog` Service.",
        check: (x) => readyCount(x.cluster, "blog", "blog") === 2 && endpointCount(x.cluster, "blog", "blog") === 2,
        hints: [
          "The `blog` Pods are healthy, yet nothing gets traffic. Look at what sits between a visitor and the Pods, and whether it lists any backends.",
          "`kubectl get endpoints -n blog` shows the backends. `kubectl describe svc blog -n blog` shows what the Service selects, and `kubectl get pods -n blog --show-labels` shows the Pods' labels.",
          "ENDPOINTS is `<none>`. The Service selects `app=blog,tier=web`, but the Pods only have `app=blog`. The cleanup removed the `tier` label, so no Pod matches both.",
          "Make the selector and the labels agree. Dropping the stale `tier` entry from the Service's selector is the smaller change.",
        ],
        solution: { commands: [`kubectl patch service blog -n blog -p '{"spec":{"selector":{"tier":null}}}'`] },
      },
      {
        title: "comments running, password from blog-db",
        body: "The `comments` Pod is Running and Ready, and `DB_PASSWORD` comes from the Secret `blog-db`, not a literal value or a ConfigMap.",
        check: (x) =>
          allPods(x.cluster, "comments", "blog", 1, (s) => {
            const env = s?.containers[0]?.env ?? [];
            const pw = env.filter((e) => e.name === "DB_PASSWORD");
            return pw.length === 1 && pw[0].value === undefined && pw[0].valueFrom?.secretKeyRef?.name === "blog-db";
          }),
        hints: [
          "The `comments` Pod hasn't started a container. Read the kubelet's last warning about it.",
          "`kubectl describe pods -n blog -l app=comments` shows the warning. `kubectl describe secret blog-db -n blog` lists the keys the Secret has.",
          "The warning says `couldn't find key db-password in Secret blog/blog-db`. The Secret has a key named `password`. The Deployment refers to the old key name.",
          "Change the key name in the Deployment's `secretKeyRef`. The value keeps coming from the Secret.",
        ],
        solution: { commands: [`kubectl patch deployment comments -n blog --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/env/0/valueFrom/secretKeyRef/key","value":"password"}]'`] },
      },
    ],
  },
];

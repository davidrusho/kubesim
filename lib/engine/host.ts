// The host behind each Node: its systemd services, the files kubeadm leaves on it (static-Pod
// manifests, the kubelet's config and unit) and a bounded journal per unit. ADR 0003.
// Paths follow kubeadm on Ubuntu 24.04; the text of the kubelet's journal lines follows
// docs/research/real-cluster-captures-control-plane.md (kind v1.37, in-node outputs).

import type { YAMLError } from "yaml";
import type { Cluster } from "./cluster";
import { SIM_EPOCH, fnv32a } from "./util";

export type ServiceName = "kubelet" | "containerd";
export type ServiceActive = "active" | "inactive" | "failed" | "activating";

export interface ServiceState {
  enabled: boolean;
  active: ServiceActive;
  /** Sim ms the current state began (systemctl's "since"). */
  since: number;
  /** Times it has been started again after the first start (systemd's restart counter). */
  restarts: number;
  /** Main PID of the current or last run. */
  pid: number;
  /** How long the last run lasted (systemctl's "Duration:"), once it has stopped. */
  duration?: number;
  /** Why the last start failed, and when systemd tries again. Present while `activating (auto-restart)`. */
  failure?: { status: string; retryAt: number };
  /** The ExecStart text of the loaded unit and the command line it expanded to, as of the last start. */
  execStart?: string;
  cmdline?: string;
  /** kubelet only: `staticPodPath` from the config.yaml it started with (the kubelet reads it once, at start). */
  staticPodPath?: string;
  /** Invocation ID shown by `systemctl status`. */
  invocation: string;
}

export interface HostFile {
  content: string;
  /** Unix permission bits, e.g. 0o600. */
  mode: number;
  mtime: number;
  /** Exists so a typo in a path can be detected, but its contents (keys, certificates) are not simulated. */
  opaque?: boolean;
}

export interface JournalLine {
  t: number;
  /** What follows `<Mon dd hh:mm:ss> <host> `: `kubelet[771]: I0101 …` or `systemd[1]: …`. */
  text: string;
}

/** What the kubelet last did with one manifest file. */
export interface StaticEntry {
  hash: string;
  /** `namespace/name` of the mirror Pod, once created. */
  pod?: string;
  /** The manifest did not parse: why, and when that was last written to the journal. */
  bad?: { err: string; loggedAt: number };
  /** A changed manifest's new mirror Pod is created at this time (the old one is deleted at once). */
  createAt?: number;
  /** The container state last written to the journal, so a state is logged once. */
  logged?: string;
}

export interface HostState {
  role: "control-plane" | "worker";
  services: Record<ServiceName, ServiceState>;
  /** Files by absolute path. Directories exist when a file lives under them (plus a few well-known ones). */
  files: Record<string, HostFile>;
  /** The unit and drop-in files as systemd last loaded them (daemon-reload): edits take effect only after a reload and a restart. */
  loaded: Record<string, string>;
  /** Journal lines per unit (`kubelet`, `containerd`), oldest first, bounded. */
  journal: Record<string, JournalLine[]>;
  /** The kubelet's static-Pod bookkeeping, by manifest path. */
  static: Record<string, StaticEntry>;
  /** Next process id to hand out, and a counter that makes klog's microseconds differ. */
  nextPid: number;
  seq: number;
}

export function nodeIp(index: number): string {
  return `172.18.0.${index + 2}`;
}

export const HOME_DIR = "/home/candidate";
export const MANIFEST_DIR = "/etc/kubernetes/manifests";
export const KUBELET_CONFIG = "/var/lib/kubelet/config.yaml";
export const KUBELET_ENV = "/var/lib/kubelet/kubeadm-flags.env";
export const KUBELET_UNIT = "/usr/lib/systemd/system/kubelet.service";
export const KUBELET_DROPIN = "/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf";
export const CONTAINERD_UNIT = "/usr/lib/systemd/system/containerd.service";
export const COMPONENTS = ["etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler"] as const;
export type Component = (typeof COMPONENTS)[number];
/** Journal lines kept per unit. */
export const JOURNAL_MAX = 300;
export const KUBELET_VERSION = "v1.37.0";

export const SYSTEM_IMAGES = {
  etcd: "registry.k8s.io/etcd:3.6.4-0",
  "kube-apiserver": "registry.k8s.io/kube-apiserver:v1.37.0",
  "kube-controller-manager": "registry.k8s.io/kube-controller-manager:v1.37.0",
  "kube-scheduler": "registry.k8s.io/kube-scheduler:v1.37.0",
  "kube-proxy": "registry.k8s.io/kube-proxy:v1.37.0",
  coredns: "registry.k8s.io/coredns/coredns:v1.12.1",
  "metrics-server": "registry.k8s.io/metrics-server/metrics-server:v0.8.0",
  "ingress-nginx": "registry.k8s.io/ingress-nginx/controller:v1.13.2",
  "local-path": "docker.io/kindest/local-path-provisioner:v20250516-5dbe5e3f",
};

// ---------------------------------------------------------------- paths

/** `/a//b/./c/../d/` → `/a/b/d`, and `/var/run/…` → `/run/…`. Relative input is returned as is. */
export function normPath(p: string): string {
  if (!p.startsWith("/")) return p;
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  // On Ubuntu /var/run is a symlink to /run: both spellings reach the same files.
  if (out[0] === "var" && out[1] === "run") out.splice(0, 2, "run");
  return "/" + out.join("/");
}

export const dirname = (p: string) => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")));
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Whether a path names something on the host (absolute, and not in the Learner's home directory, which holds the terminal's own files). */
export function isHostPath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  const n = normPath(p);
  return n !== HOME_DIR && !n.startsWith(HOME_DIR + "/");
}

const BASE_DIRS = ["/", "/etc", "/etc/kubernetes", "/etc/kubernetes/manifests", "/etc/kubernetes/pki", "/etc/containerd", "/etc/systemd", "/etc/systemd/system", "/usr", "/usr/bin", "/usr/lib", "/usr/lib/systemd", "/usr/lib/systemd/system", "/var", "/var/lib", "/var/lib/kubelet", "/var/lib/etcd", "/var/log", "/run", "/run/containerd", "/tmp", "/root", "/home", HOME_DIR, "/opt"];

export function hostDirs(host: HostState): Set<string> {
  const dirs = new Set(BASE_DIRS);
  for (const f of Object.keys(host.files)) for (let d = dirname(f); d !== "/" && !dirs.has(d); d = dirname(d)) dirs.add(d);
  return dirs;
}

export function isHostDir(host: HostState, p: string): boolean {
  return hostDirs(host).has(normPath(p));
}

/** Children of a directory: file and directory names with their kind. */
export function listHostDir(host: HostState, dir: string): { name: string; dir: boolean; file?: HostFile }[] {
  const d = normPath(dir);
  const prefix = d === "/" ? "/" : d + "/";
  const out = new Map<string, { name: string; dir: boolean; file?: HostFile }>();
  for (const [p, f] of Object.entries(host.files)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) out.set(rest, { name: rest, dir: false, file: f });
    else out.set(rest.slice(0, slash), { name: rest.slice(0, slash), dir: true });
  }
  for (const b of hostDirs(host)) if (dirname(b) === d && b !== d && !out.has(basename(b))) out.set(basename(b), { name: basename(b), dir: true });
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------- time formats

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** `Nov 09 01:44:13`, the stamp journalctl puts on each line. */
export function journalStamp(simMs: number): string {
  const d = new Date(SIM_EPOCH + simMs);
  return `${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

/** `Mon 2026-11-09 01:31:53 UTC`, as systemctl status writes "since". */
export function systemdStamp(simMs: number): string {
  const d = new Date(SIM_EPOCH + simMs);
  return `${DAY[d.getUTCDay()]} ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}

/** `Nov  9 01:31`, as ls -l writes a modification time. */
export function lsStamp(simMs: number): string {
  const d = new Date(SIM_EPOCH + simMs);
  return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** klog's `I1109 01:44:13.109177`. */
export function klogStamp(level: string, simMs: number, seq: number): string {
  const d = new Date(SIM_EPOCH + simMs);
  const micro = String(d.getUTCMilliseconds()).padStart(3, "0") + String(seq % 1000).padStart(3, "0");
  return `${level}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${micro}`;
}

/** systemd's "39s ago", "1min 5s ago", "3h 4min ago". */
export function sinceAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 1) return `${Math.max(0, Math.round(ms))}ms ago`;
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min${s % 60 ? ` ${s % 60}s` : ""} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}min` : ""} ago`;
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ""} ago`;
}

/** A stable hex string of `n` digits from some text. */
export function hexId(text: string, n: number): string {
  let out = "";
  for (let i = 0; out.length < n; i++) out += fnv32a(`${i}:${text}`).toString(16).padStart(8, "0");
  return out.slice(0, n);
}

// ---------------------------------------------------------------- YAML errors

/** Go's yaml error text for the mistakes a hand edit makes (`yaml: line 11: mapping values are not allowed in this context`); the JS parser words and places them differently. */
export function goYamlError(e: YAMLError): string {
  // A key split across lines is reported where the colon is, which is the end of the range the JS parser gives.
  const line = e.code === "MULTILINE_IMPLICIT_KEY" ? (e.linePos?.[1]?.line ?? e.linePos?.[0]?.line) : e.linePos?.[0]?.line;
  let msg = "mapping values are not allowed in this context";
  if (e.code === "MISSING_CHAR" || /flow collection|unexpected end/i.test(e.message)) msg = "did not find expected ',' or ']'";
  else if (e.code === "TAB_AS_INDENT" || /tab/i.test(e.message)) msg = "found character that cannot start any token";
  else if (e.code === "DUPLICATE_KEY") msg = "mapping key already defined";
  return `yaml: ${line ? `line ${line}: ` : ""}${msg}`;
}

// ---------------------------------------------------------------- journal

export function journalPush(host: HostState, unit: string, t: number, text: string): void {
  const ring = (host.journal[unit] ??= []);
  ring.push({ t, text });
  if (ring.length > JOURNAL_MAX) ring.splice(0, ring.length - JOURNAL_MAX);
}

/** A line systemd writes about the unit. */
export function systemdLog(cluster: Cluster, node: string, unit: ServiceName, msg: string): void {
  const host = cluster.state.hosts[node];
  if (host) journalPush(host, unit, cluster.now, `systemd[1]: ${msg}`);
}

/** A klog line from the kubelet (`level` I, W or E; `src` like `file.go:186]`). */
export function kubeletLog(cluster: Cluster, node: string, level: "I" | "W" | "E", src: string, msg: string): void {
  const host = cluster.state.hosts[node];
  if (!host) return;
  const pid = host.services.kubelet.pid;
  journalPush(host, "kubelet", cluster.now, `kubelet[${pid}]: ${klogStamp(level, cluster.now, host.seq++)} ${String(pid).padStart(7, " ")} ${src}] ${msg}`);
}

/** A klog line as a container writes it to its own log (PID 1). */
export function containerKlog(now: number, seq: number, level: "I" | "W" | "E", src: string, msg: string): string {
  return `${klogStamp(level, now, seq)} ${String(1).padStart(7, " ")} ${src}] ${msg}`;
}

// ---------------------------------------------------------------- files

export function hostWrite(host: HostState, path: string, content: string, now: number, mode = 0o644): void {
  const p = normPath(path);
  const prev = host.files[p];
  host.files[p] = { content, mode: prev?.mode ?? mode, mtime: now, ...(prev?.opaque ? { opaque: true } : {}) };
}

export const OPAQUE_NOTE = "# kubesim: this file exists but its contents are not simulated\n";

const opaque = (mode: number): HostFile => ({ content: OPAQUE_NOTE, mode, mtime: 0, opaque: true });

// ---------------------------------------------------------------- default contents

const KUBELET_SERVICE = `[Unit]
Description=kubelet: The Kubernetes Node Agent
Documentation=https://kubernetes.io/docs/
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=/usr/bin/kubelet
Restart=always
StartLimitInterval=0
RestartSec=10

[Install]
WantedBy=multi-user.target
`;

const KUBELET_10_KUBEADM = `# https://github.com/kubernetes/kubernetes/blob/ba8fcafaf8c502a454acd86b728c857932555315/build/debs/10-kubeadm.conf
# Note: This dropin only works with kubeadm and kubelet v1.11+
[Service]
Environment="KUBELET_KUBECONFIG_ARGS=--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
Environment="KUBELET_CONFIG_ARGS=--config=/var/lib/kubelet/config.yaml"
# This is a file that "kubeadm init" and "kubeadm join" generates at runtime, populating the KUBELET_KUBEADM_ARGS variable dynamically
EnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env
# This is a file that the user can use for overrides of the kubelet args as a last resort. Preferably, the user should use
# the .NodeRegistration.KubeletExtraArgs object in the configuration files instead. KUBELET_EXTRA_ARGS should be sourced from this file.
EnvironmentFile=-/etc/default/kubelet
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
`;

const CONTAINERD_SERVICE = `# Copyright The containerd Authors.
[Unit]
Description=containerd container runtime
Documentation=https://containerd.io
After=network.target dbus.service

[Service]
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/bin/containerd

Type=notify
Delegate=yes
KillMode=process
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

/** kubeadm's /var/lib/kubelet/config.yaml (v1.36) with the runtime endpoint the ADR names. */
export const KUBELET_CONFIG_YAML = `apiVersion: kubelet.config.k8s.io/v1beta1
authentication:
  anonymous:
    enabled: false
  webhook:
    cacheTTL: 0s
    enabled: true
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt
authorization:
  mode: Webhook
  webhook:
    cacheAuthorizedTTL: 0s
    cacheUnauthorizedTTL: 0s
cgroupDriver: systemd
clusterDNS:
- 10.96.0.10
clusterDomain: cluster.local
containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock
cpuManagerReconcilePeriod: 0s
crashLoopBackOff: {}
evictionPressureTransitionPeriod: 0s
fileCheckFrequency: 0s
healthzBindAddress: 127.0.0.1
healthzPort: 10248
httpCheckFrequency: 0s
imageMaximumGCAge: 0s
imageMinimumGCAge: 0s
kind: KubeletConfiguration
logging:
  flushFrequency: 0
  options:
    json:
      infoBufferSize: "0"
    text:
      infoBufferSize: "0"
  verbosity: 0
memorySwap: {}
nodeStatusReportFrequency: 0s
nodeStatusUpdateFrequency: 0s
rotateCertificates: true
runtimeRequestTimeout: 0s
shutdownGracePeriod: 0s
shutdownGracePeriodCriticalPods: 0s
staticPodPath: /etc/kubernetes/manifests
streamingConnectionIdleTimeout: 0s
syncFrequency: 0s
volumeStatsAggPeriod: 0s
`;

/** The four kubeadm static-Pod manifests, verbatim from a real kubeadm v1.36.6 control plane on Ubuntu 24.04 (docs/research/real-cluster-captures-kubeadm.md), with the node name, its IP and the image tag substituted. */
export function manifestFor(comp: Component, node: string, ip: string): string {
  const image = SYSTEM_IMAGES[comp];
  switch (comp) {
    case "etcd":
      return `apiVersion: v1
kind: Pod
metadata:
  annotations:
    kubeadm.kubernetes.io/etcd.advertise-client-urls: https://${ip}:2379
  labels:
    component: etcd
    tier: control-plane
  name: etcd
  namespace: kube-system
spec:
  containers:
  - command:
    - etcd
    - --advertise-client-urls=https://${ip}:2379
    - --cert-file=/etc/kubernetes/pki/etcd/server.crt
    - --client-cert-auth=true
    - --data-dir=/var/lib/etcd
    - --feature-gates=InitialCorruptCheck=true
    - --initial-advertise-peer-urls=https://${ip}:2380
    - --initial-cluster=${node}=https://${ip}:2380
    - --key-file=/etc/kubernetes/pki/etcd/server.key
    - --listen-client-urls=https://127.0.0.1:2379,https://${ip}:2379
    - --listen-metrics-urls=http://127.0.0.1:2381
    - --listen-peer-urls=https://${ip}:2380
    - --name=${node}
    - --peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt
    - --peer-client-cert-auth=true
    - --peer-key-file=/etc/kubernetes/pki/etcd/peer.key
    - --peer-trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
    - --snapshot-count=10000
    - --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
    - --watch-progress-notify-interval=5s
    image: ${image}
    imagePullPolicy: IfNotPresent
    livenessProbe:
      failureThreshold: 8
      httpGet:
        host: 127.0.0.1
        path: /livez
        port: probe-port
        scheme: HTTP
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 15
    name: etcd
    ports:
    - containerPort: 2381
      name: probe-port
      protocol: TCP
    readinessProbe:
      failureThreshold: 3
      httpGet:
        host: 127.0.0.1
        path: /readyz
        port: probe-port
        scheme: HTTP
      periodSeconds: 1
      timeoutSeconds: 15
    resources:
      requests:
        cpu: 100m
        memory: 100Mi
    startupProbe:
      failureThreshold: 24
      httpGet:
        host: 127.0.0.1
        path: /readyz
        port: probe-port
        scheme: HTTP
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 15
    volumeMounts:
    - mountPath: /var/lib/etcd
      name: etcd-data
    - mountPath: /etc/kubernetes/pki/etcd
      name: etcd-certs
  hostNetwork: true
  priority: 2000001000
  priorityClassName: system-node-critical
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  volumes:
  - hostPath:
      path: /etc/kubernetes/pki/etcd
      type: DirectoryOrCreate
    name: etcd-certs
  - hostPath:
      path: /var/lib/etcd
      type: DirectoryOrCreate
    name: etcd-data
status: {}
`;
    case "kube-apiserver":
      return `apiVersion: v1
kind: Pod
metadata:
  annotations:
    kubeadm.kubernetes.io/kube-apiserver.advertise-address.endpoint: ${ip}:6443
  labels:
    component: kube-apiserver
    tier: control-plane
  name: kube-apiserver
  namespace: kube-system
spec:
  containers:
  - command:
    - kube-apiserver
    - --advertise-address=${ip}
    - --allow-privileged=true
    - --authorization-mode=Node,RBAC
    - --client-ca-file=/etc/kubernetes/pki/ca.crt
    - --enable-admission-plugins=NodeRestriction
    - --enable-bootstrap-token-auth=true
    - --etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt
    - --etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt
    - --etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key
    - --etcd-servers=https://127.0.0.1:2379
    - --kubelet-client-certificate=/etc/kubernetes/pki/apiserver-kubelet-client.crt
    - --kubelet-client-key=/etc/kubernetes/pki/apiserver-kubelet-client.key
    - --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
    - --proxy-client-cert-file=/etc/kubernetes/pki/front-proxy-client.crt
    - --proxy-client-key-file=/etc/kubernetes/pki/front-proxy-client.key
    - --requestheader-allowed-names=front-proxy-client
    - --requestheader-client-ca-file=/etc/kubernetes/pki/front-proxy-ca.crt
    - --requestheader-extra-headers-prefix=X-Remote-Extra-
    - --requestheader-group-headers=X-Remote-Group
    - --requestheader-username-headers=X-Remote-User
    - --secure-port=6443
    - --service-account-issuer=https://kubernetes.default.svc.cluster.local
    - --service-account-key-file=/etc/kubernetes/pki/sa.pub
    - --service-account-signing-key-file=/etc/kubernetes/pki/sa.key
    - --service-cluster-ip-range=10.96.0.0/12
    - --tls-cert-file=/etc/kubernetes/pki/apiserver.crt
    - --tls-private-key-file=/etc/kubernetes/pki/apiserver.key
    image: ${image}
    imagePullPolicy: IfNotPresent
    livenessProbe:
      failureThreshold: 8
      httpGet:
        host: ${ip}
        path: /livez
        port: probe-port
        scheme: HTTPS
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 15
    name: kube-apiserver
    ports:
    - containerPort: 6443
      name: probe-port
      protocol: TCP
    readinessProbe:
      failureThreshold: 3
      httpGet:
        host: ${ip}
        path: /readyz
        port: probe-port
        scheme: HTTPS
      periodSeconds: 1
      timeoutSeconds: 15
    resources:
      requests:
        cpu: 250m
    startupProbe:
      failureThreshold: 24
      httpGet:
        host: ${ip}
        path: /livez
        port: probe-port
        scheme: HTTPS
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 15
    volumeMounts:
    - mountPath: /etc/ssl/certs
      name: ca-certs
      readOnly: true
    - mountPath: /etc/ca-certificates
      name: etc-ca-certificates
      readOnly: true
    - mountPath: /etc/kubernetes/pki
      name: k8s-certs
      readOnly: true
    - mountPath: /usr/local/share/ca-certificates
      name: usr-local-share-ca-certificates
      readOnly: true
    - mountPath: /usr/share/ca-certificates
      name: usr-share-ca-certificates
      readOnly: true
  hostNetwork: true
  priority: 2000001000
  priorityClassName: system-node-critical
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  volumes:
  - hostPath:
      path: /etc/ssl/certs
      type: DirectoryOrCreate
    name: ca-certs
  - hostPath:
      path: /etc/ca-certificates
      type: DirectoryOrCreate
    name: etc-ca-certificates
  - hostPath:
      path: /etc/kubernetes/pki
      type: DirectoryOrCreate
    name: k8s-certs
  - hostPath:
      path: /usr/local/share/ca-certificates
      type: DirectoryOrCreate
    name: usr-local-share-ca-certificates
  - hostPath:
      path: /usr/share/ca-certificates
      type: DirectoryOrCreate
    name: usr-share-ca-certificates
status: {}
`;
    case "kube-controller-manager":
      return `apiVersion: v1
kind: Pod
metadata:
  labels:
    component: kube-controller-manager
    tier: control-plane
  name: kube-controller-manager
  namespace: kube-system
spec:
  containers:
  - command:
    - kube-controller-manager
    - --allocate-node-cidrs=true
    - --authentication-kubeconfig=/etc/kubernetes/controller-manager.conf
    - --authorization-kubeconfig=/etc/kubernetes/controller-manager.conf
    - --bind-address=127.0.0.1
    - --client-ca-file=/etc/kubernetes/pki/ca.crt
    - --cluster-cidr=10.244.0.0/16
    - --cluster-name=kubernetes
    - --cluster-signing-cert-file=/etc/kubernetes/pki/ca.crt
    - --cluster-signing-key-file=/etc/kubernetes/pki/ca.key
    - --controllers=*,bootstrapsigner,tokencleaner
    - --kubeconfig=/etc/kubernetes/controller-manager.conf
    - --leader-elect=true
    - --requestheader-client-ca-file=/etc/kubernetes/pki/front-proxy-ca.crt
    - --root-ca-file=/etc/kubernetes/pki/ca.crt
    - --service-account-private-key-file=/etc/kubernetes/pki/sa.key
    - --service-cluster-ip-range=10.96.0.0/12
    - --use-service-account-credentials=true
    image: ${image}
    imagePullPolicy: IfNotPresent
    livenessProbe:
      failureThreshold: 8
      httpGet:
        host: 127.0.0.1
        path: /healthz
        port: probe-port
        scheme: HTTPS
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 15
    name: kube-controller-manager
    ports:
    - containerPort: 10257
      name: probe-port
      protocol: TCP
    resources:
      requests:
        cpu: 200m
    startupProbe:
      failureThreshold: 24
      httpGet:
        host: 127.0.0.1
        path: /healthz
        port: probe-port
        scheme: HTTPS
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 15
    volumeMounts:
    - mountPath: /etc/ssl/certs
      name: ca-certs
      readOnly: true
    - mountPath: /etc/ca-certificates
      name: etc-ca-certificates
      readOnly: true
    - mountPath: /etc/kubernetes/pki
      name: k8s-certs
      readOnly: true
    - mountPath: /etc/kubernetes/controller-manager.conf
      name: kubeconfig
      readOnly: true
    - mountPath: /usr/local/share/ca-certificates
      name: usr-local-share-ca-certificates
      readOnly: true
    - mountPath: /usr/share/ca-certificates
      name: usr-share-ca-certificates
      readOnly: true
  hostNetwork: true
  priority: 2000001000
  priorityClassName: system-node-critical
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  volumes:
  - hostPath:
      path: /etc/ssl/certs
      type: DirectoryOrCreate
    name: ca-certs
  - hostPath:
      path: /etc/ca-certificates
      type: DirectoryOrCreate
    name: etc-ca-certificates
  - hostPath:
      path: /etc/kubernetes/pki
      type: DirectoryOrCreate
    name: k8s-certs
  - hostPath:
      path: /etc/kubernetes/controller-manager.conf
      type: FileOrCreate
    name: kubeconfig
  - hostPath:
      path: /usr/local/share/ca-certificates
      type: DirectoryOrCreate
    name: usr-local-share-ca-certificates
  - hostPath:
      path: /usr/share/ca-certificates
      type: DirectoryOrCreate
    name: usr-share-ca-certificates
status: {}
`;
    case "kube-scheduler":
      return `apiVersion: v1
kind: Pod
metadata:
  labels:
    component: kube-scheduler
    tier: control-plane
  name: kube-scheduler
  namespace: kube-system
spec:
  containers:
  - command:
    - kube-scheduler
    - --authentication-kubeconfig=/etc/kubernetes/scheduler.conf
    - --authorization-kubeconfig=/etc/kubernetes/scheduler.conf
    - --bind-address=127.0.0.1
    - --kubeconfig=/etc/kubernetes/scheduler.conf
    - --leader-elect=true
    image: ${image}
    imagePullPolicy: IfNotPresent
    livenessProbe:
      failureThreshold: 8
      httpGet:
        host: 127.0.0.1
        path: /livez
        port: probe-port
        scheme: HTTPS
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 15
    name: kube-scheduler
    ports:
    - containerPort: 10259
      name: probe-port
      protocol: TCP
    readinessProbe:
      failureThreshold: 3
      httpGet:
        host: 127.0.0.1
        path: /readyz
        port: probe-port
        scheme: HTTPS
      periodSeconds: 1
      timeoutSeconds: 15
    resources:
      requests:
        cpu: 100m
    startupProbe:
      failureThreshold: 24
      httpGet:
        host: 127.0.0.1
        path: /livez
        port: probe-port
        scheme: HTTPS
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 15
    volumeMounts:
    - mountPath: /etc/kubernetes/scheduler.conf
      name: kubeconfig
      readOnly: true
  hostNetwork: true
  priority: 2000001000
  priorityClassName: system-node-critical
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  volumes:
  - hostPath:
      path: /etc/kubernetes/scheduler.conf
      type: FileOrCreate
    name: kubeconfig
status: {}
`;
  }
}

function freshService(now: number, enabled = true): ServiceState {
  return { enabled, active: "active", since: now, restarts: 0, pid: 0, invocation: "", };
}

/** A Node's host as `kubeadm init` / `kubeadm join` leave it. `manifests` is false when the cluster has no system Pods. */
export function buildHost(cluster: Cluster, name: string, role: "control-plane" | "worker", index: number, manifests: boolean): HostState {
  const now = cluster.now;
  const ip = nodeIp(index);
  const files: Record<string, HostFile> = {};
  const text = (path: string, content: string, mode = 0o644) => void (files[path] = { content, mode, mtime: now });
  const hidden = (path: string, mode = 0o600) => void (files[path] = { ...opaque(mode), mtime: now });
  text(KUBELET_CONFIG, KUBELET_CONFIG_YAML);
  text(KUBELET_ENV, `KUBELET_KUBEADM_ARGS="--node-ip=${ip}"\n`);
  text(KUBELET_UNIT, KUBELET_SERVICE);
  text(KUBELET_DROPIN, KUBELET_10_KUBEADM);
  text(CONTAINERD_UNIT, CONTAINERD_SERVICE);
  hidden("/usr/bin/kubelet", 0o755);
  hidden("/usr/bin/containerd", 0o755);
  hidden("/usr/bin/crictl", 0o755);
  hidden("/run/containerd/containerd.sock", 0o660);
  hidden("/etc/kubernetes/kubelet.conf");
  hidden("/etc/kubernetes/pki/ca.crt", 0o644);
  if (role === "control-plane") {
    for (const f of ["admin.conf", "controller-manager.conf", "scheduler.conf", "super-admin.conf"]) hidden(`/etc/kubernetes/${f}`);
    for (const f of ["ca.crt", "apiserver.crt", "apiserver-etcd-client.crt", "apiserver-kubelet-client.crt", "front-proxy-ca.crt", "front-proxy-client.crt", "sa.pub"]) hidden(`/etc/kubernetes/pki/${f}`, 0o644);
    for (const f of ["ca.key", "apiserver.key", "apiserver-etcd-client.key", "apiserver-kubelet-client.key", "front-proxy-ca.key", "front-proxy-client.key", "sa.key"]) hidden(`/etc/kubernetes/pki/${f}`);
    for (const f of ["ca.crt", "server.crt", "peer.crt", "healthcheck-client.crt"]) hidden(`/etc/kubernetes/pki/etcd/${f}`, 0o644);
    for (const f of ["ca.key", "server.key", "peer.key", "healthcheck-client.key"]) hidden(`/etc/kubernetes/pki/etcd/${f}`);
    if (manifests) for (const comp of COMPONENTS) files[`${MANIFEST_DIR}/${comp}.yaml`] = { content: manifestFor(comp, name, ip), mode: 0o600, mtime: now };
  }
  const loaded: Record<string, string> = {};
  for (const p of unitPaths(files)) loaded[p] = files[p].content;
  const host: HostState = {
    role,
    services: { kubelet: freshService(now), containerd: freshService(now) },
    files,
    loaded,
    journal: { kubelet: [], containerd: [] },
    static: {},
    nextPid: 771,
    seq: 0,
  };
  for (const [unit, svc] of Object.entries(host.services)) {
    svc.pid = host.nextPid;
    host.nextPid += 13;
    svc.invocation = hexId(`${name}/${unit}/0`, 32);
  }
  return host;
}

/** The unit and drop-in files of the two modelled services. */
export function unitPaths(files: Record<string, HostFile>): string[] {
  return Object.keys(files).filter((p) => /^\/(usr\/lib|etc)\/systemd\/system\/(kubelet|containerd)\.service(\.d\/[^/]+\.conf)?$/.test(p));
}

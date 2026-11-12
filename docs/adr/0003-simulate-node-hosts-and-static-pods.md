# Simulate node hosts, node services and static Pods, so control-plane faults can be practised

The CKA's troubleshooting domain asks the Learner to `ssh` to a node and fix a stopped or misconfigured kubelet, a broken static-Pod manifest, or a control-plane component that is down. Today a Node is only an API object plus a power switch (`NodeRuntime.up`, `killNode`/`recoverNode` in `lib/engine/nodes.ts`). The control-plane Pods are ordinary API objects created once in `lib/engine/bootstrap.ts` with a `kubernetes.io/config.source: file` annotation, and no file exists behind them. We will give each Node a simulated **host**, with services, files and a journal, and derive the kubelet's health and the control-plane Pods from that host state.

The behaviour to reproduce is the verbatim capture in `docs/research/real-cluster-captures-control-plane.md`, taken from kind v1.37 on 2026-11-09. Paths follow kubeadm on Ubuntu 24.04, which is what the exam runs and what a two-VM kubeadm v1.36 practice cluster showed on 2026-11-11. That cluster puts the unit at `/usr/lib/systemd/system/kubelet.service` with the drop-in `kubelet.service.d/10-kubeadm.conf`, and `/var/lib/kubelet/config.yaml` has `staticPodPath: /etc/kubernetes/manifests` and `containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock`. kind's paths (`/etc/systemd/system/…`, `11-kind.conf`, `/run/containerd/…`) are not copied.

## Decisions

1. **A host per Node, in `ClusterState`.** Add `state.hosts[nodeName] = { services, files, journal }` beside `state.nodes`. It is persisted and restored like the rest of the state, and rebuilt on Start over. The Learner's own home files (`env.files`, flat names) stay separate; host files are keyed by absolute path.
   - `services`: `kubelet` and `containerd`, each `{ enabled, active: "active" | "inactive" | "failed" | "activating", since, restarts }`.
   - `files`: the four static-Pod manifests on the control plane, `/var/lib/kubelet/config.yaml`, the kubelet unit and its `10-kubeadm.conf` drop-in, and `/var/lib/kubelet/kubeadm-flags.env`. Each file records its content and mode. `/etc/kubernetes/pki/*` and the `*.conf` kubeconfigs exist by name only, so a typo in a path can be detected; their contents are never shown.
   - `journal`: a bounded ring of lines per unit, in the capture's format (`Nov 09 01:44:13 <host> kubelet[771]: E1109 … "msg" err=…`).

2. **Kubelet running is separate from Node power.** Add a derived "kubelet is posting" condition. The kubelet runs only when its service is active, `config.yaml` parses, and its `containerRuntimeEndpoint` names the containerd socket. Otherwise the service sits in `activating (auto-restart)` and writes the matching journal error. Heartbeats stop, and the existing node-lifecycle path does the rest: NotReady after the 50 s grace (capture: ~52 s), then eviction after 300 s. Unlike `killNode`, the containers keep running, so the Pod stays `1/1 Running` until eviction, as captured. Fixing the cause brings the Node back Ready within ~3 s.

3. **Static Pods come from the manifest files.** On the control-plane host, the kubelet re-reads `staticPodPath` every 5 s; the capture shows at most 10 s. Each file maps to a mirror Pod `<component>-<node>`, replacing the one-off Pods in `bootstrap.ts`.
   - YAML that does not parse: the mirror Pod disappears and no container exists (capture 3a).
   - An image tag the registry lacks: `ErrImagePull`, then `ImagePullBackOff` (3b).
   - A flag naming a missing file or an unknown flag: the container exits, and the Pod goes into `CrashLoopBackOff` with rising attempts (3c, 4c). Each component gets a small table of path-valued and port-valued flags to check against the host's files.
   - A manifest moved out of the directory: the mirror Pod is gone within 5 s (scenario 5).

4. **Each component's health gates the controllers it owns.** `Cluster.runControllers` gains a guard per component:
   - The scheduler gates `runScheduler`.
   - The controller-manager gates the ReplicaSet, Deployment, StatefulSet, DaemonSet, Job, CronJob, endpoints, EndpointSlice, node-lifecycle, HPA, disruption, quota, GC, ClusterRole aggregation, PersistentVolume binding and namespace-defaults (default ServiceAccount, `kube-root-ca.crt`) controllers, per the `--controllers` list in the kube-controller-manager reference.
   - When the API server is down, nothing reconciles: no controller can read or write.
   - The kubelet's container lifecycle keeps running whatever the API server's state, so existing containers stay up, as on a real node.
   - etcd counts as down only through the API server: a wrong `--etcd-servers` port makes the apiserver exit after ~20 s of retries (4a), and an etcd whose container crash-loops (a bad flag, a missing certificate or data directory) or whose manifest is gone takes the API down once it has been absent for that same ~20 s. The controller-manager and scheduler follow the API.

5. **The API server's health is one choke point in `runKubectl`.** While it is down, every `kubectl` call except `config` subcommands prints `The connection to the server controlplane:6443 was refused - did you specify the right host or port?` and fails. This is the in-node message from the capture, not kind's host-side `EOF`. A wrong `--secure-port` leaves the container Running and still refuses on 6443 (4b).

6. **The terminal gets a current host.** `ssh <node>` switches it, the prompt becomes `candidate@<node>:~$`, and `exit` returns. `sudo` and `sudo -i` are accepted, and `sudo -i` gives a `root@<node>:~#` prompt.
   - On a node host the shell adds `systemctl` (status, start, stop, restart, enable, disable, is-active, is-enabled, daemon-reload, cat), `journalctl -u <unit>` (with `-f`, `-n`, `--no-pager`) and `crictl` (ps, ps -a, pods, logs, inspect, images).
   - Absolute paths read and write host files, so `cat`, `ls`, `mv` and the nano/vi editor work on `/etc/kubernetes/manifests/…`.
   - `kubectl` works on the control plane through `/etc/kubernetes/admin.conf` and from the base terminal.
   - Unit-file edits take effect only after `daemon-reload` and a restart, as on a real host.

7. **Exam node names for practice.** Incidents that use hosts build their cluster with Nodes named `controlplane` and `node01`, through the existing `NodeConfig` names. The upstream default `control-plane`/`worker-1` stays for everything else.

8. **Timings come from the capture's summary table**, scaled only where the simulated clock already compresses time. Kubelet recovery and static-Pod pickup should feel the same as on the real cluster.

## Consequences

- Fidelity is bounded by what is modelled: no real systemd dependency graph, no cgroups, no certificate contents, and no etcd data. etcd snapshot and restore, and `kubeadm upgrade`, stay on the real-node drill (K8sQuest), not here.
- Every Incident that breaks a host must be checked against a capture scenario. A fault with no capture gets one before it gets an Incident, per `CONTRIBUTING.md`.
- The control-plane Pods change from created-once to derived. Existing tests that assert on them (names, annotation, owner) must keep passing, so the mirror Pod keeps the same name, labels and `config.source: file` annotation.
- The saved-state shape grows. Restoring an older save with no `hosts` builds default hosts instead of failing.

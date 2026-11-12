# Real-cluster captures: control-plane and kubelet failure scenarios

Captured 2026-11-09 from a throwaway kind cluster (`cka-capture`, 1 control-plane + 1 worker) on a lab host. All commands and outputs below are verbatim from the run; kubesim should reproduce them. Conventions:

- `[node]$ cmd` = run inside that kind node container (`docker exec <node> bash -c ...`), i.e. what a candidate would type after `ssh <node>`. `$ kubectl ...` = kubectl from the host with `--context kind-cka-capture` (the context flag is omitted from the display). `[exit N]` is the shell exit code of that command.
- `t+Ns` / "TIMER RESET" = seconds since the stated action (edit, stop, restore). Polls were every ~5 s, so timings are +-5 s unless a log timestamp is quoted.
- Lines over 300 characters are cut (marked `...[line cut]`, mostly kubelet journal lines). Blocks over 60 lines are trimmed to head+tail (head 36 / tail 14; the Scenario 0 baseline keeps up to 80) and marked `[... trimmed N lines ...]`.
- Kubelet journal output in this environment uses the format `Nov 09 01:44:13 <hostname> kubelet[771]: E1109 01:44:13.109177     771 file.go:186] "msg" err=...`.
- IMPORTANT caveat for apiserver-down output: kind publishes the apiserver on a random host port (here `127.0.0.1:39435`) through Docker's userland proxy, so kubectl run from the *host* shows `EOF` / `TLS handshake timeout` rather than the `connection refused` a real kubeadm node shows. The captures run **inside the control-plane container** with `/etc/kubernetes/admin.conf` give the kubeadm-realistic message (`The connection to the server cka-capture-control-plane:6443 was refused - did you specify the right host or port?`). Use the in-node ones for the exam-style simulator.

## Environment

| Item | Value |
|---|---|
| kind | v0.33.0 go1.26.7 linux/amd64 |
| Node image | `kindest/node:v1.37.0` (kind v0.33.0 default; from `kind create cluster` output: `Ensuring node image (kindest/node:v1.37.0)`) |
| Kubernetes | v1.37.0 (kubelet `Kubernetes v1.37.0`, nodes `VERSION v1.37.0`) |
| containerd | `containerd github.com/containerd/containerd/v2 v2.3.4` (`containerd://2.3.4`) |
| crictl | 1.36.0 |
| systemd | `systemd 257 (257.13-1~deb13u1)` |
| OS image | Debian GNU/Linux 13 (trixie), kernel 6.8.0-147-generic, cgroup v2 |
| Hostnames | `cka-capture-control-plane`, `cka-capture-worker` (`hostname` output equals the container/node name) |
| Node IPs | control-plane 172.18.0.4, worker 172.18.0.3; pod CIDR 10.244.0.0/16 (kindnet CNI) |
| Cluster create time | 38 s (`kind create cluster`); nodes Ready ~25-40 s after |

kind specifics worth knowing: kubelet is `/usr/bin/kubelet` run by `/etc/systemd/system/kubelet.service` with drop-ins `10-kubeadm.conf` and `11-kind.conf`; args come from `KUBELET_KUBECONFIG_ARGS`, `KUBELET_CONFIG_ARGS`, `KUBELET_KUBEADM_ARGS` (from `/var/lib/kubelet/kubeadm-flags.env`, here only `--node-ip=... --provider-id=... --node-labels=`) and `KUBELET_EXTRA_ARGS`. The container runtime endpoint is NOT in kubeadm-flags.env on this version; it is `containerRuntimeEndpoint: unix:///run/containerd/containerd.sock` in `/var/lib/kubelet/config.yaml`. kube-system static pod manifests live in `/etc/kubernetes/manifests` (etcd, kube-apiserver, kube-controller-manager, kube-scheduler; mode 0600 root).

## Scenario 0: healthy baseline

```
$ kind version; docker --version; docker images --format '{{.Repository}}:{{.Tag}}' | grep kindest
kind v0.33.0 go1.26.7 linux/amd64
Docker version 29.9.1, build dfc520d
kindest/node:<none>
[exit 0]
```

```
$ kubectl get nodes -o wide
NAME                        STATUS   ROLES           AGE   VERSION   INTERNAL-IP   EXTERNAL-IP   OS-IMAGE                       KERNEL-VERSION              CONTAINER-RUNTIME
cka-capture-control-plane   Ready    control-plane   42s   v1.37.0   172.18.0.4    <none>        Debian GNU/Linux 13 (trixie)   6.8.0-147-generic (amd64)   containerd://2.3.4
cka-capture-worker          Ready    <none>          29s   v1.37.0   172.18.0.3    <none>        Debian GNU/Linux 13 (trixie)   6.8.0-147-generic (amd64)   containerd://2.3.4
[exit 0]
```

```
$ kubectl get pods -n kube-system -o wide
NAME                                                READY   STATUS    RESTARTS   AGE   IP           NODE                        NOMINATED NODE   READINESS GATES
coredns-559f6c778d-5t9j5                            1/1     Running   0          33s   10.244.0.3   cka-capture-control-plane   <none>           <none>
coredns-559f6c778d-mkr68                            1/1     Running   0          33s   10.244.0.2   cka-capture-control-plane   <none>           <none>
etcd-cka-capture-control-plane                      1/1     Running   0          39s   172.18.0.4   cka-capture-control-plane   <none>           <none>
kindnet-psznp                                       1/1     Running   0          33s   172.18.0.4   cka-capture-control-plane   <none>           <none>
kindnet-qfzz2                                       1/1     Running   0          30s   172.18.0.3   cka-capture-worker          <none>           <none>
kube-apiserver-cka-capture-control-plane            1/1     Running   0          39s   172.18.0.4   cka-capture-control-plane   <none>           <none>
kube-controller-manager-cka-capture-control-plane   1/1     Running   0          39s   172.18.0.4   cka-capture-control-plane   <none>           <none>
kube-proxy-7v5f9                                    1/1     Running   0          30s   172.18.0.3   cka-capture-worker          <none>           <none>
kube-proxy-hjhpc                                    1/1     Running   0          33s   172.18.0.4   cka-capture-control-plane   <none>           <none>
kube-scheduler-cka-capture-control-plane            1/1     Running   0          39s   172.18.0.4   cka-capture-control-plane   <none>           <none>
[exit 0]
```

```
$ kubectl get pods -A
NAMESPACE            NAME                                                READY   STATUS    RESTARTS   AGE
kube-system          coredns-559f6c778d-5t9j5                            1/1     Running   0          33s
kube-system          coredns-559f6c778d-mkr68                            1/1     Running   0          33s
kube-system          etcd-cka-capture-control-plane                      1/1     Running   0          39s
kube-system          kindnet-psznp                                       1/1     Running   0          33s
kube-system          kindnet-qfzz2                                       1/1     Running   0          30s
kube-system          kube-apiserver-cka-capture-control-plane            1/1     Running   0          39s
kube-system          kube-controller-manager-cka-capture-control-plane   1/1     Running   0          39s
kube-system          kube-proxy-7v5f9                                    1/1     Running   0          30s
kube-system          kube-proxy-hjhpc                                    1/1     Running   0          33s
kube-system          kube-scheduler-cka-capture-control-plane            1/1     Running   0          39s
local-path-storage   local-path-provisioner-75f7fc7dc5-w7r8q             1/1     Running   0          33s
[exit 0]

=================== NODE cka-capture-control-plane
```

```
[cka-capture-control-plane]$ hostname
cka-capture-control-plane
[exit 0]
```

```
[cka-capture-control-plane]$ systemctl --version | head -2; containerd --version; kubelet --version; crictl --version; cat /etc/os-release | head -3
systemd 257 (257.13-1~deb13u1)
+PAM +AUDIT +SELINUX +APPARMOR +IMA +IPE +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBCRYPTSETUP_PLUGINS +LIBFDISK +PCRE2 +PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD +BPF_FRAMEWORK +BTF -XKBCOMMON -UTMP +SYSV ...[line cut]
containerd github.com/containerd/containerd/v2 v2.3.4 db8809540e1a7a9da5d518876894933ff55692ab
Kubernetes v1.37.0
crictl version 1.36.0
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
[exit 0]
```

```
[cka-capture-control-plane]$ systemctl status kubelet --no-pager
● kubelet.service - kubelet: The Kubernetes Node Agent
     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)
    Drop-In: /etc/systemd/system/kubelet.service.d
             └─10-kubeadm.conf, 11-kind.conf
     Active: active (running) since Mon 2026-11-09 01:31:53 UTC; 39s ago
 Invocation: 0cc6c2130c5b4f21a49339a3a464e812
       Docs: http://kubernetes.io/docs/
    Process: 760 ExecStartPre=/bin/sh -euc if [ -f /sys/fs/cgroup/cgroup.controllers ]; then /kind/bin/create-kubelet-cgroup-v2.sh; fi (code=exited, status=0/SUCCESS)
    Process: 769 ExecStartPre=/bin/sh -euc if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd/kubelet ]; then mkdir -p /sys/fs/cgroup/systemd/kubelet; fi (code=exited, status=0/SUCCESS)
   Main PID: 771 (kubelet)
      Tasks: 16 (limit: 2871)
     Memory: 35.2M (peak: 36.1M)
        CPU: 1.801s
     CGroup: /kubelet.slice/kubelet.service
             └─771 /usr/bin/kubelet --bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf --config=/var/lib/kubelet/config.yaml --node-ip=172.18.0.4 --provider-id=kind://docker/cka-capture/cka-capture-control-plane --node-labels= --runtime-cgroups=/s ...[line cut]

Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.244521     771 server.go:177] "Pod update broadcasted" podUID="df5b716e-88c8-4e89-b4e3-c9de8df1bd78" type="MODIFIED"
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.247990     771 server.go:177] "Pod update broadcasted" podUID="623aee12-1e72-4b56-b85d-0169d4cc18dd" type="MODIFIED"
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.268590     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/coredns-559f6c778d-mkr68" podStartSLOduration=16.268543265 podStartE2EDuration="16.268543265s" totalImagesPullingTime="0s" totalI ...[line cut]
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.277107     771 server.go:177] "Pod update broadcasted" podUID="00142cea-a4da-4466-bbb1-4aeb1e77dcee" type="MODIFIED"
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.295988     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="local-path-storage/local-path-provisioner-75f7fc7dc5-w7r8q" podStartSLOduration=16.295971673 podStartE2EDuration="16.295971673s" totalImagesP ...[line cut]
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.320421     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/coredns-559f6c778d-5t9j5" podStartSLOduration=16.320372385 podStartE2EDuration="16.320372385s" totalImagesPullingTime="0s" totalI ...[line cut]
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.395004     771 server.go:177] "Pod update broadcasted" podUID="df5b716e-88c8-4e89-b4e3-c9de8df1bd78" type="MODIFIED"
Nov 09 01:32:16 cka-capture-control-plane kubelet[771]: I1109 01:32:16.397631     771 server.go:177] "Pod update broadcasted" podUID="00142cea-a4da-4466-bbb1-4aeb1e77dcee" type="MODIFIED"
Nov 09 01:32:17 cka-capture-control-plane kubelet[771]: I1109 01:32:17.399548     771 server.go:177] "Pod update broadcasted" podUID="df5b716e-88c8-4e89-b4e3-c9de8df1bd78" type="MODIFIED"
Nov 09 01:32:17 cka-capture-control-plane kubelet[771]: I1109 01:32:17.399837     771 server.go:177] "Pod update broadcasted" podUID="00142cea-a4da-4466-bbb1-4aeb1e77dcee" type="MODIFIED"
[exit 0]
```

```
[cka-capture-control-plane]$ systemctl is-active kubelet
active
[exit 0]
```

```
[cka-capture-control-plane]$ systemctl is-enabled kubelet
enabled
[exit 0]
```

```
[cka-capture-control-plane]$ crictl ps
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
7b414e7643640       520212b8b0fcd       17 seconds ago      Running             coredns                   0                   03420494c4b95       coredns-559f6c778d-5t9j5                            kube-system
c9cbda2b6a530       c82008e2cd018       17 seconds ago      Running             local-path-provisioner    0                   73e478be78556       local-path-provisioner-75f7fc7dc5-w7r8q             local-path-storage
178ef52069b39       520212b8b0fcd       17 seconds ago      Running             coredns                   0                   c0ddcdb8bf610       coredns-559f6c778d-mkr68                            kube-system
71339b762b77e       4626fe10df5b9       31 seconds ago      Running             kindnet-cni               0                   847cfd8a19ee6       kindnet-psznp                                       kube-system
575668e8ff7dd       d6a28daf3e6b0       32 seconds ago      Running             kube-proxy                0                   31b99c15fcc3c       kube-proxy-hjhpc                                    kube-system
9c67053dea619       270fbeb697171       48 seconds ago      Running             etcd                      0                   b69851da3fb0e       etcd-cka-capture-control-plane                      kube-system
1f0aaa904beda       364b3c3d9ec19       48 seconds ago      Running             kube-controller-manager   0                   b4a3160ec9c60       kube-controller-manager-cka-capture-control-plane   kube-system
8b398fa0c15a7       bec5f0e1e2eeb       48 seconds ago      Running             kube-apiserver            0                   a389b81895bb1       kube-apiserver-cka-capture-control-plane            kube-system
c6f4ccdfdba3d       1fabf80a1273a       48 seconds ago      Running             kube-scheduler            0                   6a46346560f12       kube-scheduler-cka-capture-control-plane            kube-system
[exit 0]
```

```
[cka-capture-control-plane]$ crictl ps -a
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
7b414e7643640       520212b8b0fcd       17 seconds ago      Running             coredns                   0                   03420494c4b95       coredns-559f6c778d-5t9j5                            kube-system
c9cbda2b6a530       c82008e2cd018       17 seconds ago      Running             local-path-provisioner    0                   73e478be78556       local-path-provisioner-75f7fc7dc5-w7r8q             local-path-storage
178ef52069b39       520212b8b0fcd       17 seconds ago      Running             coredns                   0                   c0ddcdb8bf610       coredns-559f6c778d-mkr68                            kube-system
71339b762b77e       4626fe10df5b9       31 seconds ago      Running             kindnet-cni               0                   847cfd8a19ee6       kindnet-psznp                                       kube-system
575668e8ff7dd       d6a28daf3e6b0       32 seconds ago      Running             kube-proxy                0                   31b99c15fcc3c       kube-proxy-hjhpc                                    kube-system
9c67053dea619       270fbeb697171       48 seconds ago      Running             etcd                      0                   b69851da3fb0e       etcd-cka-capture-control-plane                      kube-system
1f0aaa904beda       364b3c3d9ec19       48 seconds ago      Running             kube-controller-manager   0                   b4a3160ec9c60       kube-controller-manager-cka-capture-control-plane   kube-system
8b398fa0c15a7       bec5f0e1e2eeb       48 seconds ago      Running             kube-apiserver            0                   a389b81895bb1       kube-apiserver-cka-capture-control-plane            kube-system
c6f4ccdfdba3d       1fabf80a1273a       48 seconds ago      Running             kube-scheduler            0                   6a46346560f12       kube-scheduler-cka-capture-control-plane            kube-system
[exit 0]
```

```
[cka-capture-control-plane]$ ls -l /etc/kubernetes/manifests
total 16
-rw------- 1 root root 2618 Nov  9 01:31 etcd.yaml
-rw------- 1 root root 3968 Nov  9 01:31 kube-apiserver.yaml
-rw------- 1 root root 3271 Nov  9 01:31 kube-controller-manager.yaml
-rw------- 1 root root 1726 Nov  9 01:31 kube-scheduler.yaml
[exit 0]
```

```
[cka-capture-control-plane]$ journalctl -u kubelet --no-pager -n 20
Nov 09 01:32:11 cka-capture-control-plane kubelet[771]: I1109 01:32:11.988451     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"config-volume\" (UniqueName: \"kubernetes.io/configmap/df5b716e-88c8-4e89-b4e3-c9de8df1bd78-config-volume\") pod \"co ...[line cut]
Nov 09 01:32:11 cka-capture-control-plane kubelet[771]: I1109 01:32:11.988476     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kube-api-access-77gdv\" (UniqueName: \"kubernetes.io/projected/623aee12-1e72-4b56-b85d-0169d4cc18dd-kube-api-access-7 ...[line cut]
Nov 09 01:32:11 cka-capture-control-plane kubelet[771]: I1109 01:32:11.988496     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"config-volume\" (UniqueName: \"kubernetes.io/configmap/00142cea-a4da-4466-bbb1-4aeb1e77dcee-config-volume\") pod \"co ...[line cut]
Nov 09 01:32:11 cka-capture-control-plane kubelet[771]: I1109 01:32:11.988699     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kube-api-access-n67wl\" (UniqueName: \"kubernetes.io/projected/df5b716e-88c8-4e89-b4e3-c9de8df1bd78-kube-api-access-n ...[line cut]
Nov 09 01:32:11 cka-capture-control-plane kubelet[771]: I1109 01:32:11.988786     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"config-volume\" (UniqueName: \"kubernetes.io/configmap/623aee12-1e72-4b56-b85d-0169d4cc18dd-config-volume\") pod \"lo ...[line cut]
Nov 09 01:32:12 cka-capture-control-plane kubelet[771]: I1109 01:32:12.735569     771 server.go:177] "Pod update broadcasted" podUID="df5b716e-88c8-4e89-b4e3-c9de8df1bd78" type="MODIFIED"
Nov 09 01:32:12 cka-capture-control-plane kubelet[771]: I1109 01:32:12.744448     771 server.go:177] "Pod update broadcasted" podUID="00142cea-a4da-4466-bbb1-4aeb1e77dcee" type="MODIFIED"
Nov 09 01:32:12 cka-capture-control-plane kubelet[771]: I1109 01:32:12.750171     771 server.go:177] "Pod update broadcasted" podUID="623aee12-1e72-4b56-b85d-0169d4cc18dd" type="MODIFIED"
Nov 09 01:32:13 cka-capture-control-plane kubelet[771]: I1109 01:32:13.354477     771 server.go:177] "Pod update broadcasted" podUID="c1efb01d4dca3d2abf2573fb39dba4f5" type="MODIFIED"
Nov 09 01:32:13 cka-capture-control-plane kubelet[771]: I1109 01:32:13.354776     771 server.go:177] "Pod update broadcasted" podUID="c1efb01d4dca3d2abf2573fb39dba4f5" type="MODIFIED"
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.244521     771 server.go:177] "Pod update broadcasted" podUID="df5b716e-88c8-4e89-b4e3-c9de8df1bd78" type="MODIFIED"
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.247990     771 server.go:177] "Pod update broadcasted" podUID="623aee12-1e72-4b56-b85d-0169d4cc18dd" type="MODIFIED"
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.268590     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/coredns-559f6c778d-mkr68" podStartSLOduration=16.268543265 podStartE2EDuration="16.268543265s" totalImagesPullingTime="0s" totalI ...[line cut]
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.277107     771 server.go:177] "Pod update broadcasted" podUID="00142cea-a4da-4466-bbb1-4aeb1e77dcee" type="MODIFIED"
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.295988     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="local-path-storage/local-path-provisioner-75f7fc7dc5-w7r8q" podStartSLOduration=16.295971673 podStartE2EDuration="16.295971673s" totalImagesP ...[line cut]
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.320421     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/coredns-559f6c778d-5t9j5" podStartSLOduration=16.320372385 podStartE2EDuration="16.320372385s" totalImagesPullingTime="0s" totalI ...[line cut]
Nov 09 01:32:15 cka-capture-control-plane kubelet[771]: I1109 01:32:15.395004     771 server.go:177] "Pod update broadcasted" podUID="df5b716e-88c8-4e89-b4e3-c9de8df1bd78" type="MODIFIED"
Nov 09 01:32:16 cka-capture-control-plane kubelet[771]: I1109 01:32:16.397631     771 server.go:177] "Pod update broadcasted" podUID="00142cea-a4da-4466-bbb1-4aeb1e77dcee" type="MODIFIED"
Nov 09 01:32:17 cka-capture-control-plane kubelet[771]: I1109 01:32:17.399548     771 server.go:177] "Pod update broadcasted" podUID="df5b716e-88c8-4e89-b4e3-c9de8df1bd78" type="MODIFIED"
Nov 09 01:32:17 cka-capture-control-plane kubelet[771]: I1109 01:32:17.399837     771 server.go:177] "Pod update broadcasted" podUID="00142cea-a4da-4466-bbb1-4aeb1e77dcee" type="MODIFIED"
[exit 0]
```

```
[cka-capture-control-plane]$ cat /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
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
cgroupRoot: /kubelet
clusterDNS:
- 10.96.0.10
clusterDomain: cluster.local
containerRuntimeEndpoint: unix:///run/containerd/containerd.sock
cpuManagerReconcilePeriod: 0s
crashLoopBackOff: {}
evictionHard:
  imagefs.available: 0%
  nodefs.available: 0%
  nodefs.inodesFree: 0%
evictionPressureTransitionPeriod: 0s
failSwapOn: false
fileCheckFrequency: 0s
healthzBindAddress: 127.0.0.1
healthzPort: 10248
httpCheckFrequency: 0s
imageGCHighThresholdPercent: 100
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
[exit 0]
```

```
[cka-capture-control-plane]$ sed -E 's/(data|client-key-data|client-certificate-data|token|certificate-authority-data): .*/\1: <redacted>/' /etc/kubernetes/kubelet.conf
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: <redacted>
    server: https://172.18.0.4:6443
  name: cka-capture
contexts:
- context:
    cluster: cka-capture
    user: system:node:cka-capture-control-plane
  name: system:node:cka-capture-control-plane@cka-capture
current-context: system:node:cka-capture-control-plane@cka-capture
kind: Config
users:
- name: system:node:cka-capture-control-plane
  user:
    client-certificate: /var/lib/kubelet/pki/kubelet-client-current.pem
    client-key: /var/lib/kubelet/pki/kubelet-client-current.pem
[exit 0]
```

```
[cka-capture-control-plane]$ ls -l /var/lib/kubelet /etc/kubernetes /etc/systemd/system/kubelet.service.d; cat /etc/systemd/system/kubelet.service.d/*.conf; cat /var/lib/kubelet/kubeadm-flags.env
/etc/kubernetes:
total 44
-rw------- 1 root root 5653 Nov  9 01:31 admin.conf
-rw------- 1 root root 5662 Nov  9 01:31 controller-manager.conf
-rw------- 1 root root 2030 Nov  9 01:31 kubelet.conf
drwxr-xr-x 1 root root 4096 Nov  9 01:31 manifests
drwxr-xr-x 3 root root 4096 Nov  9 01:31 pki
-rw------- 1 root root 5610 Nov  9 01:31 scheduler.conf
-rw------- 1 root root 5677 Nov  9 01:31 super-admin.conf

/etc/systemd/system/kubelet.service.d:
total 8
-rw-r--r-- 1 root root 1014 Aug 20 11:23 10-kubeadm.conf
-rw-r--r-- 1 root root  791 Aug 20 11:23 11-kind.conf

/var/lib/kubelet:
total 68
-rw-------  1 root root 1707 Nov  9 01:32 actuated_pods_state
-rw-------  1 root root 1707 Nov  9 01:32 allocated_pods_state
drwx------  2 root root 4096 Nov  9 01:31 checkpoints
-rw-r--r--  1 root root 1271 Nov  9 01:31 config.yaml
-rw-------  1 root root  146 Nov  9 01:31 cpu_manager_state
drwxr-xr-x  2 root root 4096 Nov  9 01:31 device-plugins
-rw-------  1 root root  139 Nov  9 01:32 dra_manager_state
drwx------  4 root root 4096 Nov  9 01:31 image_manager
-rw-r--r--  1 root root   67 Nov  9 01:31 instance-config.yaml
-rw-r--r--  1 root root  125 Nov  9 01:31 kubeadm-flags.env
-rw-------  1 root root  142 Nov  9 01:31 memory_manager_state
drwxr-xr-x  2 root root 4096 Nov  9 01:31 pki
drwxr-x---  2 root root 4096 Nov  9 01:31 plugins
drwxr-x---  2 root root 4096 Nov  9 01:31 plugins_registry
drwxr-x---  2 root root 4096 Nov  9 01:31 pod-resources
drwxr-x--- 11 root root 4096 Nov  9 01:32 pods
drwxr-x---  2 root root 4096 Nov  9 01:31 pods-api
# https://github.com/kubernetes/kubernetes/blob/ba8fcafaf8c502a454acd86b728c857932555315/build/debs/10-kubeadm.conf
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
# kind specific additions go in this file
[Service]
# On cgroup v1, the /kubelet cgroup is created in the entrypoint script before running systemd.
# On cgroup v2, the /kubelet cgroup is created here. (See the comments in the entrypoint script for the reason.)
ExecStartPre=/bin/sh -euc "if [ -f /sys/fs/cgroup/cgroup.controllers ]; then /kind/bin/create-kubelet-cgroup-v2.sh; fi"
# on WSL2 (and potentially other distros without systemd) /sys/fs/cgroup/systemd is created after the entrypoint, during /sbin/init.
# This eventually leads to kubelet failing to start, see: https://github.com/kubernetes-sigs/kind/issues/2323
ExecStartPre=/bin/sh -euc "if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd/kubelet ]; then mkdir -p /sys/fs/cgroup/systemd/kubelet; fi"
KUBELET_KUBEADM_ARGS="--node-ip=172.18.0.4 --provider-id=kind://docker/cka-capture/cka-capture-control-plane --node-labels="
[exit 0]

=================== NODE cka-capture-worker
```

```
[cka-capture-worker]$ hostname
cka-capture-worker
[exit 0]
```

```
[cka-capture-worker]$ systemctl --version | head -2; containerd --version; kubelet --version; crictl --version; cat /etc/os-release | head -3
systemd 257 (257.13-1~deb13u1)
+PAM +AUDIT +SELINUX +APPARMOR +IMA +IPE +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBCRYPTSETUP_PLUGINS +LIBFDISK +PCRE2 +PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD +BPF_FRAMEWORK +BTF -XKBCOMMON -UTMP +SYSV ...[line cut]
containerd github.com/containerd/containerd/v2 v2.3.4 db8809540e1a7a9da5d518876894933ff55692ab
Kubernetes v1.37.0
crictl version 1.36.0
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
[exit 0]
```

```
[cka-capture-worker]$ systemctl status kubelet --no-pager
● kubelet.service - kubelet: The Kubernetes Node Agent
     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)
    Drop-In: /etc/systemd/system/kubelet.service.d
             └─10-kubeadm.conf, 11-kind.conf
     Active: active (running) since Mon 2026-11-09 01:32:02 UTC; 31s ago
 Invocation: bc77622afb8f43bca429460fc6824c16
       Docs: http://kubernetes.io/docs/
    Process: 238 ExecStartPre=/bin/sh -euc if [ -f /sys/fs/cgroup/cgroup.controllers ]; then /kind/bin/create-kubelet-cgroup-v2.sh; fi (code=exited, status=0/SUCCESS)
    Process: 247 ExecStartPre=/bin/sh -euc if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd/kubelet ]; then mkdir -p /sys/fs/cgroup/systemd/kubelet; fi (code=exited, status=0/SUCCESS)
   Main PID: 249 (kubelet)
      Tasks: 15 (limit: 2871)
     Memory: 27.5M (peak: 28.8M)
        CPU: 1.140s
     CGroup: /kubelet.slice/kubelet.service
             └─249 /usr/bin/kubelet --bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf --config=/var/lib/kubelet/config.yaml --node-ip=172.18.0.3 --provider-id=kind://docker/cka-capture/cka-capture-worker --node-labels= --runtime-cgroups=/system.s ...[line cut]

Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406708     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kube-api-access-5sr5d\" (UniqueName: \"kubernetes.io/projected/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-kube-api-access-5sr5d\") ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406777     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"lib-modules\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-lib-modules\") pod \"kindnet-qfzz2 ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406801     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kube-proxy\" (UniqueName: \"kubernetes.io/configmap/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-kube-proxy\") pod \"kube-proxy-7v5f ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406827     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"lib-modules\" (UniqueName: \"kubernetes.io/host-path/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-lib-modules\") pod \"kube-proxy-7v ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.925907     249 server.go:177] "Pod update broadcasted" podUID="8fb4b09f-2dfe-4ca8-adbd-54babf282aac" type="MODIFIED"
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.950244     249 server.go:177] "Pod update broadcasted" podUID="6911fb0b-a4c0-4f56-b1dc-584be9ab6126" type="MODIFIED"
Nov 09 01:32:06 cka-capture-worker kubelet[249]: I1109 01:32:06.305518     249 server.go:177] "Pod update broadcasted" podUID="8fb4b09f-2dfe-4ca8-adbd-54babf282aac" type="MODIFIED"
Nov 09 01:32:06 cka-capture-worker kubelet[249]: I1109 01:32:06.321623     249 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/kube-proxy-7v5f9" podStartSLOduration=4.321604744 podStartE2EDuration="4.321604744s" totalImagesPullingTime="0s" totalInitContainerRunti ...[line cut]
Nov 09 01:32:06 cka-capture-worker kubelet[249]: I1109 01:32:06.864172     249 server.go:177] "Pod update broadcasted" podUID="6911fb0b-a4c0-4f56-b1dc-584be9ab6126" type="MODIFIED"
Nov 09 01:32:16 cka-capture-worker kubelet[249]: I1109 01:32:16.986270     249 kubelet_node_status.go:431] "Fast updating node status as it just became ready"
[exit 0]
```

```
[cka-capture-worker]$ systemctl is-active kubelet
active
[exit 0]
```

```
[cka-capture-worker]$ systemctl is-enabled kubelet
enabled
[exit 0]
```

```
[cka-capture-worker]$ crictl ps
CONTAINER           IMAGE               CREATED             STATE               NAME                ATTEMPT             POD ID              POD                 NAMESPACE
946494ed7c648       4626fe10df5b9       26 seconds ago      Running             kindnet-cni         0                   4f821ea8bead5       kindnet-qfzz2       kube-system
4a3423dfbe64a       d6a28daf3e6b0       27 seconds ago      Running             kube-proxy          0                   4404aeacf416f       kube-proxy-7v5f9    kube-system
[exit 0]
```

```
[cka-capture-worker]$ crictl ps -a
CONTAINER           IMAGE               CREATED             STATE               NAME                ATTEMPT             POD ID              POD                 NAMESPACE
946494ed7c648       4626fe10df5b9       26 seconds ago      Running             kindnet-cni         0                   4f821ea8bead5       kindnet-qfzz2       kube-system
4a3423dfbe64a       d6a28daf3e6b0       27 seconds ago      Running             kube-proxy          0                   4404aeacf416f       kube-proxy-7v5f9    kube-system
[exit 0]
```

```
[cka-capture-worker]$ ls -l /etc/kubernetes/manifests
total 0
[exit 0]
```

```
[cka-capture-worker]$ journalctl -u kubelet --no-pager -n 20
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.252788     249 reflector.go:664] "Warning: watch ended with error" reflector="k8s.io/client-go/informers/factory.go:178" type="*v1.RuntimeClass" err="very short watch: k8s.io/client-go/informers/factory.go:178: Unexpected watch close -  ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.287402     249 apiserver.go:51] "Watching apiserver"
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.373215     249 server.go:177] "Pod update broadcasted" podUID="6911fb0b-a4c0-4f56-b1dc-584be9ab6126" type="ADDED"
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.376087     249 server.go:177] "Pod update broadcasted" podUID="8fb4b09f-2dfe-4ca8-adbd-54babf282aac" type="ADDED"
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.399873     249 desired_state_of_world_populator.go:154] "Finished populating initial desired state of world"
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406443     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"cni-cfg\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-cni-cfg\") pod \"kindnet-qfzz2\" (UID: ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406486     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"xtables-lock\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-xtables-lock\") pod \"kindnet-qfz ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406514     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"nri-plugin\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-nri-plugin\") pod \"kindnet-qfzz2\" ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406547     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kube-api-access-2hq6j\" (UniqueName: \"kubernetes.io/projected/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-kube-api-access-2hq6j\") ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406618     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"xtables-lock\" (UniqueName: \"kubernetes.io/host-path/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-xtables-lock\") pod \"kube-proxy- ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406708     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kube-api-access-5sr5d\" (UniqueName: \"kubernetes.io/projected/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-kube-api-access-5sr5d\") ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406777     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"lib-modules\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-lib-modules\") pod \"kindnet-qfzz2 ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406801     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kube-proxy\" (UniqueName: \"kubernetes.io/configmap/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-kube-proxy\") pod \"kube-proxy-7v5f ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.406827     249 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"lib-modules\" (UniqueName: \"kubernetes.io/host-path/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-lib-modules\") pod \"kube-proxy-7v ...[line cut]
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.925907     249 server.go:177] "Pod update broadcasted" podUID="8fb4b09f-2dfe-4ca8-adbd-54babf282aac" type="MODIFIED"
Nov 09 01:32:03 cka-capture-worker kubelet[249]: I1109 01:32:03.950244     249 server.go:177] "Pod update broadcasted" podUID="6911fb0b-a4c0-4f56-b1dc-584be9ab6126" type="MODIFIED"
Nov 09 01:32:06 cka-capture-worker kubelet[249]: I1109 01:32:06.305518     249 server.go:177] "Pod update broadcasted" podUID="8fb4b09f-2dfe-4ca8-adbd-54babf282aac" type="MODIFIED"
Nov 09 01:32:06 cka-capture-worker kubelet[249]: I1109 01:32:06.321623     249 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/kube-proxy-7v5f9" podStartSLOduration=4.321604744 podStartE2EDuration="4.321604744s" totalImagesPullingTime="0s" totalInitContainerRunti ...[line cut]
Nov 09 01:32:06 cka-capture-worker kubelet[249]: I1109 01:32:06.864172     249 server.go:177] "Pod update broadcasted" podUID="6911fb0b-a4c0-4f56-b1dc-584be9ab6126" type="MODIFIED"
Nov 09 01:32:16 cka-capture-worker kubelet[249]: I1109 01:32:16.986270     249 kubelet_node_status.go:431] "Fast updating node status as it just became ready"
[exit 0]
```

```
[cka-capture-worker]$ cat /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
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
cgroupRoot: /kubelet
clusterDNS:
- 10.96.0.10
clusterDomain: cluster.local
containerRuntimeEndpoint: unix:///run/containerd/containerd.sock
cpuManagerReconcilePeriod: 0s
crashLoopBackOff: {}
evictionHard:
  imagefs.available: 0%
  nodefs.available: 0%
  nodefs.inodesFree: 0%
evictionPressureTransitionPeriod: 0s
failSwapOn: false
fileCheckFrequency: 0s
healthzBindAddress: 127.0.0.1
healthzPort: 10248
httpCheckFrequency: 0s
imageGCHighThresholdPercent: 100
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
[exit 0]
```

```
[cka-capture-worker]$ sed -E 's/(data|client-key-data|client-certificate-data|token|certificate-authority-data): .*/\1: <redacted>/' /etc/kubernetes/kubelet.conf
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: <redacted>
    server: https://cka-capture-control-plane:6443
  name: default-cluster
contexts:
- context:
    cluster: default-cluster
    namespace: default
    user: default-auth
  name: default-context
current-context: default-context
kind: Config
users:
- name: default-auth
  user:
    client-certificate: /var/lib/kubelet/pki/kubelet-client-current.pem
    client-key: /var/lib/kubelet/pki/kubelet-client-current.pem
[exit 0]
```

```
[cka-capture-worker]$ ls -l /var/lib/kubelet /etc/kubernetes /etc/systemd/system/kubelet.service.d; cat /etc/systemd/system/kubelet.service.d/*.conf; cat /var/lib/kubelet/kubeadm-flags.env
/etc/kubernetes:
total 12
-rw------- 1 root root 1958 Nov  9 01:32 kubelet.conf
drwxr-xr-x 2 root root 4096 Aug 20 11:25 manifests
drwxr-xr-x 2 root root 4096 Nov  9 01:32 pki

/etc/systemd/system/kubelet.service.d:
total 8
-rw-r--r-- 1 root root 1014 Aug 20 11:23 10-kubeadm.conf
-rw-r--r-- 1 root root  791 Aug 20 11:23 11-kind.conf

/var/lib/kubelet:
total 68
-rw------- 1 root root  386 Nov  9 01:32 actuated_pods_state
-rw------- 1 root root  386 Nov  9 01:32 allocated_pods_state
drwx------ 2 root root 4096 Nov  9 01:32 checkpoints
-rw-r--r-- 1 root root 1271 Nov  9 01:32 config.yaml
-rw------- 1 root root  146 Nov  9 01:32 cpu_manager_state
drwxr-xr-x 2 root root 4096 Nov  9 01:32 device-plugins
-rw------- 1 root root  139 Nov  9 01:32 dra_manager_state
drwx------ 4 root root 4096 Nov  9 01:32 image_manager
-rw-r--r-- 1 root root   67 Nov  9 01:32 instance-config.yaml
-rw-r--r-- 1 root root  118 Nov  9 01:32 kubeadm-flags.env
-rw------- 1 root root  142 Nov  9 01:32 memory_manager_state
drwxr-xr-x 2 root root 4096 Nov  9 01:32 pki
drwxr-x--- 2 root root 4096 Nov  9 01:32 plugins
drwxr-x--- 2 root root 4096 Nov  9 01:32 plugins_registry
drwxr-x--- 2 root root 4096 Nov  9 01:32 pod-resources
drwxr-x--- 4 root root 4096 Nov  9 01:32 pods
drwxr-x--- 2 root root 4096 Nov  9 01:32 pods-api
# https://github.com/kubernetes/kubernetes/blob/ba8fcafaf8c502a454acd86b728c857932555315/build/debs/10-kubeadm.conf
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
# kind specific additions go in this file
[Service]
# On cgroup v1, the /kubelet cgroup is created in the entrypoint script before running systemd.
# On cgroup v2, the /kubelet cgroup is created here. (See the comments in the entrypoint script for the reason.)
ExecStartPre=/bin/sh -euc "if [ -f /sys/fs/cgroup/cgroup.controllers ]; then /kind/bin/create-kubelet-cgroup-v2.sh; fi"
# on WSL2 (and potentially other distros without systemd) /sys/fs/cgroup/systemd is created after the entrypoint, during /sbin/init.
# This eventually leads to kubelet failing to start, see: https://github.com/kubernetes-sigs/kind/issues/2323
ExecStartPre=/bin/sh -euc "if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd/kubelet ]; then mkdir -p /sys/fs/cgroup/systemd/kubelet; fi"
KUBELET_KUBEADM_ARGS="--node-ip=172.18.0.3 --provider-id=kind://docker/cka-capture/cka-capture-worker --node-labels="
[exit 0]
```

```
[cka-capture-control-plane]$ ls /etc/kubernetes/manifests; cat /etc/kubernetes/manifests/kube-scheduler.yaml
etcd.yaml
kube-apiserver.yaml
kube-controller-manager.yaml
kube-scheduler.yaml
apiVersion: v1
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
    image: registry.k8s.io/kube-scheduler:v1.37.0
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
[exit 0]
```

```
[cka-capture-control-plane]$ grep -E 'containerRuntimeEndpoint|containerd.sock' -r /var/lib/kubelet/config.yaml /var/lib/kubelet/kubeadm-flags.env /etc/containerd/config.toml | head
/var/lib/kubelet/config.yaml:containerRuntimeEndpoint: unix:///run/containerd/containerd.sock
[exit 0]
```


Observations (baseline):
- All kube-system pods `1/1 Running`, 0 restarts. Control-plane node: `ROLES control-plane`; worker `ROLES <none>`.
- `systemctl is-active kubelet` = `active`, `is-enabled` = `enabled` on both nodes. kubelet process runs as a unit with `CGroup: /kubelet.slice/kubelet.service`.
- `crictl ps` on control-plane: coredns x2, local-path-provisioner, kindnet-cni, kube-proxy, etcd, kube-controller-manager, kube-apiserver, kube-scheduler. On worker: kindnet-cni, kube-proxy.
- `/etc/kubernetes/manifests` holds exactly four files on the control-plane; the worker's is empty.
- `crictl ps` columns: `CONTAINER IMAGE CREATED STATE NAME ATTEMPT POD ID POD NAMESPACE`.

## Scenario 1: kubelet stopped on the worker

Setup: a 1-replica nginx Deployment `web` pinned to the worker with `nodeSelector: kubernetes.io/hostname=cka-capture-worker`.

```
Waiting for deployment "web" rollout to finish: 0 of 1 updated replicas are available...
deployment "web" successfully rolled out
```

```
$ kubectl get pods -o wide
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          1s    10.244.1.3   cka-capture-worker   <none>           <none>
[exit 0]
```

```
[cka-capture-worker]$ crictl ps
CONTAINER           IMAGE               CREATED                  STATE               NAME                ATTEMPT             POD ID              POD                    NAMESPACE
27fb0d6cb7885       1e5f3c5b981a9       Less than a second ago   Running             nginx               0                   4ac9248248d74       web-674b4d9f9b-d5lzf   default
946494ed7c648       4626fe10df5b9       3 minutes ago            Running             kindnet-cni         0                   4f821ea8bead5       kindnet-qfzz2          kube-system
4a3423dfbe64a       d6a28daf3e6b0       3 minutes ago            Running             kube-proxy          0                   4404aeacf416f       kube-proxy-7v5f9       kube-system
[exit 0]
```


*TIMER RESET: stop kubelet*

```
[cka-capture-worker]$ date -u +%T; systemctl stop kubelet; date -u +%T
01:35:19
01:35:19
[exit 0]
```

```
[cka-capture-worker]$ systemctl status kubelet --no-pager
○ kubelet.service - kubelet: The Kubernetes Node Agent
     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)
    Drop-In: /etc/systemd/system/kubelet.service.d
             └─10-kubeadm.conf, 11-kind.conf
     Active: inactive (dead) since Mon 2026-11-09 01:35:19 UTC; 100ms ago
   Duration: 16.607s
 Invocation: d78fc459f33e4b999490723ddd24d742
       Docs: http://kubernetes.io/docs/
    Process: 1073 ExecStartPre=/bin/sh -euc if [ -f /sys/fs/cgroup/cgroup.controllers ]; then /kind/bin/create-kubelet-cgroup-v2.sh; fi (code=exited, status=0/SUCCESS)
    Process: 1082 ExecStartPre=/bin/sh -euc if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd/kubelet ]; then mkdir -p /sys/fs/cgroup/systemd/kubelet; fi (code=exited, status=0/SUCCESS)
    Process: 1084 ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS (code=exited, status=0/SUCCESS)
   Main PID: 1084 (code=exited, status=0/SUCCESS)
   Mem peak: 26.4M
        CPU: 574ms

Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.714792    1084 server.go:177] "Pod update broadcasted" podUID="9133c5aa-f30d-49d6-8804-2578502522f4" type="MODIFIED"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.716383    1084 server.go:190] "Pod removed broadcasted" podUID="9133c5aa-f30d-49d6-8804-2578502522f4"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.740236    1084 scope.go:118] "RemoveContainer" containerID="f40b26b88207851ac32c26d2f7908943ffa9841598da5efb47cf2e632a2832a9"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: E1109 01:35:18.740750    1084 remote_runtime.go:657] "ContainerStatus from runtime service failed" err="rpc error: code = NotFound desc = an error occurred when try to find container \"f40b26b88207851ac32c26d2f7908943ffa9841598da5efb47cf2e632a2832a9\ ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.740795    1084 pod_container_deletor.go:56] "DeleteContainer returned error" containerID={"Type":"containerd","ID":"f40b26b88207851ac32c26d2f7908943ffa9841598da5efb47cf2e632a2832a9"} err="failed to get container status \"f40b26b8820785 ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.840339    1084 server.go:177] "Pod update broadcasted" podUID="ff1efb86-112f-4a90-9a1c-76f267f441a7" type="MODIFIED"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.954330    1084 server.go:177] "Pod update broadcasted" podUID="ff1efb86-112f-4a90-9a1c-76f267f441a7" type="MODIFIED"
Nov 09 01:35:19 cka-capture-worker systemd[1]: Stopping kubelet.service - kubelet: The Kubernetes Node Agent...
Nov 09 01:35:19 cka-capture-worker systemd[1]: kubelet.service: Deactivated successfully.
Nov 09 01:35:19 cka-capture-worker systemd[1]: Stopped kubelet.service - kubelet: The Kubernetes Node Agent.
[exit 3]
```

```
[cka-capture-worker]$ systemctl is-active kubelet; systemctl is-enabled kubelet
inactive
enabled
[exit 0]
```

```
[cka-capture-worker]$ journalctl -u kubelet --no-pager -n 30
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.654356    1084 server.go:177] "Pod update broadcasted" podUID="6911fb0b-a4c0-4f56-b1dc-584be9ab6126" type="ADDED"
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.654536    1084 server.go:177] "Pod update broadcasted" podUID="8fb4b09f-2dfe-4ca8-adbd-54babf282aac" type="ADDED"
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.654582    1084 server.go:177] "Pod update broadcasted" podUID="9133c5aa-f30d-49d6-8804-2578502522f4" type="ADDED"
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.656139    1084 desired_state_of_world_populator.go:154] "Finished populating initial desired state of world"
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.670177    1084 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"xtables-lock\" (UniqueName: \"kubernetes.io/host-path/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-xtables-lock\") pod \"kube-proxy ...[line cut]
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.670254    1084 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"cni-cfg\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-cni-cfg\") pod \"kindnet-qfzz2\" (UID ...[line cut]
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.670274    1084 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"lib-modules\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-lib-modules\") pod \"kindnet-qfzz ...[line cut]
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.670304    1084 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"lib-modules\" (UniqueName: \"kubernetes.io/host-path/8fb4b09f-2dfe-4ca8-adbd-54babf282aac-lib-modules\") pod \"kube-proxy-7 ...[line cut]
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.670330    1084 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"xtables-lock\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-xtables-lock\") pod \"kindnet-qf ...[line cut]
Nov 09 01:35:03 cka-capture-worker kubelet[1084]: I1109 01:35:03.670347    1084 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"nri-plugin\" (UniqueName: \"kubernetes.io/host-path/6911fb0b-a4c0-4f56-b1dc-584be9ab6126-nri-plugin\") pod \"kindnet-qfzz2\ ...[line cut]
Nov 09 01:35:17 cka-capture-worker kubelet[1084]: I1109 01:35:17.667402    1084 server.go:177] "Pod update broadcasted" podUID="9133c5aa-f30d-49d6-8804-2578502522f4" type="MODIFIED"
Nov 09 01:35:17 cka-capture-worker kubelet[1084]: I1109 01:35:17.850218    1084 server.go:177] "Pod update broadcasted" podUID="9133c5aa-f30d-49d6-8804-2578502522f4" type="MODIFIED"
Nov 09 01:35:17 cka-capture-worker kubelet[1084]: I1109 01:35:17.941681    1084 reconciler_common.go:163] "operationExecutor.UnmountVolume started for volume \"kubernetes.io/projected/9133c5aa-f30d-49d6-8804-2578502522f4-kube-api-access-2dzkn\" (UniqueName: \"kubernetes.io/projected/9133c5aa-f30d-49 ...[line cut]
Nov 09 01:35:17 cka-capture-worker kubelet[1084]: I1109 01:35:17.943719    1084 operation_generator.go:791] UnmountVolume.TearDown succeeded for volume "kubernetes.io/projected/9133c5aa-f30d-49d6-8804-2578502522f4-kube-api-access-2dzkn" pod "9133c5aa-f30d-49d6-8804-2578502522f4" (UID: "9133c5aa-f30d ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.042414    1084 reconciler_common.go:299] "Volume detached for volume \"kube-api-access-2dzkn\" (UniqueName: \"kubernetes.io/projected/9133c5aa-f30d-49d6-8804-2578502522f4-kube-api-access-2dzkn\") on node \"cka-capture-worker\" DevicePa ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.361510    1084 server.go:177] "Pod update broadcasted" podUID="ff1efb86-112f-4a90-9a1c-76f267f441a7" type="ADDED"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.444175    1084 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kube-api-access-cll2z\" (UniqueName: \"kubernetes.io/projected/ff1efb86-112f-4a90-9a1c-76f267f441a7-kube-api-access-cll2z\" ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.714488    1084 scope.go:118] "RemoveContainer" containerID="f40b26b88207851ac32c26d2f7908943ffa9841598da5efb47cf2e632a2832a9"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: E1109 01:35:18.714579    1084 kubelet_pods.go:2214] "failed to read memory cgroup config for the pod" err="failed to read memory.max for cgroup /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-besteffort.slice/kubelet-kubepods-bes ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: E1109 01:35:18.714641    1084 kubelet_pods.go:2219] "failed to read memory cgroup limits for the pod" err="failed to read cpu.max file for cgroup /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-besteffort.slice/kubelet-kubepods-b ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.714792    1084 server.go:177] "Pod update broadcasted" podUID="9133c5aa-f30d-49d6-8804-2578502522f4" type="MODIFIED"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.716383    1084 server.go:190] "Pod removed broadcasted" podUID="9133c5aa-f30d-49d6-8804-2578502522f4"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.740236    1084 scope.go:118] "RemoveContainer" containerID="f40b26b88207851ac32c26d2f7908943ffa9841598da5efb47cf2e632a2832a9"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: E1109 01:35:18.740750    1084 remote_runtime.go:657] "ContainerStatus from runtime service failed" err="rpc error: code = NotFound desc = an error occurred when try to find container \"f40b26b88207851ac32c26d2f7908943ffa9841598da5efb47cf2e632a2832a9\ ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.740795    1084 pod_container_deletor.go:56] "DeleteContainer returned error" containerID={"Type":"containerd","ID":"f40b26b88207851ac32c26d2f7908943ffa9841598da5efb47cf2e632a2832a9"} err="failed to get container status \"f40b26b8820785 ...[line cut]
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.840339    1084 server.go:177] "Pod update broadcasted" podUID="ff1efb86-112f-4a90-9a1c-76f267f441a7" type="MODIFIED"
Nov 09 01:35:18 cka-capture-worker kubelet[1084]: I1109 01:35:18.954330    1084 server.go:177] "Pod update broadcasted" podUID="ff1efb86-112f-4a90-9a1c-76f267f441a7" type="MODIFIED"
Nov 09 01:35:19 cka-capture-worker systemd[1]: Stopping kubelet.service - kubelet: The Kubernetes Node Agent...
Nov 09 01:35:19 cka-capture-worker systemd[1]: kubelet.service: Deactivated successfully.
Nov 09 01:35:19 cka-capture-worker systemd[1]: Stopped kubelet.service - kubelet: The Kubernetes Node Agent.
[exit 0]
```

```
[cka-capture-worker]$ crictl ps
CONTAINER           IMAGE               CREATED                  STATE               NAME                ATTEMPT             POD ID              POD                    NAMESPACE
27fb0d6cb7885       1e5f3c5b981a9       Less than a second ago   Running             nginx               0                   4ac9248248d74       web-674b4d9f9b-d5lzf   default
946494ed7c648       4626fe10df5b9       3 minutes ago            Running             kindnet-cni         0                   4f821ea8bead5       kindnet-qfzz2          kube-system
4a3423dfbe64a       d6a28daf3e6b0       3 minutes ago            Running             kube-proxy          0                   4404aeacf416f       kube-proxy-7v5f9       kube-system
[exit 0]

--- t+0s
NAME                        STATUS   ROLES           AGE     VERSION
cka-capture-control-plane   Ready    control-plane   3m30s   v1.37.0
cka-capture-worker          Ready    <none>          3m17s   v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          1s    10.244.1.3   cka-capture-worker   <none>           <none>
--- t+5s
NAME                        STATUS   ROLES           AGE     VERSION
cka-capture-control-plane   Ready    control-plane   3m35s   v1.37.0
cka-capture-worker          Ready    <none>          3m22s   v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          6s    10.244.1.3   cka-capture-worker   <none>           <none>
--- t+10s
NAME                        STATUS   ROLES           AGE     VERSION
cka-capture-control-plane   Ready    control-plane   3m40s   v1.37.0
cka-capture-worker          Ready    <none>          3m27s   v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          12s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+16s
NAME                        STATUS   ROLES           AGE     VERSION
cka-capture-control-plane   Ready    control-plane   3m46s   v1.37.0
cka-capture-worker          Ready    <none>          3m33s   v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          17s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+21s
NAME                        STATUS   ROLES           AGE     VERSION
cka-capture-control-plane   Ready    control-plane   3m51s   v1.37.0
cka-capture-worker          Ready    <none>          3m38s   v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
[... trimmed 16 lines ...]
cka-capture-worker          Ready    <none>          3m53s   v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          37s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+42s
NAME                        STATUS   ROLES           AGE     VERSION
cka-capture-control-plane   Ready    control-plane   4m12s   v1.37.0
cka-capture-worker          Ready    <none>          3m59s   v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          43s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+47s
NAME                        STATUS   ROLES           AGE     VERSION
cka-capture-control-plane   Ready    control-plane   4m17s   v1.37.0
cka-capture-worker          Ready    <none>          4m4s    v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          48s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+52s
NAME                        STATUS     ROLES           AGE     VERSION
cka-capture-control-plane   Ready      control-plane   4m22s   v1.37.0
cka-capture-worker          NotReady   <none>          4m9s    v1.37.0
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          53s   10.244.1.3   cka-capture-worker   <none>           <none>
NOTREADY at t+52s
```

```
$ kubectl get nodes
NAME                        STATUS     ROLES           AGE     VERSION
cka-capture-control-plane   Ready      control-plane   4m22s   v1.37.0
cka-capture-worker          NotReady   <none>          4m9s    v1.37.0
[exit 0]
```

```
$ kubectl describe node cka-capture-worker
Name:               cka-capture-worker
Roles:              <none>
Labels:             beta.kubernetes.io/arch=amd64
                    beta.kubernetes.io/os=linux
                    kubernetes.io/arch=amd64
                    kubernetes.io/hostname=cka-capture-worker
                    kubernetes.io/os=linux
Annotations:        node.alpha.kubernetes.io/ttl: 0
                    volumes.kubernetes.io/controller-managed-attach-detach: true
CreationTimestamp:  Mon, 09 Nov 2026 01:32:02 +0000
Taints:             node.kubernetes.io/unreachable:NoExecute
                    node.kubernetes.io/unreachable:NoSchedule
Unschedulable:      false
Lease:
  HolderIdentity:  cka-capture-worker
  AcquireTime:     <unset>
  RenewTime:       Mon, 09 Nov 2026 01:35:13 +0000
Conditions:
  Type             Status    LastHeartbeatTime                 LastTransitionTime                Reason              Message
  ----             ------    -----------------                 ------------------                ------              -------
  MemoryPressure   Unknown   Mon, 09 Nov 2026 01:35:02 +0000   Mon, 09 Nov 2026 01:36:08 +0000   NodeStatusUnknown   Kubelet stopped posting node status.
  DiskPressure     Unknown   Mon, 09 Nov 2026 01:35:02 +0000   Mon, 09 Nov 2026 01:36:08 +0000   NodeStatusUnknown   Kubelet stopped posting node status.
  PIDPressure      Unknown   Mon, 09 Nov 2026 01:35:02 +0000   Mon, 09 Nov 2026 01:36:08 +0000   NodeStatusUnknown   Kubelet stopped posting node status.
  Ready            Unknown   Mon, 09 Nov 2026 01:35:02 +0000   Mon, 09 Nov 2026 01:36:08 +0000   NodeStatusUnknown   Kubelet stopped posting node status.
Addresses:
  InternalIP:  172.18.0.3
  Hostname:    cka-capture-worker
Capacity:
  cpu:                8
  ephemeral-storage:  82086711296
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             16375600Ki
  pods:               110
Allocatable:
[... trimmed 23 lines ...]
  kube-system                 kindnet-qfzz2           100m (1%)     0 (0%)      50Mi (0%)        0 (0%)         4m9s
  kube-system                 kube-proxy-7v5f9        0 (0%)        0 (0%)      0 (0%)           0 (0%)         4m9s
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests   Limits
  --------           --------   ------
  cpu                100m (1%)  0 (0%)
  memory             50Mi (0%)  0 (0%)
  ephemeral-storage  0 (0%)     0 (0%)
  hugepages-1Gi      0 (0%)     0 (0%)
  hugepages-2Mi      0 (0%)     0 (0%)
Events:
  Type    Reason                   Age                 From             Message
  ----    ------                   ----                ----             -------
  Normal  RegisteredNode           4m9s                node-controller  Node cka-capture-worker event: Registered Node cka-capture-worker in Controller
  Normal  NodeReady                3m55s               kubelet          Node cka-capture-worker status is now: NodeReady
  Normal  NodeHasSufficientMemory  69s (x3 over 69s)   kubelet          Node cka-capture-worker status is now: NodeHasSufficientMemory
  Normal  NodeHasNoDiskPressure    69s (x3 over 69s)   kubelet          Node cka-capture-worker status is now: NodeHasNoDiskPressure
  Normal  NodeHasSufficientPID     69s (x3 over 69s)   kubelet          Node cka-capture-worker status is now: NodeHasSufficientPID
  Normal  NodeReady                69s (x2 over 69s)   kubelet          Node cka-capture-worker status is now: NodeReady
  Normal  NodeNotReady             3s (x2 over 2m24s)  node-controller  Node cka-capture-worker status is now: NodeNotReady
[exit 0]
```

```
$ kubectl get pods -o wide
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          53s   10.244.1.3   cka-capture-worker   <none>           <none>
[exit 0]
```

```
[cka-capture-worker]$ crictl ps
CONTAINER           IMAGE               CREATED             STATE               NAME                ATTEMPT             POD ID              POD                    NAMESPACE
27fb0d6cb7885       1e5f3c5b981a9       53 seconds ago      Running             nginx               0                   4ac9248248d74       web-674b4d9f9b-d5lzf   default
946494ed7c648       4626fe10df5b9       4 minutes ago       Running             kindnet-cni         0                   4f821ea8bead5       kindnet-qfzz2          kube-system
4a3423dfbe64a       d6a28daf3e6b0       4 minutes ago       Running             kube-proxy          0                   4404aeacf416f       kube-proxy-7v5f9       kube-system
[exit 0]
```

```
[cka-capture-worker]$ curl -s -o /dev/null -w 'nginx http %{http_code}\n' http://$(crictl inspectp $(crictl pods --name web -q | head -1) | grep -m1 '"ip"' | tr -dc 0-9.)
nginx http 200
[exit 0]
```


Pod status over the following ~6 minutes (one `kubectl get pods -o wide` every 25 s, then events):

```
--- t+53s
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          54s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+78s
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          79s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+103s
NAME                   READY   STATUS    RESTARTS   AGE    IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          104s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+128s
NAME                   READY   STATUS    RESTARTS   AGE    IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          2m9s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+153s
NAME                   READY   STATUS    RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          2m34s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+178s
NAME                   READY   STATUS    RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          2m59s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+203s
NAME                   READY   STATUS    RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          3m24s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+228s
NAME                   READY   STATUS    RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          3m49s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+253s
NAME                   READY   STATUS    RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          4m14s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+278s
NAME                   READY   STATUS    RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          4m39s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+303s
NAME                   READY   STATUS    RESTARTS   AGE    IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          5m4s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+328s
NAME                   READY   STATUS    RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Running   0          5m29s   10.244.1.3   cka-capture-worker   <none>           <none>
--- t+353s
NAME                   READY   STATUS        RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Terminating   0          5m54s   10.244.1.3   cka-capture-worker   <none>           <none>
web-674b4d9f9b-trkps   0/1     Pending       0          4s      <none>       <none>               <none>           <none>
--- t+378s
NAME                   READY   STATUS        RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Terminating   0          6m19s   10.244.1.3   cka-capture-worker   <none>           <none>
web-674b4d9f9b-trkps   0/1     Pending       0          29s     <none>       <none>               <none>           <none>
```

```
$ kubectl get pods -o wide
NAME                   READY   STATUS        RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-d5lzf   1/1     Terminating   0          6m45s   10.244.1.3   cka-capture-worker   <none>           <none>
web-674b4d9f9b-trkps   0/1     Pending       0          55s     <none>       <none>               <none>           <none>
[exit 0]
```

```
$ kubectl get events --sort-by=.lastTimestamp
LAST SEEN   TYPE      REASON                    OBJECT                           MESSAGE
10m         Normal    Starting                  node/cka-capture-control-plane   
9m56s       Normal    Starting                  node/cka-capture-worker          
10m         Normal    NodeHasSufficientMemory   node/cka-capture-control-plane   Node cka-capture-control-plane status is now: NodeHasSufficientMemory
10m         Normal    NodeHasNoDiskPressure     node/cka-capture-control-plane   Node cka-capture-control-plane status is now: NodeHasNoDiskPressure
10m         Normal    NodeHasSufficientPID      node/cka-capture-control-plane   Node cka-capture-control-plane status is now: NodeHasSufficientPID
10m         Normal    NodeAllocatableEnforced   node/cka-capture-control-plane   Updated Node Allocatable limit across pods
10m         Normal    Starting                  node/cka-capture-control-plane   Starting kubelet.
10m         Normal    NodeAllocatableEnforced   node/cka-capture-control-plane   Updated Node Allocatable limit across pods
10m         Normal    NodeHasNoDiskPressure     node/cka-capture-control-plane   Node cka-capture-control-plane status is now: NodeHasNoDiskPressure
10m         Normal    NodeHasSufficientPID      node/cka-capture-control-plane   Node cka-capture-control-plane status is now: NodeHasSufficientPID
10m         Normal    NodeHasSufficientMemory   node/cka-capture-control-plane   Node cka-capture-control-plane status is now: NodeHasSufficientMemory
10m         Normal    Starting                  node/cka-capture-control-plane   Starting kubelet.
10m         Normal    RegisteredNode            node/cka-capture-control-plane   Node cka-capture-control-plane event: Registered Node cka-capture-control-plane in Controller
10m         Normal    NodeHasSufficientMemory   node/cka-capture-worker          Node cka-capture-worker status is now: NodeHasSufficientMemory
10m         Normal    NodeHasNoDiskPressure     node/cka-capture-worker          Node cka-capture-worker status is now: NodeHasNoDiskPressure
10m         Normal    NodeHasSufficientPID      node/cka-capture-worker          Node cka-capture-worker status is now: NodeHasSufficientPID
10m         Normal    NodeAllocatableEnforced   node/cka-capture-worker          Updated Node Allocatable limit across pods
10m         Normal    RegisteredNode            node/cka-capture-worker          Node cka-capture-worker event: Registered Node cka-capture-worker in Controller
10m         Normal    Starting                  node/cka-capture-worker          Starting kubelet.
9m52s       Normal    NodeReady                 node/cka-capture-control-plane   Node cka-capture-control-plane status is now: NodeReady
9m47s       Normal    NodeReady                 node/cka-capture-worker          Node cka-capture-worker status is now: NodeReady
9m16s       Normal    ScalingReplicaSet         deployment/web                   Scaled up replica set web-674b4d9f9b from 0 to 1
9m16s       Normal    SuccessfulCreate          replicaset/web-674b4d9f9b        Created pod: web-674b4d9f9b-77fr5
9m16s       Normal    Pulling                   pod/web-674b4d9f9b-77fr5         Pulling image "nginx:1.27"
9m16s       Normal    Scheduled                 pod/web-674b4d9f9b-77fr5         Successfully assigned default/web-674b4d9f9b-77fr5 to cka-capture-worker
9m9s        Normal    Created                   pod/web-674b4d9f9b-77fr5         Container created
9m9s        Normal    Pulled                    pod/web-674b4d9f9b-77fr5         Successfully pulled image "nginx:1.27" in 6.738s (6.738s including waiting). Image size: 72406859 bytes.
9m8s        Normal    Started                   pod/web-674b4d9f9b-77fr5         Container started
8m16s       Warning   NodeNotReady              pod/web-674b4d9f9b-77fr5         Node is not ready
7m1s        Normal    NodeHasSufficientMemory   node/cka-capture-worker          Node cka-capture-worker status is now: NodeHasSufficientMemory
7m1s        Normal    NodeReady                 node/cka-capture-worker          Node cka-capture-worker status is now: NodeReady
7m1s        Normal    NodeHasSufficientPID      node/cka-capture-worker          Node cka-capture-worker status is now: NodeHasSufficientPID
7m1s        Normal    NodeHasNoDiskPressure     node/cka-capture-worker          Node cka-capture-worker status is now: NodeHasNoDiskPressure
7m1s        Normal    NodeAllocatableEnforced   node/cka-capture-worker          Updated Node Allocatable limit across pods
7m1s        Normal    Starting                  node/cka-capture-worker          Starting kubelet.
7m          Normal    TaintManagerEviction      pod/web-674b4d9f9b-77fr5         Cancelling deletion of Pod default/web-674b4d9f9b-77fr5
6m46s       Normal    Killing                   pod/web-674b4d9f9b-77fr5         Stopping container nginx
6m45s       Normal    Created                   pod/web-674b4d9f9b-d5lzf         Container created
6m45s       Normal    Pulled                    pod/web-674b4d9f9b-d5lzf         Container image "nginx:1.27" already present on machine and can be accessed by the pod
6m45s       Normal    Started                   pod/web-674b4d9f9b-d5lzf         Container started
6m45s       Normal    Scheduled                 pod/web-674b4d9f9b-d5lzf         Successfully assigned default/web-674b4d9f9b-d5lzf to cka-capture-worker
6m45s       Normal    SuccessfulCreate          replicaset/web-674b4d9f9b        Created pod: web-674b4d9f9b-d5lzf
6m45s       Normal    ScalingReplicaSet         deployment/web                   Scaled up replica set web-674b4d9f9b from 0 to 1
5m55s       Warning   NodeNotReady              pod/web-674b4d9f9b-d5lzf         Node is not ready
5m55s       Normal    NodeNotReady              node/cka-capture-worker          Node cka-capture-worker status is now: NodeNotReady
55s         Normal    TaintManagerEviction      pod/web-674b4d9f9b-d5lzf         Marking for deletion Pod default/web-674b4d9f9b-d5lzf
55s         Warning   FailedScheduling          pod/web-674b4d9f9b-trkps         0/2 nodes are available: 2 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.
55s         Normal    SuccessfulCreate          replicaset/web-674b4d9f9b        Created pod: web-674b4d9f9b-trkps
[exit 0]
```

```
$ kubectl describe pod -l app=web
Name:                      web-674b4d9f9b-d5lzf
Namespace:                 default
Priority:                  0
Service Account:           default
Node:                      cka-capture-worker/172.18.0.3
Start Time:                Mon, 09 Nov 2026 01:35:18 +0000
Labels:                    app=web
                           pod-template-hash=674b4d9f9b
Annotations:               <none>
Status:                    Terminating (lasts 25s)
Termination Grace Period:  30s
IP:                        10.244.1.3
IPs:
  IP:           10.244.1.3
Controlled By:  ReplicaSet/web-674b4d9f9b
Containers:
  nginx:
    Container ID:   containerd://27fb0d6cb78859808b6241440664644560c9a0df8b9dd11a4cc4e19d8db52566
    Image:          nginx:1.27
    Image ID:       docker.io/library/nginx@sha256:6784fb0834aa7dbbe12e3d7471e69c290df3e6ba810dc38b34ae33d3c1c05f7d
    Port:           <none>
    Host Port:      <none>
    State:          Running
      Started:      Mon, 09 Nov 2026 01:35:18 +0000
    Ready:          True
    Restart Count:  0
    Environment:    <none>
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-cll2z (ro)
Conditions:
  Type                        Status
  PodReadyToStartContainers   True 
  Initialized                 True 
  Ready                       False 
  ContainersReady             True 
  PodScheduled                True 
  DisruptionTarget            True 
Volumes:
  kube-api-access-cll2z:
    Type:                    Projected (a volume that contains injected data from multiple sources)
    TokenExpirationSeconds:  3607
    ConfigMapName:           kube-root-ca.crt
    Optional:                false
    DownwardAPI:             true
QoS Class:                   BestEffort
Node-Selectors:              kubernetes.io/hostname=cka-capture-worker
Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s


Name:             web-674b4d9f9b-trkps
Namespace:        default
Priority:         0
Service Account:  default
Node:             <none>
Labels:           app=web
                  pod-template-hash=674b4d9f9b
Annotations:      <none>
Status:           Pending
IP:               
IPs:              <none>
Controlled By:    ReplicaSet/web-674b4d9f9b
Containers:
  nginx:
    Image:        nginx:1.27
    Port:         <none>
    Host Port:    <none>
    Environment:  <none>
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-fx2zs (ro)
Conditions:
  Type           Status
  PodScheduled   False 
Volumes:
  kube-api-access-fx2zs:
    Type:                    Projected (a volume that contains injected data from multiple sources)
    TokenExpirationSeconds:  3607
    ConfigMapName:           kube-root-ca.crt
    Optional:                false
    DownwardAPI:             true
QoS Class:                   BestEffort
Node-Selectors:              kubernetes.io/hostname=cka-capture-worker
Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s
[exit 0]
```


Observations (kubelet stopped):
- `systemctl stop kubelet` returns instantly; `systemctl status` then shows `Active: inactive (dead)` and exit code 3 (`[exit 3]`); `is-enabled` still `enabled`. The journal's last lines are `systemd[1]: Stopping kubelet.service - kubelet: The Kubernetes Node Agent...` / `Deactivated successfully.` / `Stopped kubelet.service ...`.
- **Node went `NotReady` ~52 s after the stop** (polls: Ready at t+47s, NotReady at t+52s; node-monitor-grace-period 40 s plus poll granularity). The `kubectl describe node` Conditions all flip to `Unknown` with Reason `NodeStatusUnknown`, Message `Kubelet stopped posting node status.`, and Taints become `node.kubernetes.io/unreachable:NoExecute` and `node.kubernetes.io/unreachable:NoSchedule`. Events: `NodeNotReady ... node-controller ... Node cka-capture-worker status is now: NodeNotReady`.
- **Containers keep running: yes.** `crictl ps` on the worker still lists the nginx, kindnet-cni and kube-proxy containers, and curl to the nginx pod IP from inside the worker returned `nginx http 200` after NotReady. Stopping kubelet does not stop containers.
- The Pod stayed `1/1 Running` in `kubectl get pods` for the whole NotReady period (the READY/STATUS columns are NOT updated by the control plane when the node is unreachable). It only changed when the taint-based eviction fired: `TaintManagerEviction ... Marking for deletion Pod`, pod `Terminating` ~300 s after NotReady (t+353 s in this run, matching the default `tolerationSeconds: 300` for `node.kubernetes.io/unreachable`), and a replacement Pod was created `Pending` with `FailedScheduling ... 0/2 nodes are available: 2 node(s) had untolerated taint(s)` (control-plane taint + unreachable taint). The old Pod stays `Terminating` until the kubelet returns.
- NOTE on the events block above: it also contains events from an earlier aborted attempt of this same scenario (pod `web-674b4d9f9b-77fr5`, a few minutes before) because the same Deployment name was reused. Ignore those older entries; the `...-d5lzf` and `...-trkps` entries belong to this run.
- **Recovery**: `systemctl start kubelet` -> node `Ready` within ~3 s (t+3s), Terminating pod removed, the Pending replacement scheduled and `Running` by t+3 s, taints removed (`Taints: <none>`).

## Scenario 2: kubelet disabled and stopped (simulates "did not come back after reboot")

```
[cka-capture-worker]$ systemctl disable kubelet
Removed '/etc/systemd/system/multi-user.target.wants/kubelet.service'.
[exit 0]
```

```
[cka-capture-worker]$ systemctl stop kubelet
[exit 0]
```

```
[cka-capture-worker]$ systemctl status kubelet --no-pager
○ kubelet.service - kubelet: The Kubernetes Node Agent
     Loaded: loaded (/etc/systemd/system/kubelet.service; disabled; preset: enabled)
    Drop-In: /etc/systemd/system/kubelet.service.d
             └─10-kubeadm.conf, 11-kind.conf
     Active: inactive (dead) since Mon 2026-11-09 01:42:28 UTC; 66ms ago
   Duration: 25.384s
 Invocation: 65a5e3fa3cdf4e68b0f92e980a1b67fe
       Docs: http://kubernetes.io/docs/
    Process: 1519 ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS (code=exited, status=0/SUCCESS)
   Main PID: 1519 (code=exited, status=0/SUCCESS)
   Mem peak: 28.2M
        CPU: 638ms

Nov 09 01:42:05 cka-capture-worker kubelet[1519]: I1109 01:42:05.388743    1519 pod_container_deletor.go:56] "DeleteContainer returned error" containerID={"Type":"containerd","ID":"27fb0d6cb78859808b6241440664644560c9a0df8b9dd11a4cc4e19d8db52566"} err="failed to get container status \"27fb0d6cb78859 ...[line cut]
Nov 09 01:42:07 cka-capture-worker kubelet[1519]: I1109 01:42:07.362202    1519 kubelet_volumes.go:161] "Cleaned up orphaned pod volumes dir" podUID="ff1efb86-112f-4a90-9a1c-76f267f441a7" path="/var/lib/kubelet/pods/ff1efb86-112f-4a90-9a1c-76f267f441a7/volumes"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644044    1519 eviction_manager.go:224] "Eviction manager: monitoring loop exiting" err="context canceled"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644063    1519 podcertificatemanager.go:351] "podcertificate.IssuingManager shut down"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644095    1519 volume_manager.go:341] "Shutting down Kubelet Volume Manager"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644110    1519 tlsconfig.go:258] "Shutting down DynamicServingCertificateController"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644137    1519 server.go:302] "Shutting down pods API server"
Nov 09 01:42:28 cka-capture-worker systemd[1]: Stopping kubelet.service - kubelet: The Kubernetes Node Agent...
Nov 09 01:42:28 cka-capture-worker systemd[1]: kubelet.service: Deactivated successfully.
Nov 09 01:42:28 cka-capture-worker systemd[1]: Stopped kubelet.service - kubelet: The Kubernetes Node Agent.
[exit 3]
```

```
[cka-capture-worker]$ systemctl is-enabled kubelet; systemctl is-active kubelet
disabled
inactive
[exit 3]
```

```
[cka-capture-worker]$ systemctl cat kubelet --no-pager | head -5
# /etc/systemd/system/kubelet.service
# slightly modified from:
# https://github.com/kubernetes/kubernetes/blob/ba8fcafaf8c502a454acd86b728c857932555315/build/debs/kubelet.service
[Unit]
Description=kubelet: The Kubernetes Node Agent
[exit 0]
```

```
[cka-capture-worker]$ journalctl -u kubelet --no-pager -n 8
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644044    1519 eviction_manager.go:224] "Eviction manager: monitoring loop exiting" err="context canceled"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644063    1519 podcertificatemanager.go:351] "podcertificate.IssuingManager shut down"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644095    1519 volume_manager.go:341] "Shutting down Kubelet Volume Manager"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644110    1519 tlsconfig.go:258] "Shutting down DynamicServingCertificateController"
Nov 09 01:42:28 cka-capture-worker kubelet[1519]: I1109 01:42:28.644137    1519 server.go:302] "Shutting down pods API server"
Nov 09 01:42:28 cka-capture-worker systemd[1]: Stopping kubelet.service - kubelet: The Kubernetes Node Agent...
Nov 09 01:42:28 cka-capture-worker systemd[1]: kubelet.service: Deactivated successfully.
Nov 09 01:42:28 cka-capture-worker systemd[1]: Stopped kubelet.service - kubelet: The Kubernetes Node Agent.
[exit 0]
```


*TIMER RESET: disabled*

```
$ kubectl get nodes
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   11m   v1.37.0
cka-capture-worker          NotReady   <none>          11m   v1.37.0
[exit 0]
```

```
[cka-capture-worker]$ systemctl enable --now kubelet
Created symlink '/etc/systemd/system/multi-user.target.wants/kubelet.service' → '/etc/systemd/system/kubelet.service'.
[exit 0]
```

```
[cka-capture-worker]$ systemctl status kubelet --no-pager | head -12
● kubelet.service - kubelet: The Kubernetes Node Agent
     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)
    Drop-In: /etc/systemd/system/kubelet.service.d
             └─10-kubeadm.conf, 11-kind.conf
     Active: active (running) since Mon 2026-11-09 01:43:29 UTC; 85ms ago
 Invocation: c6e47f9579dc45c7bd7fc6834b2753fb
       Docs: http://kubernetes.io/docs/
    Process: 1863 ExecStartPre=/bin/sh -euc if [ -f /sys/fs/cgroup/cgroup.controllers ]; then /kind/bin/create-kubelet-cgroup-v2.sh; fi (code=exited, status=0/SUCCESS)
    Process: 1872 ExecStartPre=/bin/sh -euc if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd/kubelet ]; then mkdir -p /sys/fs/cgroup/systemd/kubelet; fi (code=exited, status=0/SUCCESS)
   Main PID: 1874 (kubelet)
      Tasks: 13 (limit: 2871)
     Memory: 15.5M (peak: 16M)
[exit 0]
```

```
[cka-capture-worker]$ systemctl is-enabled kubelet; systemctl is-active kubelet
enabled
active
[exit 0]
```


*TIMER RESET: enable-now*

```
--- t+0s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   11m   v1.37.0
cka-capture-worker          Ready    <none>          11m   v1.37.0
--- t+3s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   11m   v1.37.0
cka-capture-worker          Ready    <none>          11m   v1.37.0
--- t+6s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   11m   v1.37.0
cka-capture-worker          Ready    <none>          11m   v1.37.0
--- t+9s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   11m   v1.37.0
cka-capture-worker          Ready    <none>          11m   v1.37.0
--- t+12s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   11m   v1.37.0
cka-capture-worker          Ready    <none>          11m   v1.37.0
--- t+15s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   11m   v1.37.0
cka-capture-worker          Ready    <none>          11m   v1.37.0
--- t+18s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   11m   v1.37.0
cka-capture-worker          Ready    <none>          11m   v1.37.0
--- t+21s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   12m   v1.37.0
cka-capture-worker          Ready    <none>          11m   v1.37.0
```

```
$ kubectl get pods -o wide
NAME                   READY   STATUS    RESTARTS   AGE     IP           NODE                 NOMINATED NODE   READINESS GATES
web-674b4d9f9b-trkps   1/1     Running   0          2m45s   10.244.1.4   cka-capture-worker   <none>           <none>
[exit 0]
```


Observations (disabled + stopped):
- `systemctl disable kubelet` prints `Removed '/etc/systemd/system/multi-user.target.wants/kubelet.service'.` On this kind node it does NOT stop the running unit; the separate `systemctl stop kubelet` does.
- After both: `systemctl status kubelet` shows `Loaded: loaded (/etc/systemd/system/kubelet.service; disabled; preset: enabled)` and `Active: inactive (dead) since ... ago`, exit code 3; `systemctl is-enabled` prints `disabled` (exit 3), `is-active` prints `inactive`.
- The node was `NotReady` after about one minute of waiting (a 60 s sleep, then `kubectl get nodes` showed `NotReady`).
- `systemctl enable --now kubelet` prints `Created symlink '/etc/systemd/system/multi-user.target.wants/kubelet.service' -> '/etc/systemd/system/kubelet.service'.` (the real output uses a unicode arrow) and the unit is `active (running)`, `enabled`. Node `Ready` in <= 3 s (already Ready at the first poll after the command, t+0..3 s). Pod `web-...-trkps` still `1/1 Running`.
- `systemctl cat kubelet` shows the kind-modified unit header (`# slightly modified from: https://github.com/kubernetes/kubernetes/blob/.../kubelet.service`).

## Scenario 3: kube-scheduler static pod manifest broken (control plane)

The manifest is `/etc/kubernetes/manifests/kube-scheduler.yaml`. All manifests were first copied to `/root/cka-capture/` inside the control-plane container. Healthy manifest content is in the Scenario 0 section (`cat kube-scheduler.yaml`). A throwaway Pod (`kubectl run testN --image=nginx:1.27`) was created while the scheduler was broken.

### 3a: YAML syntax error (`containers:` -> `containers`)

```
$ kubectl get pods -n kube-system -l component=kube-scheduler
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          12m
[exit 0]
```


*TIMER RESET: edit*

```
[cka-capture-control-plane]$ sed -i 's/^  containers:/  containers/' /etc/kubernetes/manifests/kube-scheduler.yaml; sed -n 8,12p /etc/kubernetes/manifests/kube-scheduler.yaml; date -u +%T
  namespace: kube-system
spec:
  containers
  - command:
    - kube-scheduler
01:44:04
[exit 0]

--- t+0s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
c6f4ccdfdba3d       1fabf80a1273a       12 minutes ago      Running             kube-scheduler            0                   6a46346560f12       kube-scheduler-cka-capture-control-plane            kube-system
--- t+5s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
c6f4ccdfdba3d       1fabf80a1273a       12 minutes ago      Running             kube-scheduler            0                   6a46346560f12       kube-scheduler-cka-capture-control-plane            kube-system
--- t+10s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+15s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+20s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+25s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+31s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+36s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+41s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
```

```
[cka-capture-control-plane]$ crictl ps -a | grep -E 'CONTAINER|scheduler'
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
[exit 0]
```

```
$ kubectl get pods -n kube-system
NAME                                                READY   STATUS    RESTARTS   AGE
coredns-559f6c778d-5t9j5                            1/1     Running   0          12m
coredns-559f6c778d-mkr68                            1/1     Running   0          12m
etcd-cka-capture-control-plane                      1/1     Running   0          12m
kindnet-psznp                                       1/1     Running   0          12m
kindnet-qfzz2                                       1/1     Running   0          12m
kube-apiserver-cka-capture-control-plane            1/1     Running   0          12m
kube-controller-manager-cka-capture-control-plane   1/1     Running   0          12m
kube-proxy-7v5f9                                    1/1     Running   0          12m
kube-proxy-hjhpc                                    1/1     Running   0          12m
[exit 0]
```

```
[cka-capture-control-plane]$ journalctl -u kubelet --no-pager | grep -i scheduler | tail -20
Nov 09 01:31:40 cka-capture-control-plane kubelet[250]: I1109 01:31:40.826962     250 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kubeconfig\" (UniqueName: \"kubernetes.io/host-path/c7c077ca3b88e79262b650020a12349a-kubeconfig\") pod \"kube-schedul ...[line cut]
Nov 09 01:31:49 cka-capture-control-plane kubelet[250]: I1109 01:31:49.925827     250 kubelet.go:3579] "Creating a mirror pod for static pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:31:49 cka-capture-control-plane kubelet[250]: E1109 01:31:49.932868     250 kubelet.go:3581] "Failed creating a mirror pod" err="pods \"kube-scheduler-cka-capture-control-plane\" is forbidden: no PriorityClass with name system-node-critical was found" pod="kube-system/kube-scheduler-cka-ca ...[line cut]
Nov 09 01:31:53 cka-capture-control-plane kubelet[771]: I1109 01:31:53.234071     771 kubelet.go:3579] "Creating a mirror pod for static pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:31:53 cka-capture-control-plane kubelet[771]: I1109 01:31:53.319299     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kubeconfig\" (UniqueName: \"kubernetes.io/host-path/c7c077ca3b88e79262b650020a12349a-kubeconfig\") pod \"kube-schedul ...[line cut]
Nov 09 01:31:54 cka-capture-control-plane kubelet[771]: I1109 01:31:54.143190     771 kubelet.go:3579] "Creating a mirror pod for static pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:31:54 cka-capture-control-plane kubelet[771]: E1109 01:31:54.164218     771 kubelet.go:3581] "Failed creating a mirror pod" err="pods \"kube-scheduler-cka-capture-control-plane\" already exists" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:31:54 cka-capture-control-plane kubelet[771]: I1109 01:31:54.299354     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/kube-scheduler-cka-capture-control-plane" podStartSLOduration=1.299351451 podStartE2EDuration="1.299351451s" totalImagesPullingTi ...[line cut]
Nov 09 01:44:04 cka-capture-control-plane kubelet[771]: E1109 01:44:04.492611     771 file.go:107] "Unable to process watch event" err="can't process config file \"/etc/kubernetes/manifests/kube-scheduler.yaml\": /etc/kubernetes/manifests/kube-scheduler.yaml: couldn't parse as pod(yaml: line 11: map ...[line cut]
Nov 09 01:44:13 cka-capture-control-plane kubelet[771]: E1109 01:44:13.109177     771 file.go:186] "Could not process manifest file" err="/etc/kubernetes/manifests/kube-scheduler.yaml: couldn't parse as pod(yaml: line 11: mapping values are not allowed in this context), please check config file" pat ...[line cut]
Nov 09 01:44:33 cka-capture-control-plane kubelet[771]: E1109 01:44:33.110430     771 file.go:186] "Could not process manifest file" err="/etc/kubernetes/manifests/kube-scheduler.yaml: couldn't parse as pod(yaml: line 11: mapping values are not allowed in this context), please check config file" pat ...[line cut]
[exit 0]
```

```
[cka-capture-control-plane]$ journalctl -u kubelet --no-pager --since '-90s' | grep -iE 'yaml|unmarshal|manifest|static' | tail -10
Nov 09 01:44:04 cka-capture-control-plane kubelet[771]: E1109 01:44:04.492454     771 file.go:107] "Unable to process watch event" err="can't process config file \"/etc/kubernetes/manifests/sed6QHUvf\": open /etc/kubernetes/manifests/sed6QHUvf: no such file or directory"
Nov 09 01:44:04 cka-capture-control-plane kubelet[771]: E1109 01:44:04.492502     771 file.go:107] "Unable to process watch event" err="can't process config file \"/etc/kubernetes/manifests/sed6QHUvf\": open /etc/kubernetes/manifests/sed6QHUvf: no such file or directory"
Nov 09 01:44:04 cka-capture-control-plane kubelet[771]: E1109 01:44:04.492510     771 file.go:107] "Unable to process watch event" err="can't process config file \"/etc/kubernetes/manifests/sed6QHUvf\": open /etc/kubernetes/manifests/sed6QHUvf: no such file or directory"
Nov 09 01:44:04 cka-capture-control-plane kubelet[771]: E1109 01:44:04.492611     771 file.go:107] "Unable to process watch event" err="can't process config file \"/etc/kubernetes/manifests/kube-scheduler.yaml\": /etc/kubernetes/manifests/kube-scheduler.yaml: couldn't parse as pod(yaml: line 11: map ...[line cut]
Nov 09 01:44:13 cka-capture-control-plane kubelet[771]: E1109 01:44:13.109177     771 file.go:186] "Could not process manifest file" err="/etc/kubernetes/manifests/kube-scheduler.yaml: couldn't parse as pod(yaml: line 11: mapping values are not allowed in this context), please check config file" pat ...[line cut]
Nov 09 01:44:33 cka-capture-control-plane kubelet[771]: E1109 01:44:33.110430     771 file.go:186] "Could not process manifest file" err="/etc/kubernetes/manifests/kube-scheduler.yaml: couldn't parse as pod(yaml: line 11: mapping values are not allowed in this context), please check config file" pat ...[line cut]
[exit 0]
```

```
$ kubectl run test3a --image=nginx:1.27
pod/test3a created
[exit 0]
```

```
$ kubectl get pods test3a -o wide
NAME     READY   STATUS    RESTARTS   AGE   IP       NODE     NOMINATED NODE   READINESS GATES
test3a   0/1     Pending   0          15s   <none>   <none>   <none>           <none>
[exit 0]
```

```
$ kubectl describe pod test3a
Name:             test3a
Namespace:        default
Priority:         0
Service Account:  default
Node:             <none>
Labels:           run=test3a
Annotations:      <none>
Status:           Pending
IP:               
IPs:              <none>
Containers:
  test3a:
    Image:        nginx:1.27
    Port:         <none>
    Host Port:    <none>
    Environment:  <none>
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-5ln65 (ro)
Volumes:
  kube-api-access-5ln65:
    Type:                    Projected (a volume that contains injected data from multiple sources)
    TokenExpirationSeconds:  3607
    ConfigMapName:           kube-root-ca.crt
    Optional:                false
    DownwardAPI:             true
QoS Class:                   BestEffort
Node-Selectors:              <none>
Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s
Events:                      <none>
[exit 0]
```

```
$ kubectl get events --field-selector involvedObject.name=test3a
No resources found in default namespace.
[exit 0]

--- NOTE: killing scheduler container id to see if it comes back
```

```
[cka-capture-control-plane]$ crictl ps -a | grep -E 'CONTAINER|scheduler'; crictl pods | grep -E 'POD ID|scheduler'
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
POD ID              CREATED             STATE               NAME                                                NAMESPACE            ATTEMPT             RUNTIME
[exit 0]
```


*TIMER RESET: restore*

```
[cka-capture-control-plane]$ cp -p /root/cka-capture/kube-scheduler.yaml /etc/kubernetes/manifests/kube-scheduler.yaml; date -u +%T
01:45:05
[exit 0]

--- t+0s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     Pending   0          0s
NAME     READY   STATUS    RESTARTS   AGE
test3a   0/1     Pending   0          16s
--- t+6s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     Running   0          6s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          21s
--- t+11s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     Running   0          11s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          26s
--- t+16s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          16s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          31s
--- t+21s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          21s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          36s
--- t+26s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          26s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          41s
--- t+31s
NAME                                       READY   STATUS    RESTARTS   AGE
[... trimmed 42 lines ...]
test3a   1/1     Running   0          87s
--- t+77s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          77s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          92s
--- t+82s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          83s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          98s
--- t+88s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          88s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          103s
--- t+93s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          93s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          108s
--- t+98s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          98s
NAME     READY   STATUS    RESTARTS   AGE
test3a   1/1     Running   0          113s
```

```
$ kubectl get pods test3a -o wide
NAME     READY   STATUS    RESTARTS   AGE    IP           NODE                 NOMINATED NODE   READINESS GATES
test3a   1/1     Running   0          118s   10.244.1.5   cka-capture-worker   <none>           <none>
[exit 0]
```

```
$ kubectl delete pod test3a --now
pod "test3a" deleted from default namespace
[exit 0]
```


Observations (3a):
- Timeline: edit at 01:44:04. The scheduler container was **gone from `crictl ps -a` by t+10 s** (first poll at t+0 and t+5 s still showed it `Running`; from t+10 s onward no scheduler container and no scheduler row at all). By the time of `kubectl get pods -n kube-system` the `kube-scheduler-cka-capture-control-plane` pod had **disappeared from the list entirely** (9 pods listed, no scheduler row, not even `Error`/`CrashLoopBackOff`).
- So a YAML syntax error does not leave a crashing container: the kubelet cannot parse the manifest, drops the static pod, and logs the problem. Where to find it: `journalctl -u kubelet | grep -i scheduler | tail` shows `E... file.go:186] "Could not process manifest file" err="/etc/kubernetes/manifests/kube-scheduler.yaml: couldn't parse as pod(yaml: line 11: mapping values are not allowed in this context), please check config file"` repeating about every 20 s (01:44:13, 01:44:33, ...). Also `file.go:107] "Unable to process watch event" err="can't process config file ...` at the moment of the edit (the `sed -i` temp file `sed6QHUvf` shows up in the inotify noise).
- The test Pod `test3a` stayed `Pending` with `Node: <none>`, and `kubectl describe pod` shows **`Events: <none>`** (no FailedScheduling event, because no scheduler exists to emit one). `kubectl get events --field-selector involvedObject.name=test3a` -> `No resources found in default namespace.`
- **Restore** (cp of the backup at 01:45:05): scheduler mirror pod reappeared `Pending` at t+0, `0/1 Running` at t+6 s, `1/1 Running` at t+16 s. `test3a` became `1/1 Running` on `cka-capture-worker` by t+6 s (about 20 s after the file was restored).

### 3b: wrong image tag (`kube-scheduler:v1.37.0` -> `v1.37.99`)


*TIMER RESET: edit*

```
[cka-capture-control-plane]$ sed -i 's#kube-scheduler:v1.37.0#kube-scheduler:v1.37.99#' /etc/kubernetes/manifests/kube-scheduler.yaml; grep image: /etc/kubernetes/manifests/kube-scheduler.yaml; date -u +%T
    image: registry.k8s.io/kube-scheduler:v1.37.99
01:46:49
[exit 0]

--- t+0s
CONTAINER           IMAGE               CREATED              STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
edc548ec15b59       1fabf80a1273a       About a minute ago   Exited              kube-scheduler            0                   e0128e75700bc       kube-scheduler-cka-capture-control-plane            kube-system
--- t+5s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+10s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+16s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+21s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+26s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+31s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+36s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+41s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+46s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+51s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+56s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
```

```
[cka-capture-control-plane]$ crictl ps -a | grep -E 'CONTAINER|scheduler'; crictl pods | grep -E 'POD ID|scheduler'
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
POD ID              CREATED             STATE               NAME                                                NAMESPACE            ATTEMPT             RUNTIME
104fe7edb0ad5       46 seconds ago      Ready               kube-scheduler-cka-capture-control-plane            kube-system          0                   (default)
[exit 0]
```

```
$ kubectl get pods -n kube-system
NAME                                                READY   STATUS             RESTARTS   AGE
coredns-559f6c778d-5t9j5                            1/1     Running            0          15m
coredns-559f6c778d-mkr68                            1/1     Running            0          15m
etcd-cka-capture-control-plane                      1/1     Running            0          15m
kindnet-psznp                                       1/1     Running            0          15m
kindnet-qfzz2                                       1/1     Running            0          15m
kube-apiserver-cka-capture-control-plane            1/1     Running            0          15m
kube-controller-manager-cka-capture-control-plane   1/1     Running            0          15m
kube-proxy-7v5f9                                    1/1     Running            0          15m
kube-proxy-hjhpc                                    1/1     Running            0          15m
kube-scheduler-cka-capture-control-plane            0/1     ImagePullBackOff   0          46s
[exit 0]
```

```
$ kubectl describe pod -n kube-system kube-scheduler-cka-capture-control-plane
Name:                 kube-scheduler-cka-capture-control-plane
Namespace:            kube-system
Priority:             2000001000
Priority Class Name:  system-node-critical
Node:                 cka-capture-control-plane/172.18.0.4
Start Time:           Mon, 09 Nov 2026 01:45:05 +0000
Labels:               component=kube-scheduler
                      tier=control-plane
Annotations:          kubernetes.io/config.hash: 242e8fef503050463310be97720b880c
                      kubernetes.io/config.mirror: 242e8fef503050463310be97720b880c
                      kubernetes.io/config.seen: 2026-11-09T01:46:49.820589008Z
                      kubernetes.io/config.source: file
Status:               Pending
SeccompProfile:       RuntimeDefault
IP:                   172.18.0.4
IPs:
  IP:           172.18.0.4
Controlled By:  Node/cka-capture-control-plane
Containers:
  kube-scheduler:
    Container ID:  
    Image:         registry.k8s.io/kube-scheduler:v1.37.99
    Image ID:      
    Port:          10259/TCP (probe-port)
    Host Port:     10259/TCP (probe-port)
    Command:
      kube-scheduler
      --authentication-kubeconfig=/etc/kubernetes/scheduler.conf
      --authorization-kubeconfig=/etc/kubernetes/scheduler.conf
      --bind-address=127.0.0.1
      --kubeconfig=/etc/kubernetes/scheduler.conf
      --leader-elect=true
    State:          Waiting
      Reason:       ImagePullBackOff
    Ready:          False
[... trimmed 11 lines ...]
  PodReadyToStartContainers   True 
  Initialized                 True 
  Ready                       False 
  ContainersReady             False 
  PodScheduled                True 
Volumes:
  kubeconfig:
    Type:          HostPath (bare host directory volume)
    Path:          /etc/kubernetes/scheduler.conf
    HostPathType:  FileOrCreate
QoS Class:         Burstable
Node-Selectors:    <none>
Tolerations:       :NoExecute op=Exists
Events:
  Type     Reason   Age                From     Message
  ----     ------   ----               ----     -------
  Normal   BackOff  19s (x2 over 42s)  kubelet  spec.containers{kube-scheduler}: Back-off pulling image "registry.k8s.io/kube-scheduler:v1.37.99"
  Warning  Failed   19s (x2 over 42s)  kubelet  spec.containers{kube-scheduler}: Error: ImagePullBackOff
  Normal   Pulling  7s (x3 over 47s)   kubelet  spec.containers{kube-scheduler}: Pulling image "registry.k8s.io/kube-scheduler:v1.37.99"
  Warning  Failed   7s (x3 over 43s)   kubelet  spec.containers{kube-scheduler}: Failed to pull image "registry.k8s.io/kube-scheduler:v1.37.99": rpc error: code = NotFound desc = failed to pull and unpack image "registry.k8s.io/kube-scheduler:v1.37.99": failed to resolve reference "registry.k8s.io/k ...[line cut]
  Warning  Failed   7s (x3 over 43s)   kubelet  spec.containers{kube-scheduler}: Error: ErrImagePull
[exit 0]
```

```
[cka-capture-control-plane]$ journalctl -u kubelet --no-pager | grep -i scheduler | tail -20
Nov 09 01:45:06 cka-capture-control-plane kubelet[771]: I1109 01:45:06.052657     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kubeconfig\" (UniqueName: \"kubernetes.io/host-path/c7c077ca3b88e79262b650020a12349a-kubeconfig\") pod \"kube-schedul ...[line cut]
Nov 09 01:45:16 cka-capture-control-plane kubelet[771]: I1109 01:45:16.247770     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/kube-scheduler-cka-capture-control-plane" podStartSLOduration=11.247745738 podStartE2EDuration="11.247745738s" totalImagesPulling ...[line cut]
Nov 09 01:46:49 cka-capture-control-plane kubelet[771]: I1109 01:46:49.860085     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kubeconfig\" (UniqueName: \"kubernetes.io/host-path/242e8fef503050463310be97720b880c-kubeconfig\") pod \"kube-schedul ...[line cut]
Nov 09 01:47:04 cka-capture-control-plane kubelet[771]: I1109 01:47:04.139002     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-scheduler-cka-capture-control-plane" podUID="fcc560d0-45a3-4374-a981-ca471286f8b6"
Nov 09 01:47:04 cka-capture-control-plane kubelet[771]: I1109 01:47:04.150957     771 kubelet.go:3568] "Deleted mirror pod as it didn't match the static Pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:47:04 cka-capture-control-plane kubelet[771]: I1109 01:47:04.150979     771 kubelet.go:3579] "Creating a mirror pod for static pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:47:08 cka-capture-control-plane kubelet[771]: E1109 01:47:08.724521     771 remote_image.go:334] "PullImage from image service failed" err="rpc error: code = NotFound desc = failed to pull and unpack image \"registry.k8s.io/kube-scheduler:v1.37.99\": failed to resolve reference \"registry. ...[line cut]
Nov 09 01:47:08 cka-capture-control-plane kubelet[771]: E1109 01:47:08.724580     771 kuberuntime_image.go:43] "Failed to pull image" err="rpc error: code = NotFound desc = failed to pull and unpack image \"registry.k8s.io/kube-scheduler:v1.37.99\": failed to resolve reference \"registry.k8s.io/kube ...[line cut]
Nov 09 01:47:08 cka-capture-control-plane kubelet[771]: E1109 01:47:08.724908     771 kuberuntime_manager.go:1854] "Unhandled Error" err="container kube-scheduler start failed in pod kube-scheduler-cka-capture-control-plane_kube-system(242e8fef503050463310be97720b880c): ErrImagePull: rpc error: code ...[line cut]
Nov 09 01:47:08 cka-capture-control-plane kubelet[771]: E1109 01:47:08.724985     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with ErrImagePull: \"rpc error: code = NotFound desc = failed to pull and unpack image \\\"registry.k8s.io ...[line cut]
Nov 09 01:47:09 cka-capture-control-plane kubelet[771]: E1109 01:47:09.439117     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with ImagePullBackOff: \"Back-off pulling image \\\"registry.k8s.io/kube-scheduler:v1.37.99\\\": ErrImageP ...[line cut]
Nov 09 01:47:21 cka-capture-control-plane kubelet[771]: E1109 01:47:21.393988     771 remote_image.go:334] "PullImage from image service failed" err="rpc error: code = NotFound desc = failed to pull and unpack image \"registry.k8s.io/kube-scheduler:v1.37.99\": failed to resolve reference \"registry. ...[line cut]
Nov 09 01:47:21 cka-capture-control-plane kubelet[771]: E1109 01:47:21.394058     771 kuberuntime_image.go:43] "Failed to pull image" err="rpc error: code = NotFound desc = failed to pull and unpack image \"registry.k8s.io/kube-scheduler:v1.37.99\": failed to resolve reference \"registry.k8s.io/kube ...[line cut]
Nov 09 01:47:21 cka-capture-control-plane kubelet[771]: E1109 01:47:21.394316     771 kuberuntime_manager.go:1854] "Unhandled Error" err="container kube-scheduler start failed in pod kube-scheduler-cka-capture-control-plane_kube-system(242e8fef503050463310be97720b880c): ErrImagePull: rpc error: code ...[line cut]
Nov 09 01:47:21 cka-capture-control-plane kubelet[771]: E1109 01:47:21.394377     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with ErrImagePull: \"rpc error: code = NotFound desc = failed to pull and unpack image \\\"registry.k8s.io ...[line cut]
Nov 09 01:47:32 cka-capture-control-plane kubelet[771]: E1109 01:47:32.135296     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with ImagePullBackOff: \"Back-off pulling image \\\"registry.k8s.io/kube-scheduler:v1.37.99\\\": ErrImageP ...[line cut]
Nov 09 01:47:44 cka-capture-control-plane kubelet[771]: E1109 01:47:44.403032     771 remote_image.go:334] "PullImage from image service failed" err="rpc error: code = NotFound desc = failed to pull and unpack image \"registry.k8s.io/kube-scheduler:v1.37.99\": failed to resolve reference \"registry. ...[line cut]
Nov 09 01:47:44 cka-capture-control-plane kubelet[771]: E1109 01:47:44.403093     771 kuberuntime_image.go:43] "Failed to pull image" err="rpc error: code = NotFound desc = failed to pull and unpack image \"registry.k8s.io/kube-scheduler:v1.37.99\": failed to resolve reference \"registry.k8s.io/kube ...[line cut]
Nov 09 01:47:44 cka-capture-control-plane kubelet[771]: E1109 01:47:44.403411     771 kuberuntime_manager.go:1854] "Unhandled Error" err="container kube-scheduler start failed in pod kube-scheduler-cka-capture-control-plane_kube-system(242e8fef503050463310be97720b880c): ErrImagePull: rpc error: code ...[line cut]
Nov 09 01:47:44 cka-capture-control-plane kubelet[771]: E1109 01:47:44.403455     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with ErrImagePull: \"rpc error: code = NotFound desc = failed to pull and unpack image \\\"registry.k8s.io ...[line cut]
[exit 0]
```

```
$ kubectl run test3b --image=nginx:1.27
pod/test3b created
[exit 0]
```

```
$ kubectl get pods test3b -o wide
NAME     READY   STATUS    RESTARTS   AGE   IP       NODE     NOMINATED NODE   READINESS GATES
test3b   0/1     Pending   0          15s   <none>   <none>   <none>           <none>
[exit 0]
```

```
$ kubectl describe pod test3b
Name:             test3b
Namespace:        default
Priority:         0
Service Account:  default
Node:             <none>
Labels:           run=test3b
Annotations:      <none>
Status:           Pending
IP:               
IPs:              <none>
Containers:
  test3b:
    Image:        nginx:1.27
    Port:         <none>
    Host Port:    <none>
    Environment:  <none>
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-mxgj7 (ro)
Volumes:
  kube-api-access-mxgj7:
    Type:                    Projected (a volume that contains injected data from multiple sources)
    TokenExpirationSeconds:  3607
    ConfigMapName:           kube-root-ca.crt
    Optional:                false
    DownwardAPI:             true
QoS Class:                   BestEffort
Node-Selectors:              <none>
Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s
Events:                      <none>
[exit 0]
```


*TIMER RESET: restore*

```
[cka-capture-control-plane]$ cp -p /root/cka-capture/kube-scheduler.yaml /etc/kubernetes/manifests/kube-scheduler.yaml; date -u +%T
01:48:06
[exit 0]

--- t+0s
NAME                                       READY   STATUS         RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     ErrImagePull   0          62s
NAME     READY   STATUS    RESTARTS   AGE
test3b   0/1     Pending   0          15s
--- t+5s
NAME                                       READY   STATUS         RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     ErrImagePull   0          67s
NAME     READY   STATUS    RESTARTS   AGE
test3b   0/1     Pending   0          20s
--- t+10s
NAME                                       READY   STATUS         RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     ErrImagePull   0          72s
NAME     READY   STATUS    RESTARTS   AGE
test3b   0/1     Pending   0          25s
--- t+15s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     Running   0          2s
NAME     READY   STATUS    RESTARTS   AGE
test3b   1/1     Running   0          31s
--- t+21s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     Running   0          7s
NAME     READY   STATUS    RESTARTS   AGE
test3b   1/1     Running   0          36s
--- t+26s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          12s
NAME     READY   STATUS    RESTARTS   AGE
test3b   1/1     Running   0          41s
--- t+31s
NAME                                       READY   STATUS    RESTARTS   AGE
[... trimmed 46 lines ...]
NAME     READY   STATUS    RESTARTS   AGE
test3b   1/1     Running   0          92s
--- t+82s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          68s
NAME     READY   STATUS    RESTARTS   AGE
test3b   1/1     Running   0          97s
--- t+87s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          73s
NAME     READY   STATUS    RESTARTS   AGE
test3b   1/1     Running   0          102s
--- t+92s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          79s
NAME     READY   STATUS    RESTARTS   AGE
test3b   1/1     Running   0          108s
--- t+98s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          84s
NAME     READY   STATUS    RESTARTS   AGE
test3b   1/1     Running   0          113s
```

```
$ kubectl delete pod test3b --now
pod "test3b" deleted from default namespace
[exit 0]
```


Observations (3b):
- Edit at 01:46:49. At t+0 the old container shows `Exited`; by t+5 s `crictl ps -a` shows **no scheduler container at all** (the container was removed, and no new one is ever created because the image cannot be pulled), but `crictl pods` shows the pod sandbox `Ready`. There is therefore **nothing for `crictl logs` to read**; the evidence is in `kubectl describe pod` and the kubelet journal.
- `kubectl get pods -n kube-system` ~46 s after the edit: `kube-scheduler-cka-capture-control-plane   0/1   ImagePullBackOff   0   46s` (the mirror pod is recreated by the kubelet at ~t+15 s with age counting from then; the status alternates `ErrImagePull` / `ImagePullBackOff`, e.g. `ErrImagePull` at 62 s).
- `kubectl describe pod` Events: `Normal BackOff ... Back-off pulling image "registry.k8s.io/kube-scheduler:v1.37.99"`, `Warning Failed ... Error: ImagePullBackOff`, `Normal Pulling`, `Warning Failed ... Failed to pull image "registry.k8s.io/kube-scheduler:v1.37.99": rpc error: code = NotFound desc = failed to pull and unpack image ...`, `Warning Failed ... Error: ErrImagePull`. The container state is `Waiting`, Reason `ImagePullBackOff`; `Container ID:` empty.
- Kubelet journal: `Failed to pull image ... code = NotFound`, `container kube-scheduler start failed in pod kube-scheduler-...`, `Error syncing pod, skipping ... with ErrImagePull` / `ImagePullBackOff`.
- Test pod `test3b`: `Pending`, `Node: <none>`, `Events: <none>`.
- **Restore** at 01:48:06: still `ErrImagePull` at t+10 s, `0/1 Running` at t+15 s, `1/1 Running` at t+26 s; `test3b` was `Running` at t+15 s.

### 3c: wrong command flag (`--kubeconfig=/etc/kubernetes/schedulr.conf`)


*TIMER RESET: edit*

```
[cka-capture-control-plane]$ sed -i 's#--kubeconfig=/etc/kubernetes/scheduler.conf#--kubeconfig=/etc/kubernetes/schedulr.conf#' /etc/kubernetes/manifests/kube-scheduler.yaml; grep -n schedulr /etc/kubernetes/manifests/kube-scheduler.yaml; date -u +%T
16:    - --kubeconfig=/etc/kubernetes/schedulr.conf
01:49:50
[exit 0]

--- t+0s
CONTAINER           IMAGE               CREATED              STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
0c446c1e4132e       1fabf80a1273a       About a minute ago   Exited              kube-scheduler            0                   4d6b58cb3b5a1       kube-scheduler-cka-capture-control-plane            kube-system
--- t+5s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+10s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
--- t+15s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
e8eeae04b3332       1fabf80a1273a       2 seconds ago       Exited              kube-scheduler            1                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+20s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
e8eeae04b3332       1fabf80a1273a       7 seconds ago       Exited              kube-scheduler            1                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+25s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
77303cdd281da       1fabf80a1273a       1 second ago        Exited              kube-scheduler            2                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+30s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
77303cdd281da       1fabf80a1273a       6 seconds ago       Exited              kube-scheduler            2                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+35s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
77303cdd281da       1fabf80a1273a       11 seconds ago      Exited              kube-scheduler            2                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+40s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
77303cdd281da       1fabf80a1273a       16 seconds ago      Exited              kube-scheduler            2                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+45s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
77303cdd281da       1fabf80a1273a       21 seconds ago      Exited              kube-scheduler            2                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+51s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
77303cdd281da       1fabf80a1273a       26 seconds ago      Exited              kube-scheduler            2                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+56s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
c4f15ae403722       1fabf80a1273a       4 seconds ago       Exited              kube-scheduler            3                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+61s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
c4f15ae403722       1fabf80a1273a       10 seconds ago      Exited              kube-scheduler            3                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+66s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
c4f15ae403722       1fabf80a1273a       15 seconds ago      Exited              kube-scheduler            3                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
--- t+71s
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
c4f15ae403722       1fabf80a1273a       20 seconds ago      Exited              kube-scheduler            3                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
```

```
[cka-capture-control-plane]$ crictl ps -a | grep -E 'CONTAINER|scheduler'
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
c4f15ae403722       1fabf80a1273a       25 seconds ago      Exited              kube-scheduler            3                   84870e36d8d9e       kube-scheduler-cka-capture-control-plane            kube-system
[exit 0]
```

```
[cka-capture-control-plane]$ id=$(crictl ps -a --name kube-scheduler -q | head -1); echo container $id; crictl logs $id 2>&1 | tail -20
container c4f15ae403722e8a314819f32d9858ae35c27967f1a7e306abb2c8c4eb9084b5
I1109 01:50:41.351855       1 serving.go:411] Generated self-signed cert in-memory
E1109 01:50:41.352005       1 run.go:72] "command failed" err="stat /etc/kubernetes/schedulr.conf: no such file or directory"
[exit 0]
```

```
$ kubectl get pods -n kube-system
NAME                                                READY   STATUS             RESTARTS      AGE
coredns-559f6c778d-5t9j5                            1/1     Running            0             19m
coredns-559f6c778d-mkr68                            1/1     Running            0             19m
etcd-cka-capture-control-plane                      1/1     Running            0             19m
kindnet-psznp                                       1/1     Running            0             19m
kindnet-qfzz2                                       1/1     Running            0             19m
kube-apiserver-cka-capture-control-plane            1/1     Running            0             19m
kube-controller-manager-cka-capture-control-plane   1/1     Running            0             19m
kube-proxy-7v5f9                                    1/1     Running            0             19m
kube-proxy-hjhpc                                    1/1     Running            0             19m
kube-scheduler-cka-capture-control-plane            0/1     CrashLoopBackOff   3 (25s ago)   64s
[exit 0]
```

```
$ kubectl run test3c --image=nginx:1.27
pod/test3c created
[exit 0]
```

```
$ kubectl get pods test3c -o wide
NAME     READY   STATUS    RESTARTS   AGE   IP       NODE     NOMINATED NODE   READINESS GATES
test3c   0/1     Pending   0          10s   <none>   <none>   <none>           <none>
[exit 0]
```

```
$ kubectl describe pod test3c
Name:             test3c
Namespace:        default
Priority:         0
Service Account:  default
Node:             <none>
Labels:           run=test3c
Annotations:      <none>
Status:           Pending
IP:               
IPs:              <none>
Containers:
  test3c:
    Image:        nginx:1.27
    Port:         <none>
    Host Port:    <none>
    Environment:  <none>
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-7xfrk (ro)
Volumes:
  kube-api-access-7xfrk:
    Type:                    Projected (a volume that contains injected data from multiple sources)
    TokenExpirationSeconds:  3607
    ConfigMapName:           kube-root-ca.crt
    Optional:                false
    DownwardAPI:             true
QoS Class:                   BestEffort
Node-Selectors:              <none>
Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s
Events:                      <none>
[exit 0]
```

```
[cka-capture-control-plane]$ journalctl -u kubelet --no-pager | grep -i scheduler | tail -20
Nov 09 01:47:58 cka-capture-control-plane kubelet[771]: E1109 01:47:58.135174     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with ImagePullBackOff: \"Back-off pulling image \\\"registry.k8s.io/kube-scheduler:v1.37.99\\\": ErrImageP ...[line cut]
Nov 09 01:48:06 cka-capture-control-plane kubelet[771]: I1109 01:48:06.511511     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kubeconfig\" (UniqueName: \"kubernetes.io/host-path/c7c077ca3b88e79262b650020a12349a-kubeconfig\") pod \"kube-schedul ...[line cut]
Nov 09 01:48:20 cka-capture-control-plane kubelet[771]: I1109 01:48:20.138572     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-scheduler-cka-capture-control-plane" podUID="d9046d55-5854-4d0a-9a05-732aae20ba41"
Nov 09 01:48:20 cka-capture-control-plane kubelet[771]: I1109 01:48:20.156801     771 kubelet.go:3568] "Deleted mirror pod as it didn't match the static Pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:48:20 cka-capture-control-plane kubelet[771]: I1109 01:48:20.156835     771 kubelet.go:3579] "Creating a mirror pod for static pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:48:20 cka-capture-control-plane kubelet[771]: I1109 01:48:20.498576     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/kube-scheduler-cka-capture-control-plane" podStartSLOduration=0.498560873 podStartE2EDuration="498.560873ms" totalImagesPullingTi ...[line cut]
Nov 09 01:49:50 cka-capture-control-plane kubelet[771]: I1109 01:49:50.287660     771 reconciler_common.go:251] "operationExecutor.VerifyControllerAttachedVolume started for volume \"kubeconfig\" (UniqueName: \"kubernetes.io/host-path/dae5182f7bf080733021ac57808c486f-kubeconfig\") pod \"kube-schedul ...[line cut]
Nov 09 01:50:02 cka-capture-control-plane kubelet[771]: I1109 01:50:02.139347     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-scheduler-cka-capture-control-plane" podUID="e4a0abcc-eee1-44fe-990a-785a05e9f7c7"
Nov 09 01:50:02 cka-capture-control-plane kubelet[771]: I1109 01:50:02.159207     771 kubelet.go:3568] "Deleted mirror pod as it didn't match the static Pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:50:02 cka-capture-control-plane kubelet[771]: I1109 01:50:02.159248     771 kubelet.go:3579] "Creating a mirror pod for static pod" pod="kube-system/kube-scheduler-cka-capture-control-plane"
Nov 09 01:50:02 cka-capture-control-plane kubelet[771]: I1109 01:50:02.443167     771 pod_startup_latency_tracker.go:144] "Observed pod startup duration" pod="kube-system/kube-scheduler-cka-capture-control-plane" podStartSLOduration=0.44315209 podStartE2EDuration="443.15209ms" totalImagesPullingTime ...[line cut]
Nov 09 01:50:03 cka-capture-control-plane kubelet[771]: E1109 01:50:03.836241     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 10s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
Nov 09 01:50:04 cka-capture-control-plane kubelet[771]: E1109 01:50:04.840290     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 10s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
Nov 09 01:50:12 cka-capture-control-plane kubelet[771]: E1109 01:50:12.177735     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 10s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
Nov 09 01:50:12 cka-capture-control-plane kubelet[771]: E1109 01:50:12.858500     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 10s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
Nov 09 01:50:14 cka-capture-control-plane kubelet[771]: E1109 01:50:14.868739     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 20s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
Nov 09 01:50:15 cka-capture-control-plane kubelet[771]: E1109 01:50:15.873261     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 20s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
Nov 09 01:50:22 cka-capture-control-plane kubelet[771]: E1109 01:50:22.176604     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 20s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
Nov 09 01:50:41 cka-capture-control-plane kubelet[771]: E1109 01:50:41.933212     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 40s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
Nov 09 01:50:42 cka-capture-control-plane kubelet[771]: E1109 01:50:42.937465     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-scheduler\" with CrashLoopBackOff: \"back-off 40s restarting failed container=kube-scheduler pod=kube-scheduler-cka-ca ...[line cut]
[exit 0]
```


*TIMER RESET: restore*

```
[cka-capture-control-plane]$ cp -p /root/cka-capture/kube-scheduler.yaml /etc/kubernetes/manifests/kube-scheduler.yaml; date -u +%T
01:51:16
[exit 0]

--- t+0s
NAME                                       READY   STATUS             RESTARTS      AGE
kube-scheduler-cka-capture-control-plane   0/1     CrashLoopBackOff   3 (36s ago)   75s
NAME     READY   STATUS    RESTARTS   AGE
test3c   0/1     Pending   0          11s
--- t+6s
NAME                                       READY   STATUS             RESTARTS      AGE
kube-scheduler-cka-capture-control-plane   0/1     CrashLoopBackOff   3 (41s ago)   80s
NAME     READY   STATUS    RESTARTS   AGE
test3c   0/1     Pending   0          16s
--- t+11s
NAME                                       READY   STATUS             RESTARTS      AGE
kube-scheduler-cka-capture-control-plane   0/1     CrashLoopBackOff   3 (46s ago)   85s
NAME     READY   STATUS    RESTARTS   AGE
test3c   0/1     Pending   0          21s
--- t+16s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     Running   0          2s
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          26s
--- t+21s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   0/1     Running   0          7s
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          31s
--- t+26s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          12s
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          36s
--- t+31s
NAME                                       READY   STATUS    RESTARTS   AGE
[... trimmed 88 lines ...]
--- t+124s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          110s
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          2m14s
--- t+129s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          115s
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          2m19s
--- t+134s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          2m
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          2m24s
--- t+139s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          2m5s
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          2m29s
--- t+144s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          2m10s
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          2m34s
--- t+149s
NAME                                       READY   STATUS    RESTARTS   AGE
kube-scheduler-cka-capture-control-plane   1/1     Running   0          2m15s
NAME     READY   STATUS    RESTARTS   AGE
test3c   1/1     Running   0          2m39s
```

```
$ kubectl delete pod test3c --now
pod "test3c" deleted from default namespace
[exit 0]
```

```
$ kubectl get pods -n kube-system
NAME                                                READY   STATUS    RESTARTS   AGE
coredns-559f6c778d-5t9j5                            1/1     Running   0          21m
coredns-559f6c778d-mkr68                            1/1     Running   0          21m
etcd-cka-capture-control-plane                      1/1     Running   0          21m
kindnet-psznp                                       1/1     Running   0          21m
kindnet-qfzz2                                       1/1     Running   0          21m
kube-apiserver-cka-capture-control-plane            1/1     Running   0          21m
kube-controller-manager-cka-capture-control-plane   1/1     Running   0          21m
kube-proxy-7v5f9                                    1/1     Running   0          21m
kube-proxy-hjhpc                                    1/1     Running   0          21m
kube-scheduler-cka-capture-control-plane            1/1     Running   0          2m21s
[exit 0]
```


Observations (3c):
- Edit at ~01:49:50. The mirror pod was recreated by the kubelet at 01:50:02 (~12 s after the edit) and the container immediately exited. `crictl ps -a` shows `Exited` containers with incrementing ATTEMPT (1, 2, 3 at about 15 s, 25 s, 56 s after the edit), each living ~1 s. First `CrashLoopBackOff` in the kubelet journal at 01:50:03 (`back-off 10s`), then `back-off 20s` (01:50:14), then `back-off 40s` (01:50:41).
- `crictl logs <exited id>` is where the cause lives (exact output):

```
I1109 01:50:41.351855       1 serving.go:411] Generated self-signed cert in-memory
E1109 01:50:41.352005       1 run.go:72] "command failed" err="stat /etc/kubernetes/schedulr.conf: no such file or directory"
```

- `kubectl get pods -n kube-system` ~64 s after the edit: `kube-scheduler-cka-capture-control-plane   0/1   CrashLoopBackOff   3 (25s ago)   64s`.
- Test pod `test3c` `Pending`, `Events: <none>` again. `kubectl logs -n kube-system kube-scheduler-...` was not captured; use `crictl logs` as shown.
- **Restore** at 01:51:16: `CrashLoopBackOff` persisted for ~11 s, then `0/1 Running` at t+16 s and `1/1 Running` at t+26 s; `test3c` became `Running` at t+16 s. (Restoring the manifest resets the backoff because the kubelet treats the changed file as a new pod.)

## Scenario 4: kube-apiserver static pod manifest broken (control plane)

Manifest `/etc/kubernetes/manifests/kube-apiserver.yaml`, original lines: `--etcd-servers=https://127.0.0.1:2379`, `--secure-port=6443`, `--tls-cert-file=/etc/kubernetes/pki/apiserver.crt`, `image: registry.k8s.io/kube-apiserver:v1.37.0`. Remember the host-vs-in-node kubectl caveat in the header.

### 4a: wrong `--etcd-servers` port (2379 -> 2399)

```
$ kubectl get nodes
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   22m   v1.37.0
cka-capture-worker          Ready    <none>          21m   v1.37.0
[exit 0]
```


*TIMER RESET: edit*

```
[cka-capture-control-plane]$ sed -i 's#--etcd-servers=https://127.0.0.1:2379#--etcd-servers=https://127.0.0.1:2399#' /etc/kubernetes/manifests/kube-apiserver.yaml; grep -n etcd-servers /etc/kubernetes/manifests/kube-apiserver.yaml; date -u +%T
24:    - --etcd-servers=https://127.0.0.1:2399
01:53:51
[exit 0]

--- t+0s
Unable to connect to the server: EOF
--- t+15s
Unable to connect to the server: EOF
--- t+30s
Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": net/http: TLS handshake timeout - error from a previous attempt: EOF
--- t+53s
Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": net/http: TLS handshake timeout - error from a previous attempt: EOF
--- t+73s
Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": read tcp 127.0.0.1:52472->127.0.0.1:39435: read: connection reset by peer - error from a previous attempt: EOF
--- t+93s
Unable to connect to the server: net/http: TLS handshake timeout
--- t+108s
Unable to connect to the server: EOF
```

```
[cka-capture-control-plane]$ crictl ps -a | grep -E 'CONTAINER|apiserver|etcd'
CONTAINER           IMAGE               CREATED              STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
fb3f9ebcb44df       bec5f0e1e2eeb       35 seconds ago       Exited              kube-apiserver            2                   0c784bb4a2d84       kube-apiserver-cka-capture-control-plane            kube-system
9c67053dea619       270fbeb697171       24 minutes ago       Running             etcd                      0                   b69851da3fb0e       etcd-cka-capture-control-plane                      kube-system
[exit 0]
```

```
[cka-capture-control-plane]$ id=$(crictl ps -a --name kube-apiserver -q | head -1); echo container $id; crictl logs $id 2>&1 | tail -20
container fb3f9ebcb44df6f11721c98bacaaed1deb1150c7bd0eb245da1c192c1ff9bb90
W1109 01:55:21.478771       1 logging.go:55] [core] [Channel #1 SubChannel #4] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
I1109 01:55:21.481672       1 shared_informer.go:503] "Waiting for caches to sync" controller="node_authorizer"
E1109 01:55:21.482381       1 options.go:205] The manifest file is empty, ignoring.
W1109 01:55:21.483873       1 logging.go:55] [core] [Channel #5 SubChannel #6] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:22.480221       1 logging.go:55] [core] [Channel #2 SubChannel #3] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:22.480273       1 logging.go:55] [core] [Channel #1 SubChannel #4] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:22.484815       1 logging.go:55] [core] [Channel #5 SubChannel #6] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:23.777124       1 logging.go:55] [core] [Channel #5 SubChannel #6] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:23.824156       1 logging.go:55] [core] [Channel #2 SubChannel #3] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:23.975946       1 logging.go:55] [core] [Channel #1 SubChannel #4] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:25.903420       1 logging.go:55] [core] [Channel #5 SubChannel #6] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:26.514675       1 logging.go:55] [core] [Channel #1 SubChannel #4] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:26.770762       1 logging.go:55] [core] [Channel #2 SubChannel #3] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:29.666474       1 logging.go:55] [core] [Channel #5 SubChannel #6] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:31.032552       1 logging.go:55] [core] [Channel #2 SubChannel #3] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:31.265591       1 logging.go:55] [core] [Channel #1 SubChannel #4] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:36.657491       1 logging.go:55] [core] [Channel #5 SubChannel #6] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:37.684247       1 logging.go:55] [core] [Channel #2 SubChannel #3] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
W1109 01:55:37.865976       1 logging.go:55] [core] [Channel #1 SubChannel #4] grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ServerName: "127.0.0.1:2399", }. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref ...[line cut]
E1109 01:55:41.484118       1 run.go:72] "command failed" err="error creating storage factory: etcd grpc connection not ready: context deadline exceeded"
[exit 0]
```

```
[cka-capture-control-plane]$ journalctl -u kubelet --no-pager --since '-120s' | grep -i apiserver | tail -12 | cut -c1-400
Nov 09 01:55:41 cka-capture-control-plane kubelet[771]: I1109 01:55:41.629482     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-apiserver-cka-capture-control-plane" podUID="dd5a1f56-0b70-468f-9c65-855c35402347"
Nov 09 01:55:41 cka-capture-control-plane kubelet[771]: E1109 01:55:41.629881     771 mirror_client.go:139] "Failed deleting a mirror pod" err="Delete \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connectio ...[line cut]
Nov 09 01:55:41 cka-capture-control-plane kubelet[771]: E1109 01:55:41.630182     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-apiserver\" with CrashLoopBackOff: \"back-off 20s restarting failed container=kube-apiserver pod=kube-apiserver-cka-ca ...[line cut]
Nov 09 01:55:42 cka-capture-control-plane kubelet[771]: E1109 01:55:42.492893     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:55:42 cka-capture-control-plane kubelet[771]: E1109 01:55:42.493770     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:55:43 cka-capture-control-plane kubelet[771]: E1109 01:55:43.134305     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:55:47 cka-capture-control-plane kubelet[771]: E1109 01:55:47.776490     771 event.go:374] "Unable to write event (may retry after sleeping)" err="Post \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/events\": dial tcp 172.18.0.4:6443: connect: connection refused" event="&Event{Obje ...[line cut]
Nov 09 01:55:48 cka-capture-control-plane kubelet[771]: I1109 01:55:48.147058     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-apiserver-cka-capture-control-plane" podUID="dd5a1f56-0b70-468f-9c65-855c35402347"
Nov 09 01:55:48 cka-capture-control-plane kubelet[771]: E1109 01:55:48.147390     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:55:48 cka-capture-control-plane kubelet[771]: E1109 01:55:48.147446     771 mirror_client.go:139] "Failed deleting a mirror pod" err="Delete \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connectio ...[line cut]
Nov 09 01:55:48 cka-capture-control-plane kubelet[771]: E1109 01:55:48.147837     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-apiserver\" with CrashLoopBackOff: \"back-off 20s restarting failed container=kube-apiserver pod=kube-apiserver-cka-ca ...[line cut]
Nov 09 01:55:53 cka-capture-control-plane kubelet[771]: E1109 01:55:53.134199     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
[exit 0]

--- kubectl from host, verbose-free full error:
```

```
$ kubectl get nodes
Unable to connect to the server: EOF
[exit 1]
```

```
$ kubectl get pods -n kube-system
Get "https://127.0.0.1:39435/api/v1/namespaces/kube-system/pods?limit=500": net/http: TLS handshake timeout - error from a previous attempt: EOF
[exit 1]
```

```
[cka-capture-control-plane]$ kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes
Get "https://cka-capture-control-plane:6443/api/v1/nodes?limit=500": dial tcp 172.18.0.4:6443: connect: connection refused - error from a previous attempt: read tcp 172.18.0.4:43174->172.18.0.4:6443: read: connection reset by peer
[exit 1]
```


*TIMER RESET: restore*

```
[cka-capture-control-plane]$ cp -p /root/cka-capture/kube-apiserver.yaml /etc/kubernetes/manifests/kube-apiserver.yaml; date -u +%T
01:56:29
[exit 0]

--- t+10s: Unable to connect to the server: EOF
--- t+17s: Error from server (Forbidden): nodes is forbidden: User "kubernetes-admin" cannot list resource "nodes" in API group "" at the cluster scope
--- t+22s: NAME                        STATUS   ROLES           AGE   VERSION
RECOVERED at t+22s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   25m   v1.37.0
cka-capture-worker          Ready    <none>          24m   v1.37.0
```

```
$ kubectl get nodes
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   25m   v1.37.0
cka-capture-worker          Ready    <none>          24m   v1.37.0
[exit 0]
```

```
$ kubectl get pods -n kube-system
NAME                                                READY   STATUS    RESTARTS   AGE
coredns-559f6c778d-5t9j5                            1/1     Running   0          24m
coredns-559f6c778d-mkr68                            1/1     Running   0          24m
etcd-cka-capture-control-plane                      1/1     Running   0          24m
kindnet-psznp                                       1/1     Running   0          24m
kindnet-qfzz2                                       1/1     Running   0          24m
kube-apiserver-cka-capture-control-plane            1/1     Running   0          24m
kube-controller-manager-cka-capture-control-plane   1/1     Running   0          24m
kube-proxy-7v5f9                                    1/1     Running   0          24m
kube-proxy-hjhpc                                    1/1     Running   0          24m
kube-scheduler-cka-capture-control-plane            1/1     Running   0          5m21s
[exit 0]
```


Observations (4a):
- Edit at 01:53:51. Host kubectl output during the following 2 minutes (one try every ~15 s): `Unable to connect to the server: EOF` at t+0 and t+15 s, then `Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": net/http: TLS handshake timeout - error from a previous attempt: EOF` (t+30, t+53), `...read: connection reset by peer - error from a previous attempt: EOF` (t+73), `Unable to connect to the server: net/http: TLS handshake timeout` (t+93), `Unable to connect to the server: EOF` (t+108). Inside the node, with admin.conf: `Get "https://cka-capture-control-plane:6443/api/v1/nodes?limit=500": dial tcp 172.18.0.4:6443: connect: connection refused - error from a previous attempt: read tcp 172.18.0.4:43174->172.18.0.4:6443: read: connection reset by peer`.
- The apiserver does not exit instantly: it starts, tries etcd for ~20 s, then dies. `crictl ps -a` at ~2 min: `kube-apiserver ... Exited`, ATTEMPT 2 (about 35 s old); etcd stays `Running`. `crictl logs` of the exited apiserver (last 20 lines) are mostly `grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2399", ...}. Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2399: connect: connection ref...` and the last line is `E1109 01:55:41.484118       1 run.go:72] "command failed" err="error creating storage factory: etcd grpc connection not ready: context deadline exceeded"`.
- Kubelet journal: `Failed deleting a mirror pod ... dial tcp 172.18.0.4:6443: connect: connection refused`, `Error syncing pod, skipping ... "StartContainer" for "kube-apiserver" with CrashLoopBackOff: "back-off 20s restarting failed container=kube-apiserver ..."`, `Failed to get status for pod`, `Unable to write event (may retry after sleeping)`.
- **Restore** at 01:56:29: kubectl returned `EOF` at t+10 s, then `Error from server (Forbidden): nodes is forbidden: User "kubernetes-admin" cannot list resource "nodes" in API group "" at the cluster scope` at t+17 s (apiserver up, RBAC/authorizer not yet synced; a transient), and the normal node list at t+22 s. **Recovery ~22 s.**

### 4b: wrong `--secure-port` (6443 -> 6444)


*TIMER RESET: edit*

```
[cka-capture-control-plane]$ sed -i 's#--secure-port=6443#--secure-port=6444#' /etc/kubernetes/manifests/kube-apiserver.yaml; grep -n secure-port /etc/kubernetes/manifests/kube-apiserver.yaml; date -u +%T
35:    - --secure-port=6444
01:56:51
[exit 0]

--- t+0s
Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": EOF - error from a previous attempt: read tcp 127.0.0.1:56496->127.0.0.1:39435: read: connection reset by peer
--- t+15s
Unable to connect to the server: EOF
--- t+30s
Unable to connect to the server: EOF
--- t+46s
Unable to connect to the server: EOF
--- t+61s
Unable to connect to the server: EOF
```

```
[cka-capture-control-plane]$ crictl ps -a | grep -E 'CONTAINER|apiserver'
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
630644fdff07d       bec5f0e1e2eeb       31 seconds ago      Running             kube-apiserver            0                   d6d68d5825e7b       kube-apiserver-cka-capture-control-plane            kube-system
[exit 0]
```

```
[cka-capture-control-plane]$ id=$(crictl ps -a --name kube-apiserver -q | head -1); echo container $id; crictl logs $id 2>&1 | tail -20
container 630644fdff07dec54f0eb88ea248ae6cffcf8e83d12e8d80022bb10e07d15a40
I1109 01:57:36.647888       1 apf_controller.go:385] Running API Priority and Fairness periodic rebalancing process
I1109 01:57:36.647950       1 shared_informer.go:531] "Caches are synced"
I1109 01:57:36.647971       1 cache.go:39] Caches are synced for LocalAvailability controller
I1109 01:57:36.648108       1 cache.go:39] Caches are synced for APIServiceRegistrationController controller
I1109 01:57:36.648354       1 shared_informer.go:531] "Caches are synced"
I1109 01:57:36.649374       1 cache.go:39] Caches are synced for RemoteAvailability controller
I1109 01:57:36.649432       1 shared_informer.go:510] "Caches are synced" controller="ipallocator-repair-controller"
I1109 01:57:36.649446       1 shared_informer.go:510] "Caches are synced" controller="crd-autoregister"
I1109 01:57:36.649485       1 aggregator.go:187] initial CRD sync complete...
I1109 01:57:36.649498       1 autoregister_controller.go:144] Starting autoregister controller
I1109 01:57:36.649503       1 cache.go:32] Waiting for caches to sync for autoregister controller
I1109 01:57:36.649508       1 cache.go:39] Caches are synced for autoregister controller
I1109 01:57:36.649527       1 shared_informer.go:531] "Caches are synced"
I1109 01:57:36.649569       1 shared_informer.go:531] "Caches are synced"
I1109 01:57:36.652684       1 handler_discovery.go:450] Starting ResourceDiscoveryManager
I1109 01:57:36.669711       1 controller.go:667] quota admission added evaluator for: leases.coordination.k8s.io
I1109 01:57:37.552674       1 storage_scheduling.go:205] all system priority classes are created successfully or already exist.
W1109 01:57:37.861393       1 lease.go:270] Resetting endpoints for master service "kubernetes" to [172.18.0.4]
I1109 01:57:37.863053       1 controller.go:667] quota admission added evaluator for: endpoints
I1109 01:57:37.874685       1 controller.go:667] quota admission added evaluator for: endpointslices.discovery.k8s.io
[exit 0]
```

```
[cka-capture-control-plane]$ journalctl -u kubelet --no-pager --since '-75s' | grep -i apiserver | tail -12 | cut -c1-400
Nov 09 01:57:35 cka-capture-control-plane kubelet[771]: E1109 01:57:35.417222     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:57:35 cka-capture-control-plane kubelet[771]: E1109 01:57:35.417231     771 mirror_client.go:139] "Failed deleting a mirror pod" err="Delete \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connectio ...[line cut]
Nov 09 01:57:36 cka-capture-control-plane kubelet[771]: I1109 01:57:36.145219     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-apiserver-cka-capture-control-plane" podUID="dd5a1f56-0b70-468f-9c65-855c35402347"
Nov 09 01:57:36 cka-capture-control-plane kubelet[771]: E1109 01:57:36.145676     771 mirror_client.go:139] "Failed deleting a mirror pod" err="Delete \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connectio ...[line cut]
Nov 09 01:57:41 cka-capture-control-plane kubelet[771]: E1109 01:57:41.215678     771 event.go:374] "Unable to write event (may retry after sleeping)" err="Post \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/events\": dial tcp 172.18.0.4:6443: connect: connection refused" event="&Event{Obje ...[line cut]
Nov 09 01:57:43 cka-capture-control-plane kubelet[771]: E1109 01:57:43.133958     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:57:45 cka-capture-control-plane kubelet[771]: I1109 01:57:45.144832     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-apiserver-cka-capture-control-plane" podUID="dd5a1f56-0b70-468f-9c65-855c35402347"
Nov 09 01:57:45 cka-capture-control-plane kubelet[771]: E1109 01:57:45.145108     771 mirror_client.go:139] "Failed deleting a mirror pod" err="Delete \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connectio ...[line cut]
Nov 09 01:57:51 cka-capture-control-plane kubelet[771]: E1109 01:57:51.217137     771 event.go:374] "Unable to write event (may retry after sleeping)" err="Post \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/events\": dial tcp 172.18.0.4:6443: connect: connection refused" event="&Event{Obje ...[line cut]
Nov 09 01:57:53 cka-capture-control-plane kubelet[771]: E1109 01:57:53.134185     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:58:01 cka-capture-control-plane kubelet[771]: E1109 01:58:01.218213     771 event.go:374] "Unable to write event (may retry after sleeping)" err="Post \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/events\": dial tcp 172.18.0.4:6443: connect: connection refused" event="&Event{Obje ...[line cut]
Nov 09 01:58:03 cka-capture-control-plane kubelet[771]: E1109 01:58:03.134701     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
[exit 0]
```

```
$ kubectl get nodes
Unable to connect to the server: EOF
[exit 1]
```

```
[cka-capture-control-plane]$ kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes
The connection to the server cka-capture-control-plane:6443 was refused - did you specify the right host or port?
[exit 1]
```

```
[cka-capture-control-plane]$ ss -tlnp | grep -E '644[0-9]|6443|2379' | sed -E 's/users:.*//'
LISTEN 0      4096      172.18.0.4:2379       0.0.0.0:*    
LISTEN 0      4096       127.0.0.1:2379       0.0.0.0:*    
LISTEN 0      4096               *:6444             *:*    
[exit 0]
```


*TIMER RESET: restore*

```
[cka-capture-control-plane]$ cp -p /root/cka-capture/kube-apiserver.yaml /etc/kubernetes/manifests/kube-apiserver.yaml; date -u +%T
01:58:17
[exit 0]

--- t+10s: Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": EOF - error from a previous attempt: read tcp 127.0.0.1:60034->127.0.0.1:39435: read: connection reset by peer
--- t+15s: NAME                        STATUS   ROLES           AGE   VERSION
RECOVERED at t+15s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   26m   v1.37.0
cka-capture-worker          Ready    <none>          26m   v1.37.0
```


Observations (4b):
- Edit at 01:56:51. The apiserver **keeps running** (it is simply listening on 6444): `crictl ps -a` shows `kube-apiserver ... Running`, ATTEMPT 0, and `crictl logs` looks healthy (caches synced). The container does NOT crash-loop. `ss -tlnp` in the node: `LISTEN ... *:6444` and no listener on 6443 (etcd 2379 still listening).
- Host kubectl: `Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": EOF - error from a previous attempt: read tcp ... connection reset by peer` at t+0, then `Unable to connect to the server: EOF`. In-node kubectl with admin.conf (exam-realistic): `The connection to the server cka-capture-control-plane:6443 was refused - did you specify the right host or port?` (exit 1).
- Kubelet journal: `Failed to get status for pod ... dial tcp 172.18.0.4:6443: connect: connection refused`, `Failed deleting a mirror pod ...`, `Unable to write event (may retry after sleeping)` repeating.
- **Restore** at 01:58:17: first poll t+10 s `...EOF`, `NAME STATUS ...` at **t+15 s**. Recovery ~15 s.

### 4c: wrong certificate path (`--tls-cert-file=/etc/kubernetes/pki/apiserver.crtt`)


*TIMER RESET: edit*

```
[cka-capture-control-plane]$ sed -i 's#--tls-cert-file=/etc/kubernetes/pki/apiserver.crt#--tls-cert-file=/etc/kubernetes/pki/apiserver.crtt#' /etc/kubernetes/manifests/kube-apiserver.yaml; grep -n tls-cert-file /etc/kubernetes/manifests/kube-apiserver.yaml; date -u +%T
40:    - --tls-cert-file=/etc/kubernetes/pki/apiserver.crtt
01:58:32
[exit 0]

--- t+0s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   26m   v1.37.0
cka-capture-worker          Ready    <none>          26m   v1.37.0
--- t+6s
Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": read tcp 127.0.0.1:44138->127.0.0.1:39435: read: connection reset by peer - error from a previous attempt: EOF
--- t+21s
Unable to connect to the server: EOF
--- t+36s
Unable to connect to the server: EOF
--- t+51s
Unable to connect to the server: EOF
```

```
[cka-capture-control-plane]$ crictl ps -a | grep -E 'CONTAINER|apiserver'
CONTAINER           IMAGE               CREATED             STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
f7fd1f28f34d9       bec5f0e1e2eeb       15 seconds ago      Exited              kube-apiserver            3                   d5714d5569090       kube-apiserver-cka-capture-control-plane            kube-system
[exit 0]
```

```
[cka-capture-control-plane]$ id=$(crictl ps -a --name kube-apiserver -q | head -1); echo container $id; crictl logs $id 2>&1 | tail -20
container f7fd1f28f34d914cef1b0372749f0ef9a4deb98dbfad738c45fdd79634974805
I1109 01:59:23.299177       1 options.go:261] external host was not specified, using 172.18.0.4
I1109 01:59:23.302607       1 server.go:151] Version: v1.37.0
I1109 01:59:23.302632       1 server.go:153] "Golang settings" GOGC="" GOMAXPROCS="" GOTRACEBACK=""
E1109 01:59:23.303012       1 run.go:72] "command failed" err="open /etc/kubernetes/pki/apiserver.crtt: no such file or directory"
[exit 0]
```

```
[cka-capture-control-plane]$ journalctl -u kubelet --no-pager --since '-60s' | grep -i apiserver | tail -12 | cut -c1-400
Nov 09 01:59:24 cka-capture-control-plane kubelet[771]: E1109 01:59:24.166236     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:59:24 cka-capture-control-plane kubelet[771]: E1109 01:59:24.166261     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-apiserver\" with CrashLoopBackOff: \"back-off 40s restarting failed container=kube-apiserver pod=kube-apiserver-cka-ca ...[line cut]
Nov 09 01:59:25 cka-capture-control-plane kubelet[771]: I1109 01:59:25.168992     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-apiserver-cka-capture-control-plane" podUID="dd5a1f56-0b70-468f-9c65-855c35402347"
Nov 09 01:59:25 cka-capture-control-plane kubelet[771]: E1109 01:59:25.169138     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:59:25 cka-capture-control-plane kubelet[771]: E1109 01:59:25.169341     771 mirror_client.go:139] "Failed deleting a mirror pod" err="Delete \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connectio ...[line cut]
Nov 09 01:59:25 cka-capture-control-plane kubelet[771]: E1109 01:59:25.169841     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-apiserver\" with CrashLoopBackOff: \"back-off 40s restarting failed container=kube-apiserver pod=kube-apiserver-cka-ca ...[line cut]
Nov 09 01:59:26 cka-capture-control-plane kubelet[771]: E1109 01:59:26.786248     771 event.go:374] "Unable to write event (may retry after sleeping)" err="Post \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/events\": dial tcp 172.18.0.4:6443: connect: connection refused" event="&Event{Obje ...[line cut]
Nov 09 01:59:33 cka-capture-control-plane kubelet[771]: E1109 01:59:33.133652     771 status_manager.go:1257] "Failed to get status for pod" err="Get \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connection ...[line cut]
Nov 09 01:59:34 cka-capture-control-plane kubelet[771]: I1109 01:59:34.144683     771 kubelet.go:3562] "Trying to delete pod" pod="kube-system/kube-apiserver-cka-capture-control-plane" podUID="dd5a1f56-0b70-468f-9c65-855c35402347"
Nov 09 01:59:34 cka-capture-control-plane kubelet[771]: E1109 01:59:34.145082     771 mirror_client.go:139] "Failed deleting a mirror pod" err="Delete \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/pods/kube-apiserver-cka-capture-control-plane\": dial tcp 172.18.0.4:6443: connect: connectio ...[line cut]
Nov 09 01:59:34 cka-capture-control-plane kubelet[771]: E1109 01:59:34.145511     771 pod_workers.go:1338] "Error syncing pod, skipping" err="failed to \"StartContainer\" for \"kube-apiserver\" with CrashLoopBackOff: \"back-off 40s restarting failed container=kube-apiserver pod=kube-apiserver-cka-ca ...[line cut]
Nov 09 01:59:36 cka-capture-control-plane kubelet[771]: E1109 01:59:36.787181     771 event.go:374] "Unable to write event (may retry after sleeping)" err="Post \"https://172.18.0.4:6443/api/v1/namespaces/kube-system/events\": dial tcp 172.18.0.4:6443: connect: connection refused" event="&Event{Obje ...[line cut]
[exit 0]
```

```
$ kubectl get nodes
Unable to connect to the server: EOF
[exit 1]
```


*TIMER RESET: restore*

```
[cka-capture-control-plane]$ cp -p /root/cka-capture/kube-apiserver.yaml /etc/kubernetes/manifests/kube-apiserver.yaml; date -u +%T
01:59:48
[exit 0]

--- t+10s: Unable to connect to the server: EOF
--- t+15s: NAME                        STATUS   ROLES           AGE   VERSION
RECOVERED at t+15s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   28m   v1.37.0
cka-capture-worker          Ready    <none>          28m   v1.37.0
```

```
$ kubectl get pods -n kube-system
NAME                                                READY   STATUS    RESTARTS   AGE
coredns-559f6c778d-5t9j5                            1/1     Running   0          28m
coredns-559f6c778d-mkr68                            1/1     Running   0          28m
etcd-cka-capture-control-plane                      1/1     Running   0          28m
kindnet-psznp                                       1/1     Running   0          28m
kindnet-qfzz2                                       1/1     Running   0          28m
kube-apiserver-cka-capture-control-plane            1/1     Running   0          28m
kube-controller-manager-cka-capture-control-plane   1/1     Running   0          28m
kube-proxy-7v5f9                                    1/1     Running   0          28m
kube-proxy-hjhpc                                    1/1     Running   0          28m
kube-scheduler-cka-capture-control-plane            1/1     Running   0          8m33s
[exit 0]
```


Observations (4c):
- Edit at 01:58:32. Within ~15 s the container exits immediately and is restarted with CrashLoopBackOff growth: at ~50 s `crictl ps -a` shows `kube-apiserver ... Exited`, ATTEMPT 3. `crictl logs` (full output, 4 lines):

```
I1109 01:59:23.299177       1 options.go:261] external host was not specified, using 172.18.0.4
I1109 01:59:23.302607       1 server.go:151] Version: v1.37.0
I1109 01:59:23.302632       1 server.go:153] "Golang settings" GOGC="" GOMAXPROCS="" GOTRACEBACK=""
E1109 01:59:23.303012       1 run.go:72] "command failed" err="open /etc/kubernetes/pki/apiserver.crtt: no such file or directory"
```

- Host kubectl: `Get "https://127.0.0.1:39435/api/v1/nodes?limit=500": read tcp ...: read: connection reset by peer - error from a previous attempt: EOF`, then `Unable to connect to the server: EOF`.
- Kubelet journal shows `CrashLoopBackOff: "back-off 40s restarting failed container=kube-apiserver pod=kube-apiserver-cka-capture-control-plane_kube-system(...)"` plus the same `connection refused` mirror-pod/status/event errors.
- **Restore** at 01:59:48: `EOF` at t+10 s, nodes listed at **t+15 s**. Recovery ~15 s (the changed manifest resets the crash-loop backoff).

## Scenario 5: kube-controller-manager stopped (manifest moved out of /etc/kubernetes/manifests)

Setup: Deployment `cm-test` (nginx:1.27, 1 replica) running. Note the baseline `kube-controller-manager` pod showed `RESTARTS 1 (7m9s ago)`, caused by the apiserver outages in Scenario 4 (leader-election loss), not by this scenario.

```
$ kubectl create deployment cm-test --image=nginx:1.27 --replicas=1
deployment.apps/cm-test created
[exit 0]

Waiting for deployment spec update to be observed...
Waiting for deployment spec update to be observed...
Waiting for deployment "cm-test" rollout to finish: 0 out of 1 new replicas have been updated...
Waiting for deployment "cm-test" rollout to finish: 0 of 1 updated replicas are available...
deployment "cm-test" successfully rolled out
```

```
$ kubectl get deploy,rs,pods
NAME                      READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/cm-test   1/1     1            1           68s

NAME                                 DESIRED   CURRENT   READY   AGE
replicaset.apps/cm-test-7858b6d65c   1         1         1       62s

NAME                           READY   STATUS    RESTARTS   AGE
pod/cm-test-7858b6d65c-zrll9   1/1     Running   0          62s
[exit 0]
```

```
$ kubectl get pods -n kube-system -l component=kube-controller-manager
NAME                                                READY   STATUS    RESTARTS       AGE
kube-controller-manager-cka-capture-control-plane   1/1     Running   1 (7m9s ago)   29m
[exit 0]
```


*TIMER RESET: move-out*

```
[cka-capture-control-plane]$ mkdir -p /root/cka-capture && mv /etc/kubernetes/manifests/kube-controller-manager.yaml /root/cka-capture/kcm.yaml && ls /etc/kubernetes/manifests; date -u +%T
etcd.yaml
kube-apiserver.yaml
kube-scheduler.yaml
02:01:12
[exit 0]

--- t+0s
NAME                                                READY   STATUS    RESTARTS       AGE
kube-controller-manager-cka-capture-control-plane   1/1     Running   1 (7m9s ago)   29m
--- t+5s
NAME                                       READY   STATUS    RESTARTS        AGE
--- t+10s
NAME                                       READY   STATUS    RESTARTS        AGE
--- t+15s
NAME                                       READY   STATUS    RESTARTS        AGE
--- t+20s
NAME                                       READY   STATUS    RESTARTS        AGE
--- t+25s
NAME                                       READY   STATUS    RESTARTS        AGE
--- t+30s
NAME                                       READY   STATUS    RESTARTS        AGE
--- t+35s
NAME                                       READY   STATUS    RESTARTS        AGE
```

```
[cka-capture-control-plane]$ crictl ps -a | grep -E 'CONTAINER|controller-manager'
CONTAINER           IMAGE               CREATED              STATE               NAME                      ATTEMPT             POD ID              POD                                                 NAMESPACE
9ff47865a89dc       364b3c3d9ec19       7 minutes ago        Exited              kube-controller-manager   1                   b4a3160ec9c60       kube-controller-manager-cka-capture-control-plane   kube-system
[exit 0]
```

```
$ kubectl scale deploy cm-test --replicas=3
deployment.apps/cm-test scaled
[exit 0]
```

```
$ kubectl get deploy cm-test
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-test   1/3     1            1           2m9s
[exit 0]
```

```
$ kubectl get rs
NAME                 DESIRED   CURRENT   READY   AGE
cm-test-7858b6d65c   1         1         1       2m3s
[exit 0]
```

```
$ kubectl get pods
NAME                       READY   STATUS    RESTARTS   AGE
cm-test-7858b6d65c-zrll9   1/1     Running   0          2m3s
[exit 0]
```

```
$ kubectl create deployment cm-new --image=nginx:1.27 --replicas=2
deployment.apps/cm-new created
[exit 0]
```

```
$ kubectl get deploy
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    0/2     0            0           15s
cm-test   1/3     1            1           2m25s
[exit 0]
```

```
$ kubectl get rs
NAME                 DESIRED   CURRENT   READY   AGE
cm-test-7858b6d65c   1         1         1       2m19s
[exit 0]
```

```
$ kubectl get pods
NAME                       READY   STATUS    RESTARTS   AGE
cm-test-7858b6d65c-zrll9   1/1     Running   0          2m19s
[exit 0]
```

```
$ kubectl describe deploy cm-test
Name:                   cm-test
Namespace:              default
CreationTimestamp:      Mon, 09 Nov 2026 02:00:03 +0000
Labels:                 app=cm-test
Annotations:            deployment.kubernetes.io/revision: 1
Selector:               app=cm-test
Replicas:               3 desired | 1 updated | 1 total | 1 available | 0 unavailable
StrategyType:           RollingUpdate
MinReadySeconds:        0
RollingUpdateStrategy:  25% max unavailable, 25% max surge
Pod Template:
  Labels:  app=cm-test
  Containers:
   nginx:
    Image:         nginx:1.27
    Port:          <none>
    Host Port:     <none>
    Environment:   <none>
    Mounts:        <none>
  Volumes:         <none>
  Node-Selectors:  <none>
  Tolerations:     <none>
Conditions:
  Type           Status  Reason
  ----           ------  ------
  Available      True    MinimumReplicasAvailable
  Progressing    True    NewReplicaSetAvailable
OldReplicaSets:  <none>
NewReplicaSet:   cm-test-7858b6d65c (1/1 replicas created)
Events:
  Type    Reason             Age    From                   Message
  ----    ------             ----   ----                   -------
  Normal  ScalingReplicaSet  2m19s  deployment-controller  Scaled up replica set cm-test-7858b6d65c from 0 to 1
[exit 0]
```

```
$ kubectl delete pod -l app=cm-test --wait=false
pod "cm-test-7858b6d65c-zrll9" deleted from default namespace
[exit 0]
```

```
$ kubectl get pods
No resources found in default namespace.
[exit 0]
```

```
$ kubectl get nodes
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   30m   v1.37.0
cka-capture-worker          Ready    <none>          30m   v1.37.0
[exit 0]
```


*TIMER RESET: restore*

```
[cka-capture-control-plane]$ mv /root/cka-capture/kcm.yaml /etc/kubernetes/manifests/kube-controller-manager.yaml; date -u +%T
02:02:43
[exit 0]

--- t+0s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    0/2     0            0           30s
cm-test   1/3     1            1           2m40s
No resources found in default namespace.
--- t+5s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    0/2     0            0           35s
cm-test   1/3     1            1           2m45s
No resources found in default namespace.
--- t+10s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    0/2     0            0           40s
cm-test   1/3     1            1           2m50s
No resources found in default namespace.
--- t+15s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    0/2     0            0           45s
cm-test   1/3     1            1           2m55s
No resources found in default namespace.
--- t+21s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    1/2     2            1           51s
cm-test   1/3     3            1           3m1s
NAME                       READY   STATUS    RESTARTS   AGE
cm-new-7f46bd5bf7-5g4f2    1/1     Running   0          1s
cm-new-7f46bd5bf7-vxcgc    1/1     Running   0          1s
cm-test-7858b6d65c-4d5mk   1/1     Running   0          1s
cm-test-7858b6d65c-9hk7b   1/1     Running   0          1s
cm-test-7858b6d65c-p2ghk   1/1     Running   0          1s
--- t+26s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
[... trimmed 34 lines ...]
cm-new-7f46bd5bf7-vxcgc    1/1     Running   0          21s
cm-test-7858b6d65c-4d5mk   1/1     Running   0          21s
cm-test-7858b6d65c-9hk7b   1/1     Running   0          21s
cm-test-7858b6d65c-p2ghk   1/1     Running   0          21s
--- t+46s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    2/2     2            2           76s
cm-test   3/3     3            3           3m26s
NAME                       READY   STATUS    RESTARTS   AGE
cm-new-7f46bd5bf7-5g4f2    1/1     Running   0          26s
cm-new-7f46bd5bf7-vxcgc    1/1     Running   0          26s
cm-test-7858b6d65c-4d5mk   1/1     Running   0          26s
cm-test-7858b6d65c-9hk7b   1/1     Running   0          26s
cm-test-7858b6d65c-p2ghk   1/1     Running   0          26s
--- t+51s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    2/2     2            2           81s
cm-test   3/3     3            3           3m31s
NAME                       READY   STATUS    RESTARTS   AGE
cm-new-7f46bd5bf7-5g4f2    1/1     Running   0          31s
cm-new-7f46bd5bf7-vxcgc    1/1     Running   0          31s
cm-test-7858b6d65c-4d5mk   1/1     Running   0          31s
cm-test-7858b6d65c-9hk7b   1/1     Running   0          31s
cm-test-7858b6d65c-p2ghk   1/1     Running   0          31s
--- t+56s
NAME      READY   UP-TO-DATE   AVAILABLE   AGE
cm-new    2/2     2            2           87s
cm-test   3/3     3            3           3m37s
NAME                       READY   STATUS    RESTARTS   AGE
cm-new-7f46bd5bf7-5g4f2    1/1     Running   0          37s
cm-new-7f46bd5bf7-vxcgc    1/1     Running   0          37s
cm-test-7858b6d65c-4d5mk   1/1     Running   0          37s
cm-test-7858b6d65c-9hk7b   1/1     Running   0          37s
cm-test-7858b6d65c-p2ghk   1/1     Running   0          37s
```

```
$ kubectl get pods -n kube-system
NAME                                                READY   STATUS    RESTARTS        AGE
coredns-559f6c778d-5t9j5                            1/1     Running   0               31m
coredns-559f6c778d-mkr68                            1/1     Running   0               31m
etcd-cka-capture-control-plane                      1/1     Running   0               31m
kindnet-psznp                                       1/1     Running   0               31m
kindnet-qfzz2                                       1/1     Running   0               31m
kube-apiserver-cka-capture-control-plane            1/1     Running   0               31m
kube-controller-manager-cka-capture-control-plane   1/1     Running   0               62s
kube-proxy-7v5f9                                    1/1     Running   0               31m
kube-proxy-hjhpc                                    1/1     Running   0               31m
kube-scheduler-cka-capture-control-plane            1/1     Running   1 (9m42s ago)   12m
[exit 0]
```

```
$ kubectl delete deploy cm-test cm-new
deployment.apps "cm-test" deleted from default namespace
deployment.apps "cm-new" deleted from default namespace
[exit 0]
```


Observations (controller-manager down):
- `mv` of the manifest out of the directory at 02:01:12: the controller-manager mirror pod **disappeared from `kubectl get pods -n kube-system` within 5 s** (listing empty at t+5 s; only the header line remains), and `crictl ps -a` shows the container `Exited` (the kubelet stops the static pod when its manifest is removed).
- `kubectl scale deploy cm-test --replicas=3` is accepted (`deployment.apps/cm-test scaled`) but **no new Pods appear**: `kubectl get deploy cm-test` -> `READY 1/3, UP-TO-DATE 1, AVAILABLE 1`; the ReplicaSet stays `DESIRED 1 CURRENT 1 READY 1`; `kubectl describe deploy cm-test` shows `Replicas: 3 desired | 1 updated | 1 total | 1 available | 0 unavailable` and no new Events. A brand-new Deployment (`kubectl create deployment cm-new --replicas=2`) shows `READY 0/2, UP-TO-DATE 0, AVAILABLE 0` and **no ReplicaSet is created** (`kubectl get rs` lists only the old one) and no Pods.
- Deleting the only existing pod (`kubectl delete pod -l app=cm-test`) is not healed: `kubectl get pods` -> `No resources found in default namespace.` (no replacement is created; the node stays Ready since the node controller is also down).
- **Restore** (mv back at 02:02:43): nothing for ~15 s, then at **t+21 s** the ReplicaSets/Pods appear (`cm-test` 3 pods, `cm-new` 2 pods, all 1 s old) and at t+26 s everything is `3/3` and `2/2` `Running`. Recovery ~20 s.

## Scenario 6: kubelet pointed at a wrong container runtime socket (worker)

On this kind version (kubelet v1.37.0) the CRI socket is set in `/var/lib/kubelet/config.yaml` as `containerRuntimeEndpoint: unix:///run/containerd/containerd.sock` (line 20), NOT via `--container-runtime-endpoint` in `/var/lib/kubelet/kubeadm-flags.env` (whose KUBELET_KUBEADM_ARGS only has `--node-ip --provider-id --node-labels`). The edit appended an extra `k` (`containerd.sockk`) and ran `systemctl restart kubelet`.

```
[cka-capture-worker]$ mkdir -p /root/cka-capture && cp -p /var/lib/kubelet/config.yaml /root/cka-capture/config.yaml.bak
[exit 0]
```

```
$ kubectl create deployment web6 --image=nginx:1.27 --replicas=1
deployment.apps/web6 created
[exit 0]
```

```
$ kubectl get nodes
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   31m   v1.37.0
cka-capture-worker          Ready    <none>          31m   v1.37.0
[exit 0]
```


*TIMER RESET: edit*

```
[cka-capture-worker]$ sed -i 's#containerRuntimeEndpoint: unix:///run/containerd/containerd.sock#containerRuntimeEndpoint: unix:///run/containerd/containerd.sockk#' /var/lib/kubelet/config.yaml; grep -n containerRuntimeEndpoint /var/lib/kubelet/config.yaml; date -u +%T
20:containerRuntimeEndpoint: unix:///run/containerd/containerd.sockk
02:03:45
[exit 0]
```

```
[cka-capture-worker]$ systemctl restart kubelet; echo restart-returned; date -u +%T
restart-returned
02:03:45
[exit 0]
```

```
[cka-capture-worker]$ systemctl status kubelet --no-pager
● kubelet.service - kubelet: The Kubernetes Node Agent
     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)
    Drop-In: /etc/systemd/system/kubelet.service.d
             └─10-kubeadm.conf, 11-kind.conf
     Active: active (running) since Mon 2026-11-09 02:03:45 UTC; 61ms ago
 Invocation: 22263cfcbfef4fa6abe6bb96162be5a4
       Docs: http://kubernetes.io/docs/
    Process: 4586 ExecStartPre=/bin/sh -euc if [ -f /sys/fs/cgroup/cgroup.controllers ]; then /kind/bin/create-kubelet-cgroup-v2.sh; fi (code=exited, status=0/SUCCESS)
    Process: 4595 ExecStartPre=/bin/sh -euc if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd/kubelet ]; then mkdir -p /sys/fs/cgroup/systemd/kubelet; fi (code=exited, status=0/SUCCESS)
   Main PID: 4597 (kubelet)
      Tasks: 13 (limit: 2871)
     Memory: 14.4M (peak: 14.7M)
        CPU: 104ms
     CGroup: /kubelet.slice/kubelet.service
             └─4597 "[kubelet]"

Nov 09 02:03:45 cka-capture-worker kubelet[4597]:  >
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.774656    4597 server.go:545] "Kubelet version" kubeletVersion="v1.37.0"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.774691    4597 server.go:547] "Golang settings" GOGC="" GOMAXPROCS="" GOTRACEBACK=""
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.774716    4597 watchdog_linux.go:94] "Systemd watchdog is not enabled"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.774727    4597 watchdog_linux.go:137] "Systemd watchdog is not enabled or the interval is invalid, so health checking will not be started."
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.775860    4597 server.go:1036] "Client rotation is on, will bootstrap in background"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.778069    4597 certificate_store.go:147] "Loading cert/key pair from a file" filePath="/var/lib/kubelet/pki/kubelet-client-current.pem"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.780577    4597 dynamic_cafile_content.go:161] "Starting controller" name="client-ca-bundle::/etc/kubernetes/pki/ca.crt"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: W1109 02:03:45.781148    4597 logging.go:55] [core] [Channel #1 SubChannel #2] grpc: addrConn.createTransport failed to connect to {Addr: "/run/containerd/containerd.sockk", ServerName: "localhost", }. Err: connection error: desc = "transport: Error  ...[line cut]
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: E1109 02:03:45.781268    4597 run.go:72] "command failed" err="failed to run Kubelet: validate service connection: validate CRI v1 runtime API for endpoint \"unix:///run/containerd/containerd.sockk\": rpc error: code = Unavailable desc = connection e ...[line cut]
[exit 0]
```

```
[cka-capture-worker]$ systemctl is-active kubelet; systemctl is-enabled kubelet
activating
enabled
[exit 0]
```

```
[cka-capture-worker]$ journalctl -u kubelet --no-pager -n 30 | cut -c1-500
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         providerID: kind://docker/cka-capture/cka-capture-worker
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         registerNode: true
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         registryBurst: 10
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         registryPullQPS: 5
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         resolvConf: /etc/resolv.conf
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         rotateCertificates: true
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         runtimeRequestTimeout: 2m0s
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         seccompDefault: false
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         serializeImagePulls: true
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         shutdownGracePeriod: 0s
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         shutdownGracePeriodCriticalPods: 0s
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         staticPodPath: /etc/kubernetes/manifests
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         streamingConnectionIdleTimeout: 4h0m0s
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         syncFrequency: 1m0s
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         topologyManagerPolicy: none
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         topologyManagerScope: container
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         volumePluginDir: /usr/libexec/kubernetes/kubelet-plugins/volume/exec/
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:         volumeStatsAggPeriod: 1m0s
Nov 09 02:03:45 cka-capture-worker kubelet[4597]:  >
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.774656    4597 server.go:545] "Kubelet version" kubeletVersion="v1.37.0"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.774691    4597 server.go:547] "Golang settings" GOGC="" GOMAXPROCS="" GOTRACEBACK=""
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.774716    4597 watchdog_linux.go:94] "Systemd watchdog is not enabled"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.774727    4597 watchdog_linux.go:137] "Systemd watchdog is not enabled or the interval is invalid, so health checking will not be started."
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.775860    4597 server.go:1036] "Client rotation is on, will bootstrap in background"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.778069    4597 certificate_store.go:147] "Loading cert/key pair from a file" filePath="/var/lib/kubelet/pki/kubelet-client-current.pem"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: I1109 02:03:45.780577    4597 dynamic_cafile_content.go:161] "Starting controller" name="client-ca-bundle::/etc/kubernetes/pki/ca.crt"
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: W1109 02:03:45.781148    4597 logging.go:55] [core] [Channel #1 SubChannel #2] grpc: addrConn.createTransport failed to connect to {Addr: "/run/containerd/containerd.sockk", ServerName: "localhost", }. Err: connection error: desc = "transport: Error  ...[line cut]
Nov 09 02:03:45 cka-capture-worker kubelet[4597]: E1109 02:03:45.781268    4597 run.go:72] "command failed" err="failed to run Kubelet: validate service connection: validate CRI v1 runtime API for endpoint \"unix:///run/containerd/containerd.sockk\": rpc error: code = Unavailable desc = connection e ...[line cut]
Nov 09 02:03:45 cka-capture-worker systemd[1]: kubelet.service: Main process exited, code=exited, status=1/FAILURE
Nov 09 02:03:45 cka-capture-worker systemd[1]: kubelet.service: Failed with result 'exit-code'.
[exit 0]
```

```
[cka-capture-worker]$ systemctl status kubelet --no-pager | head -12
● kubelet.service - kubelet: The Kubernetes Node Agent
     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)
    Drop-In: /etc/systemd/system/kubelet.service.d
             └─10-kubeadm.conf, 11-kind.conf
     Active: activating (auto-restart) (Result: exit-code) since Mon 2026-11-09 02:04:05 UTC; 156ms ago
 Invocation: e01355de008341dd948c115053924be2
       Docs: http://kubernetes.io/docs/
    Process: 5034 ExecStartPre=/bin/sh -euc if [ -f /sys/fs/cgroup/cgroup.controllers ]; then /kind/bin/create-kubelet-cgroup-v2.sh; fi (code=exited, status=0/SUCCESS)
    Process: 5043 ExecStartPre=/bin/sh -euc if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd/kubelet ]; then mkdir -p /sys/fs/cgroup/systemd/kubelet; fi (code=exited, status=0/SUCCESS)
    Process: 5045 ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS (code=exited, status=1/FAILURE)
   Main PID: 5045 (code=exited, status=1/FAILURE)
   Mem peak: 14.8M
[exit 0]
```

```
[cka-capture-worker]$ journalctl -u kubelet --no-pager -n 30 | cut -c1-500
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         providerID: kind://docker/cka-capture/cka-capture-worker
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         registerNode: true
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         registryBurst: 10
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         registryPullQPS: 5
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         resolvConf: /etc/resolv.conf
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         rotateCertificates: true
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         runtimeRequestTimeout: 2m0s
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         seccompDefault: false
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         serializeImagePulls: true
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         shutdownGracePeriod: 0s
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         shutdownGracePeriodCriticalPods: 0s
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         staticPodPath: /etc/kubernetes/manifests
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         streamingConnectionIdleTimeout: 4h0m0s
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         syncFrequency: 1m0s
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         topologyManagerPolicy: none
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         topologyManagerScope: container
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         volumePluginDir: /usr/libexec/kubernetes/kubelet-plugins/volume/exec/
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:         volumeStatsAggPeriod: 1m0s
Nov 09 02:04:05 cka-capture-worker kubelet[5045]:  >
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: I1109 02:04:05.819594    5045 server.go:545] "Kubelet version" kubeletVersion="v1.37.0"
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: I1109 02:04:05.819627    5045 server.go:547] "Golang settings" GOGC="" GOMAXPROCS="" GOTRACEBACK=""
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: I1109 02:04:05.819648    5045 watchdog_linux.go:94] "Systemd watchdog is not enabled"
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: I1109 02:04:05.819656    5045 watchdog_linux.go:137] "Systemd watchdog is not enabled or the interval is invalid, so health checking will not be started."
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: I1109 02:04:05.820093    5045 server.go:1036] "Client rotation is on, will bootstrap in background"
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: I1109 02:04:05.821225    5045 certificate_store.go:147] "Loading cert/key pair from a file" filePath="/var/lib/kubelet/pki/kubelet-client-current.pem"
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: I1109 02:04:05.823182    5045 dynamic_cafile_content.go:161] "Starting controller" name="client-ca-bundle::/etc/kubernetes/pki/ca.crt"
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: W1109 02:04:05.823662    5045 logging.go:55] [core] [Channel #1 SubChannel #2] grpc: addrConn.createTransport failed to connect to {Addr: "/run/containerd/containerd.sockk", ServerName: "localhost", }. Err: connection error: desc = "transport: Error  ...[line cut]
Nov 09 02:04:05 cka-capture-worker kubelet[5045]: E1109 02:04:05.823761    5045 run.go:72] "command failed" err="failed to run Kubelet: validate service connection: validate CRI v1 runtime API for endpoint \"unix:///run/containerd/containerd.sockk\": rpc error: code = Unavailable desc = connection e ...[line cut]
Nov 09 02:04:05 cka-capture-worker systemd[1]: kubelet.service: Main process exited, code=exited, status=1/FAILURE
Nov 09 02:04:05 cka-capture-worker systemd[1]: kubelet.service: Failed with result 'exit-code'.
[exit 0]
```

```
[cka-capture-worker]$ crictl ps
CONTAINER           IMAGE               CREATED             STATE               NAME                ATTEMPT             POD ID              POD                 NAMESPACE
946494ed7c648       4626fe10df5b9       31 minutes ago      Running             kindnet-cni         0                   4f821ea8bead5       kindnet-qfzz2       kube-system
4a3423dfbe64a       d6a28daf3e6b0       32 minutes ago      Running             kube-proxy          0                   4404aeacf416f       kube-proxy-7v5f9    kube-system
[exit 0]

--- t+21s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   32m   v1.37.0
cka-capture-worker          Ready    <none>          32m   v1.37.0
--- t+31s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   32m   v1.37.0
cka-capture-worker          Ready    <none>          32m   v1.37.0
--- t+41s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   32m   v1.37.0
cka-capture-worker          Ready    <none>          32m   v1.37.0
--- t+51s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   32m   v1.37.0
cka-capture-worker          NotReady   <none>          32m   v1.37.0
--- t+61s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   32m   v1.37.0
cka-capture-worker          NotReady   <none>          32m   v1.37.0
--- t+71s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   33m   v1.37.0
cka-capture-worker          NotReady   <none>          32m   v1.37.0
--- t+81s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   33m   v1.37.0
cka-capture-worker          NotReady   <none>          33m   v1.37.0
--- t+91s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   33m   v1.37.0
cka-capture-worker          NotReady   <none>          33m   v1.37.0
--- t+101s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   33m   v1.37.0
cka-capture-worker          NotReady   <none>          33m   v1.37.0
--- t+111s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   33m   v1.37.0
cka-capture-worker          NotReady   <none>          33m   v1.37.0
--- t+121s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   33m   v1.37.0
cka-capture-worker          NotReady   <none>          33m   v1.37.0
--- t+131s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   34m   v1.37.0
cka-capture-worker          NotReady   <none>          33m   v1.37.0
--- t+141s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   34m   v1.37.0
cka-capture-worker          NotReady   <none>          34m   v1.37.0
--- t+151s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   34m   v1.37.0
cka-capture-worker          NotReady   <none>          34m   v1.37.0
```

```
$ kubectl describe node cka-capture-worker
Name:               cka-capture-worker
Roles:              <none>
Labels:             beta.kubernetes.io/arch=amd64
                    beta.kubernetes.io/os=linux
                    kubernetes.io/arch=amd64
                    kubernetes.io/hostname=cka-capture-worker
                    kubernetes.io/os=linux
Annotations:        node.alpha.kubernetes.io/ttl: 0
                    volumes.kubernetes.io/controller-managed-attach-detach: true
CreationTimestamp:  Mon, 09 Nov 2026 01:32:02 +0000
Taints:             node.kubernetes.io/unreachable:NoExecute
                    node.kubernetes.io/unreachable:NoSchedule
Unschedulable:      false
Lease:
  HolderIdentity:  cka-capture-worker
  AcquireTime:     <unset>
  RenewTime:       Mon, 09 Nov 2026 02:03:42 +0000
Conditions:
  Type             Status    LastHeartbeatTime                 LastTransitionTime                Reason              Message
  ----             ------    -----------------                 ------------------                ------              -------
  MemoryPressure   Unknown   Mon, 09 Nov 2026 02:00:10 +0000   Mon, 09 Nov 2026 02:04:32 +0000   NodeStatusUnknown   Kubelet stopped posting node status.
  DiskPressure     Unknown   Mon, 09 Nov 2026 02:00:10 +0000   Mon, 09 Nov 2026 02:04:32 +0000   NodeStatusUnknown   Kubelet stopped posting node status.
  PIDPressure      Unknown   Mon, 09 Nov 2026 02:00:10 +0000   Mon, 09 Nov 2026 02:04:32 +0000   NodeStatusUnknown   Kubelet stopped posting node status.
  Ready            Unknown   Mon, 09 Nov 2026 02:00:10 +0000   Mon, 09 Nov 2026 02:04:32 +0000   NodeStatusUnknown   Kubelet stopped posting node status.
Addresses:
  InternalIP:  172.18.0.3
  Hostname:    cka-capture-worker
Capacity:
  cpu:                8
  ephemeral-storage:  82086711296
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             16375600Ki
  pods:               110
Allocatable:
[... trimmed 26 lines ...]
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests   Limits
  --------           --------   ------
  cpu                100m (1%)  0 (0%)
  memory             50Mi (0%)  0 (0%)
  ephemeral-storage  0 (0%)     0 (0%)
  hugepages-1Gi      0 (0%)     0 (0%)
  hugepages-2Mi      0 (0%)     0 (0%)
Events:
  Type    Reason                   Age                From             Message
  ----    ------                   ----               ----             -------
  Normal  RegisteredNode           34m                node-controller  Node cka-capture-worker event: Registered Node cka-capture-worker in Controller
  Normal  NodeReady                34m                kubelet          Node cka-capture-worker status is now: NodeReady
  Normal  NodeReady                31m (x2 over 31m)  kubelet          Node cka-capture-worker status is now: NodeReady
  Normal  NodeHasSufficientMemory  31m (x3 over 31m)  kubelet          Node cka-capture-worker status is now: NodeHasSufficientMemory
  Normal  NodeHasNoDiskPressure    31m (x3 over 31m)  kubelet          Node cka-capture-worker status is now: NodeHasNoDiskPressure
  Normal  NodeHasSufficientPID     31m (x3 over 31m)  kubelet          Node cka-capture-worker status is now: NodeHasSufficientPID
  Normal  NodeHasNoDiskPressure    24m (x3 over 24m)  kubelet          Node cka-capture-worker status is now: NodeHasNoDiskPressure
  Normal  NodeHasSufficientMemory  24m (x3 over 24m)  kubelet          Node cka-capture-worker status is now: NodeHasSufficientMemory
  Normal  NodeHasSufficientPID     24m (x3 over 24m)  kubelet          Node cka-capture-worker status is now: NodeHasSufficientPID
  Normal  NodeReady                24m (x2 over 24m)  kubelet          Node cka-capture-worker status is now: NodeReady
  Normal  NodeNotReady             23m (x3 over 32m)  node-controller  Node cka-capture-worker status is now: NodeNotReady
  Normal  NodeHasSufficientMemory  22m (x2 over 22m)  kubelet          Node cka-capture-worker status is now: NodeHasSufficientMemory
  Normal  NodeHasNoDiskPressure    22m (x2 over 22m)  kubelet          Node cka-capture-worker status is now: NodeHasNoDiskPressure
  Normal  NodeHasSufficientPID     22m (x2 over 22m)  kubelet          Node cka-capture-worker status is now: NodeHasSufficientPID
  Normal  NodeReady                22m                kubelet          Node cka-capture-worker status is now: NodeReady
  Normal  RegisteredNode           6m19s              node-controller  Node cka-capture-worker event: Registered Node cka-capture-worker in Controller
  Normal  RegisteredNode           3m25s              node-controller  Node cka-capture-worker event: Registered Node cka-capture-worker in Controller
  Normal  NodeNotReady             115s               node-controller  Node cka-capture-worker status is now: NodeNotReady
[exit 0]
```

```
$ kubectl get pods -o wide
NAME                       READY   STATUS              RESTARTS   AGE     IP            NODE                 NOMINATED NODE   READINESS GATES
cm-new-7f46bd5bf7-5g4f2    0/1     Completed           0          3m24s   10.244.1.11   cka-capture-worker   <none>           <none>
cm-new-7f46bd5bf7-vxcgc    0/1     Completed           0          3m24s   10.244.1.10   cka-capture-worker   <none>           <none>
cm-test-7858b6d65c-4d5mk   0/1     Completed           0          3m24s   10.244.1.9    cka-capture-worker   <none>           <none>
cm-test-7858b6d65c-9hk7b   0/1     Completed           0          3m24s   10.244.1.13   cka-capture-worker   <none>           <none>
cm-test-7858b6d65c-p2ghk   0/1     Completed           0          3m24s   10.244.1.12   cka-capture-worker   <none>           <none>
web6-588cf8f6dd-h5nv5      0/1     ContainerCreating   0          2m42s   <none>        cka-capture-worker   <none>           <none>
[exit 0]
```


*TIMER RESET: restore*

```
[cka-capture-worker]$ cp -p /root/cka-capture/config.yaml.bak /var/lib/kubelet/config.yaml; systemctl restart kubelet; date -u +%T
02:06:27
[exit 0]
```

```
[cka-capture-worker]$ systemctl is-active kubelet
active
[exit 0]

--- t+0s
NAME                        STATUS     ROLES           AGE   VERSION
cka-capture-control-plane   Ready      control-plane   34m   v1.37.0
cka-capture-worker          NotReady   <none>          34m   v1.37.0
--- t+4s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   34m   v1.37.0
cka-capture-worker          Ready    <none>          34m   v1.37.0
--- t+8s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   34m   v1.37.0
cka-capture-worker          Ready    <none>          34m   v1.37.0
--- t+12s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   34m   v1.37.0
cka-capture-worker          Ready    <none>          34m   v1.37.0
--- t+16s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   34m   v1.37.0
cka-capture-worker          Ready    <none>          34m   v1.37.0
--- t+20s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   34m   v1.37.0
cka-capture-worker          Ready    <none>          34m   v1.37.0
--- t+24s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   35m   v1.37.0
cka-capture-worker          Ready    <none>          34m   v1.37.0
--- t+28s
NAME                        STATUS   ROLES           AGE   VERSION
cka-capture-control-plane   Ready    control-plane   35m   v1.37.0
cka-capture-worker          Ready    <none>          34m   v1.37.0
```

```
$ kubectl get pods -o wide
NAME                    READY   STATUS    RESTARTS   AGE     IP            NODE                 NOMINATED NODE   READINESS GATES
web6-588cf8f6dd-h5nv5   1/1     Running   0          3m14s   10.244.1.14   cka-capture-worker   <none>           <none>
[exit 0]
```

```
$ kubectl delete deploy web6
deployment.apps "web6" deleted from default namespace
[exit 0]
```


*node hostnames*

```
[cka-capture-control-plane]$ hostname
cka-capture-control-plane
[exit 0]
```

```
[cka-capture-worker]$ hostname
cka-capture-worker
[exit 0]
```


Observations (wrong socket):
- `systemctl restart kubelet` returns immediately. The kubelet dumps its whole effective config (hundreds of journal lines) and then fails in ~100 ms. The decisive lines (exact):

```
W1109 02:03:45.781148    4597 logging.go:55] [core] [Channel #1 SubChannel #2] grpc: addrConn.createTransport failed to connect to {Addr: "/run/containerd/containerd.sockk", ServerName: "localhost", }. Err: connection error: desc = "transport: Error while dialing: dial unix /run/containerd/containerd.sockk: connect: no such file or directory"
E1109 02:03:45.781268    4597 run.go:72] "command failed" err="failed to run Kubelet: validate service connection: validate CRI v1 runtime API for endpoint \"unix:///run/containerd/containerd.sockk\": rpc error: code = Unavailable desc = connection error: desc = \"transport: Error while dialing: dial unix /run/containerd/containerd.sockk: connect: no such file or directory\""
systemd[1]: kubelet.service: Main process exited, code=exited, status=1/FAILURE
systemd[1]: kubelet.service: Failed with result 'exit-code'.
```

- `journalctl -u kubelet -n 30` is **dominated by the config dump** (the last two lines are the systemd exit lines; the `command failed` error sits just above them), so on a real exam `-n 30` can hide the cause: use `journalctl -u kubelet --no-pager | grep -i "command failed"` or `-n 5`.
- `systemctl status kubelet` right after the restart briefly shows `Active: active (running)`, then flips: `systemctl is-active kubelet` printed **`activating`** and ~20 s later status shows `Active: activating (auto-restart) (Result: exit-code) since ... ago` with `Process: ... ExecStart=/usr/bin/kubelet ... (code=exited, status=1/FAILURE)` and `Main PID: ... (code=exited, status=1/FAILURE)`. It crash-loops (systemd Restart=always, ~20 s between starts).
- **Node status**: Ready at t+21, 31, 41 s; **NotReady at t+51 s** (grace period ~40 s after last heartbeat), stays NotReady. `describe node`: Ready/MemoryPressure/DiskPressure/PIDPressure all `Unknown`, Reason `NodeStatusUnknown`, Message `Kubelet stopped posting node status.`, taints `unreachable:NoExecute` + `unreachable:NoSchedule`.
- `crictl ps` on the worker still shows kindnet-cni and kube-proxy `Running` (containerd itself is fine; only kubelet cannot reach it). A Pod created just before the restart (`web6`) sat in `ContainerCreating` on the worker for the whole outage.
- **Restore** (config.yaml restored from backup + `systemctl restart kubelet` at 02:06:27): `systemctl is-active` -> `active`; node `NotReady` at t+0 s, **`Ready` at t+4 s**; `web6` `1/1 Running` by the next read.
- Incidental: the `Completed` pods in the `describe` listing at the end of this scenario are leftovers of Scenario 5's Deployments that were deleted just before; they are not caused by the socket fault.

## Scenario 7: node hostnames

`hostname` inside each node container prints the container name: `cka-capture-control-plane` and `cka-capture-worker` (see the end of the Scenario 6 output above: `[cka-capture-control-plane]$ hostname` -> `cka-capture-control-plane`, `[cka-capture-worker]$ hostname` -> `cka-capture-worker`). Prompts were not captured (docker exec is not representative).

## Summary of timings

| Fault | Time to visible symptom | Time to recover after fix |
|---|---|---|
| kubelet stopped (worker) | node NotReady ~52 s; Pod stays `1/1 Running` until eviction at ~300 s after NotReady (t+353 s), replacement `Pending` | node Ready ~3 s |
| kubelet disabled + stopped | same as stopped; `is-enabled` = `disabled` | `enable --now`: Ready <= 3 s |
| scheduler YAML syntax error | pod vanishes from `kubectl get pods -n kube-system` and container gone in <= 10 s; test pod Pending, no events | scheduler `1/1` 16 s, test pod Running ~6 s after the mirror pod returns |
| scheduler wrong image | mirror pod `ErrImagePull`/`ImagePullBackOff` visible after ~15-45 s; no container exists | `1/1` 26 s |
| scheduler wrong flag | `Exited` containers (ATTEMPT 1..3), `CrashLoopBackOff` in `kubectl get pods` ~15-60 s | `1/1` 26 s |
| apiserver wrong etcd port | kubectl fails within seconds; container exits after ~20 s of etcd retries (ATTEMPT 2 at ~2 min) | kubectl works ~22 s |
| apiserver wrong secure-port | kubectl fails immediately (connection refused to 6443); container keeps Running | ~15 s |
| apiserver wrong cert path | crash loop within ~15 s (`open ...apiserver.crtt: no such file or directory`) | ~15 s |
| controller-manager stopped | mirror pod gone in <= 5 s; scale accepted but no pods/ReplicaSets | Pods created ~21 s after restore |
| kubelet wrong CRI socket | kubelet `activating (auto-restart)` immediately; node NotReady ~51 s | node Ready ~4 s |

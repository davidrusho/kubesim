// crictl on a node host: the containers and Pod sandboxes the kubelet has made, in the shapes
// the capture shows (`crictl ps`, `ps -a`, `pods`, `logs`, `inspect`, `images`). There is no
// real runtime: the lists are derived from the Pods bound to the Node and their container state.

import type { Cluster, ContainerRuntime } from "@/lib/engine";
import { rfc3339, type Container, type Pod } from "@/lib/engine";
import { cluster_hash } from "@/lib/engine/controllers/kubelet";
import { hexId } from "@/lib/engine/host";
import { imageDigest, lookupImage } from "@/lib/engine/images";
import { err, out, type Res } from "./shell";

export interface RtContainer {
  id: string;
  image: string;
  imageId: string;
  created: number;
  state: "Running" | "Exited";
  name: string;
  attempt: number;
  podId: string;
  podName: string;
  ns: string;
  uid: string;
  exitCode?: number;
  finishedAt?: number;
  reason?: string;
  startedAt?: number;
}

export interface RtSandbox {
  id: string;
  created: number;
  state: "Ready" | "NotReady";
  name: string;
  ns: string;
}

/** go-units' HumanDuration, which crictl uses for CREATED. */
export function humanAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "Less than a second ago";
  if (s === 1) return "1 second ago";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m === 1) return "About a minute ago";
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h === 1) return "About an hour ago";
  if (h < 48) return `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (h < 24 * 14) return `${d} days ago`;
  if (h < 24 * 60) return `${Math.floor(d / 7)} weeks ago`;
  if (h < 24 * 730) return `${Math.floor(d / 30)} months ago`;
  return `${Math.floor(d / 365)} years ago`;
}

/** Columns the way crictl's tabwriter lays them out: each at least 20 wide, or its widest cell plus 3; the last is not padded. */
export function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(20, ...rows.map((r) => r[c].length + 3)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join("")).join("\n");
}

const shortId = (id: string) => id.slice(0, 13);

function podsOn(cluster: Cluster, node: string): Pod[] {
  return cluster.list<Pod>("Pod").filter((p) => p.spec?.nodeName === node && cluster.state.pods[p.metadata.uid]);
}

export function containersOn(cluster: Cluster, node: string): RtContainer[] {
  const rows: RtContainer[] = [];
  for (const pod of podsOn(cluster, node)) {
    const prt = cluster.state.pods[pod.metadata.uid];
    // A static Pod's containers belong to its manifest, not to the mirror Pod: deleting the mirror Pod does not change their IDs.
    const ident = pod.metadata.annotations?.["kubernetes.io/config.hash"] ?? pod.metadata.uid;
    for (const c of [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])] as Container[]) {
      const crt = prt.containers[c.name] as ContainerRuntime | undefined;
      if (!crt || crt.startedAt === undefined) continue;
      const running = crt.phase === "running" || crt.phase === "stopping";
      if (!running && crt.phase !== "exited" && crt.phase !== "crashBackoff" && crt.phase !== "done") continue;
      const { ref } = lookupImage(crt.image);
      rows.push({
        id: cluster_hash(ident + c.name + crt.restarts),
        image: ref.full,
        imageId: shortId(hexId(imageDigest(ref), 64)),
        created: crt.lastRunStart ?? crt.startedAt,
        state: running ? "Running" : "Exited",
        name: c.name,
        attempt: crt.restarts,
        podId: hexId(ident, 64),
        podName: pod.metadata.name,
        ns: pod.metadata.namespace ?? "default",
        uid: pod.metadata.uid,
        ...(running ? {} : { exitCode: crt.exitCode ?? 0, finishedAt: crt.until - 1000, reason: crt.exitReason ?? "Error" }),
        startedAt: crt.startedAt,
      });
      // The earlier attempts stay in `crictl ps -a` as Exited (capture 3c, 4a: ATTEMPT 1, 2, 3 listed together). Only the latest is
      // recorded exactly (`lastTerm`); the older ones, kept to the last three, are given the same exit a little earlier.
      const last = crt.lastTerm;
      const first = crt.lastRunStart ?? crt.startedAt;
      for (let a = crt.restarts - 1; a >= Math.max(0, crt.restarts - 3); a--) {
        const back = crt.restarts - 1 - a;
        const created = Math.max(0, (last?.startedAt ?? first - 20_000) - back * 20_000);
        rows.push({
          id: cluster_hash(ident + c.name + a),
          image: ref.full,
          imageId: shortId(hexId(imageDigest(ref), 64)),
          created,
          state: "Exited",
          name: c.name,
          attempt: a,
          podId: hexId(ident, 64),
          podName: pod.metadata.name,
          ns: pod.metadata.namespace ?? "default",
          uid: pod.metadata.uid,
          exitCode: last?.exitCode ?? 1,
          finishedAt: back === 0 && last ? last.finishedAt : created + 5_000,
          reason: last?.reason ?? "Error",
          startedAt: created,
        });
      }
    }
  }
  return rows.sort((a, b) => b.created - a.created || (a.name < b.name ? -1 : 1));
}

export function sandboxesOn(cluster: Cluster, node: string): RtSandbox[] {
  const rows: RtSandbox[] = [];
  for (const pod of podsOn(cluster, node)) {
    const prt = cluster.state.pods[pod.metadata.uid];
    if (!isFinite(prt.sandboxAt) || prt.sandboxAt > cluster.now + 600) continue;
    rows.push({ id: hexId(pod.metadata.annotations?.["kubernetes.io/config.hash"] ?? pod.metadata.uid, 64), created: prt.sandboxAt - 600, state: pod.metadata.deletionTimestamp !== undefined || pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed" ? "NotReady" : "Ready", name: pod.metadata.name, ns: pod.metadata.namespace ?? "default" });
  }
  return rows.sort((a, b) => b.created - a.created || (a.name < b.name ? -1 : 1));
}

const decimal = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1e3)}kB`);

export interface CrictlOpts {
  node: string;
  now: number;
  /** Whether the caller may use the runtime socket (root), and whether containerd is running. */
  root: boolean;
  containerdUp: boolean;
}

/** crictl's fatal line, as logrus prints it when not on a terminal (capture, kubeadm Ubuntu 24.04). */
const fatal = (now: number, msg: string) => err(`time="${rfc3339(now)}" level=fatal msg="${msg.replace(/"/g, '\\"')}"`);

export function crictl(cluster: Cluster, args: string[], o: CrictlOpts): Res {
  const sock = "unix:///run/containerd/containerd.sock";
  if (args[0] === "--version" || args[0] === "version") return out("crictl version v1.36.0");
  const verb = args.find((a) => !a.startsWith("-"));
  if (!verb) return out("NAME:\n   crictl - client for CRI\n\nUSAGE:\n   crictl [global options] command [command options]");
  if (!o.root) return fatal(o.now, `validate service connection: validate CRI v1 runtime API for endpoint "${sock}": rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied"`);
  if (!o.containerdUp) return fatal(o.now, `validate service connection: validate CRI v1 runtime API for endpoint "${sock}": rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: connection refused"`);
  const rest = args.slice(args.indexOf(verb) + 1);
  const flag = (name: string, short?: string) => rest.some((a) => a === `--${name}` || (short && a === `-${short}`));
  const value = (name: string, short?: string): string | undefined => {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === `--${name}` || (short && rest[i] === `-${short}`)) return rest[i + 1];
      if (rest[i].startsWith(`--${name}=`)) return rest[i].slice(name.length + 3);
    }
    return undefined;
  };
  const positional = () => rest.filter((a, i) => !a.startsWith("-") && !["--name", "--state", "--tail", "--label", "-o", "--output", "--pod", "--image"].includes(rest[i - 1] ?? ""));
  switch (verb) {
    case "ps": {
      let cs = containersOn(cluster, o.node);
      if (!flag("all", "a")) cs = cs.filter((c) => c.state === "Running");
      const name = value("name");
      if (name) cs = cs.filter((c) => new RegExp(name).test(c.name));
      const st = value("state");
      if (st) cs = cs.filter((c) => c.state.toLowerCase() === st.toLowerCase());
      if (flag("quiet", "q")) return out(cs.map((c) => c.id).join("\n"));
      return out(table([["CONTAINER", "IMAGE", "CREATED", "STATE", "NAME", "ATTEMPT", "POD ID", "POD", "NAMESPACE"], ...cs.map((c) => [shortId(c.id), c.imageId, humanAgo(o.now - c.created), c.state, c.name, String(c.attempt), shortId(c.podId), c.podName, c.ns])]));
    }
    case "pods": {
      let ps = sandboxesOn(cluster, o.node);
      const name = value("name");
      if (name) ps = ps.filter((p) => new RegExp(name).test(p.name));
      if (flag("quiet", "q")) return out(ps.map((p) => p.id).join("\n"));
      return out(table([["POD ID", "CREATED", "STATE", "NAME", "NAMESPACE", "ATTEMPT", "RUNTIME"], ...ps.map((p) => [shortId(p.id), humanAgo(o.now - p.created), p.state, p.name, p.ns, "0", "(default)"])]));
    }
    case "logs":
    case "inspect": {
      const id = positional()[0];
      if (!id) return fatal(o.now, `${verb}: container ID cannot be empty`); // crictl prints its usage first
      const c = containersOn(cluster, o.node).find((x) => x.id.startsWith(id));
      if (!c) return fatal(o.now, `rpc error: code = NotFound desc = an error occurred when try to find container "${id}": not found`);
      if (verb === "inspect") return out(inspectJson(c));
      const lines = (cluster.state.logs[`${c.uid}/${c.name}/${c.attempt}`] ?? []).map((l) => l.text);
      const tail = value("tail");
      return out((tail ? lines.slice(-parseInt(tail, 10)) : lines).join("\n"));
    }
    case "images":
    case "img": {
      const rt = cluster.state.nodes[o.node];
      const rows = (rt?.images ?? []).map((full) => {
        const m = /^(.*):([^:/]+)$/.exec(full) ?? [full, full, "latest"];
        const { info, ref } = lookupImage(full);
        return [m[1], m[2], shortId(hexId(imageDigest(ref), 64)), decimal(info?.sizeBytes ?? 20_000_000)];
      });
      rows.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
      return out(table([["IMAGE", "TAG", "IMAGE ID", "SIZE"], ...rows]));
    }
  }
  return err(`No help topic for '${verb}'`);
}

function inspectJson(c: RtContainer): string {
  const iso = rfc3339;
  return JSON.stringify(
    {
      status: {
        id: c.id,
        metadata: { attempt: c.attempt, name: c.name },
        state: c.state === "Running" ? "CONTAINER_RUNNING" : "CONTAINER_EXITED",
        createdAt: iso(c.created),
        startedAt: iso(c.startedAt ?? c.created),
        finishedAt: c.finishedAt !== undefined ? iso(c.finishedAt) : "0001-01-01T00:00:00Z",
        exitCode: c.exitCode ?? 0,
        image: { annotations: {}, image: c.image, runtimeHandler: "" },
        imageRef: c.image,
        reason: c.reason ?? "",
        message: "",
        labels: { "io.kubernetes.container.name": c.name, "io.kubernetes.pod.name": c.podName, "io.kubernetes.pod.namespace": c.ns, "io.kubernetes.pod.uid": c.uid },
        annotations: { "io.kubernetes.container.restartCount": String(c.attempt) },
        mounts: [],
        logPath: `/var/log/pods/${c.ns}_${c.podName}_${c.uid}/${c.name}/${c.attempt}.log`,
      },
    },
    null,
    2,
  );
}

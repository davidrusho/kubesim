// The terminal on a Node's host (ADR 0003, decision 6): `ssh <node>`, the prompt, files by
// absolute path, `systemctl`, `journalctl` and `crictl`, with the output shapes from
// docs/research/real-cluster-captures-control-plane.md.

import type { Cluster } from "@/lib/engine";
import {
  HOME_DIR,
  basename,
  dirname,
  hostWrite,
  isHostDir,
  isHostPath,
  journalStamp,
  klogStamp,
  listHostDir,
  normPath,
  sinceAgo,
  systemdStamp,
  unitPaths,
  type HostFile,
  type HostState,
  type ServiceName,
} from "@/lib/engine/host";
import {
  SERVICE_DESCRIPTION,
  SERVICE_DOCS,
  UNIT_NAMES,
  daemonReload,
  needsReload,
  restartService,
  setEnabled,
  startService,
  stopService,
} from "@/lib/engine/hostservices";
import { FsError, err, out, type Chunk, type HostEntry, type HostSession, type HostView, type Res, type ShellState } from "./shell";
import { crictl } from "./crictl";

export interface HostCtx {
  cluster: Cluster;
  shell?: ShellState;
}

export const currentSession = (sh?: ShellState): HostSession | undefined => sh?.sessions.at(-1);

/** `candidate@controlplane:~$`, or `root@controlplane:~#` after `sudo -i`. */
export const promptFor = (s: HostSession): string => `${s.user}@${s.node}:~${s.user === "root" ? "#" : "$"}`;

// ---------------------------------------------------------------- files

const inRootHome = (p: string) => p === "/root" || p.startsWith("/root/");
const canRead = (user: HostSession["user"], p: string, f: HostFile) => user === "root" || (!inRootHome(p) && (f.mode & 0o004) !== 0);
/** The candidate may write only in /tmp: everything else on a node belongs to root. */
const canWrite = (user: HostSession["user"], p: string) => user === "root" || p.startsWith("/tmp/");

const sizeOf = (f: HostFile) => new TextEncoder().encode(f.content).length;

/**
 * The Learner's files plus the Node's: `files` answers for absolute host paths too, so `cat`,
 * redirections, `rm`, `grep` and the editor work on `/etc/kubernetes/manifests/…` unchanged. The
 * session's user is read on every access, so `sudo` can change it for one command.
 */
export function hostEnv(cluster: Cluster, sess: HostSession, home: Record<string, string>): { files: Record<string, string>; host: HostView } {
  const host = (): HostState => cluster.state.hosts[sess.node];
  const assertWritable = (path: string, p: string) => {
    if (!canWrite(sess.user, p)) throw new FsError("denied", path);
    if (!isHostDir(host(), dirname(p))) throw new FsError("missing", path);
  };
  const files = new Proxy(home, {
    get(target, prop) {
      if (typeof prop !== "string" || !isHostPath(prop)) return Reflect.get(target, prop);
      const p = normPath(prop);
      const f = host().files[p];
      if (!f) {
        if (isHostDir(host(), p)) throw new FsError("isdir", prop);
        return undefined;
      }
      if (!canRead(sess.user, p, f)) throw new FsError("denied", prop);
      return f.content;
    },
    set(target, prop, value) {
      if (typeof prop !== "string" || !isHostPath(prop)) return Reflect.set(target, prop, value);
      const p = normPath(prop);
      if (isHostDir(host(), p) && !host().files[p]) throw new FsError("isdir", prop);
      assertWritable(prop, p);
      hostWrite(host(), p, String(value), cluster.now);
      cluster.hostChanged();
      return true;
    },
    deleteProperty(target, prop) {
      if (typeof prop !== "string" || !isHostPath(prop)) return Reflect.deleteProperty(target, prop);
      const p = normPath(prop);
      if (!host().files[p]) return true;
      if (!canWrite(sess.user, p)) throw new FsError("denied", prop);
      delete host().files[p];
      cluster.hostChanged();
      return true;
    },
    has(target, prop) {
      if (typeof prop !== "string" || !isHostPath(prop)) return Reflect.has(target, prop);
      return !!host().files[normPath(prop)];
    },
  });

  const entry = (name: string, f?: HostFile): HostEntry => (f ? { name, dir: false, mode: f.mode, size: sizeOf(f), mtime: f.mtime } : { name, dir: true, mode: 0o755, size: 4096, mtime: 0 });
  const view: HostView = {
    node: sess.node,
    owns: (path) => isHostPath(path),
    isDir: (path) => isHostDir(host(), path) && !host().files[normPath(path)],
    ls(path) {
      const p = normPath(path);
      const f = host().files[p];
      if (inRootHome(p) && sess.user !== "root") throw new FsError("denied", path);
      if (f) return { dir: false, entries: [entry(basename(p), f)] };
      if (!isHostDir(host(), p)) return undefined;
      return { dir: true, entries: listHostDir(host(), p).map((e) => entry(e.name, e.file)) };
    },
    move(src, dst) {
      const s = normPath(src);
      const d = normPath(dst);
      const f = host().files[s];
      if (!f) throw new FsError("missing", src);
      if (!canWrite(sess.user, s)) throw new FsError("denied", src);
      assertWritable(dst, d);
      // A move keeps the file as it is: mode and modification time included.
      host().files[d] = { ...f };
      delete host().files[s];
      cluster.hostChanged();
    },
    copy(src, dst, preserve) {
      const s = normPath(src);
      const d = normPath(dst);
      const f = host().files[s];
      if (!f) throw new FsError("missing", src);
      if (!canRead(sess.user, s, f)) throw new FsError("denied", src);
      assertWritable(dst, d);
      const prev = host().files[d];
      host().files[d] = preserve ? { ...f } : { ...f, mode: prev?.mode ?? f.mode & ~0o022, mtime: cluster.now };
      cluster.hostChanged();
    },
    checkEdit(path) {
      const p = normPath(path);
      const f = host().files[p];
      if (f && (!canRead(sess.user, p, f) || !canWrite(sess.user, p))) throw new FsError("denied", path);
      if (!f) assertWritable(path, p);
    },
    asRoot<T>(fn: () => T): T {
      const was = sess.user;
      sess.user = "root";
      try {
        return fn();
      } finally {
        sess.user = was;
      }
    },
  };
  return { files, host: view };
}

// ---------------------------------------------------------------- ssh

function ssh(ctx: HostCtx, args: string[]): Res {
  const sh = ctx.shell!;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (/^-[ilpFJoLRDbcemw]$/.test(args[i])) i++;
    else if (!args[i].startsWith("-")) pos.push(args[i]);
  }
  if (!pos.length) return err("usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address] [-c cipher_spec]\n           [-D [bind_address:]port] [-E log_file] [-e escape_char] [-F configfile]\n           [-I pkcs11] [-i identity_file] [-J destination] [-L address]\n           [-l login_name] [-m mac_spec] [-O ctl_cmd] [-o option] [-p port] [-R address]\n           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n           destination [command [argument ...]]");
  const [user, name] = pos[0].includes("@") ? (pos[0].split("@") as [string, string]) : ["candidate", pos[0]];
  if (sh.sessions.length) return err(`${user}@${name}: Permission denied (publickey).`);
  const host = ctx.cluster.state.hosts[name];
  if (!host) return err(`ssh: Could not resolve hostname ${name}: Name or service not known`);
  if (!ctx.cluster.state.nodes[name]?.up) return err(`ssh: connect to host ${name} port 22: Connection timed out`);
  if (user !== "candidate") return err(`${user}@${name}: Permission denied (publickey).`);
  if (pos.length > 1) return err(`ssh: the simulator opens a login on the node: run "ssh ${name}" and type the command there.`);
  sh.sessions.push({ node: name, user: "candidate", via: "ssh" });
  return out("");
}

/**
 * kubectl with no kubeconfig falls back to localhost:8080: five discovery errors, then the refusal
 * (capture, kubeadm Ubuntu 24.04, `kubectl get nodes` as candidate). Commands that never reach the server just run.
 */
function noKubeconfig(cluster: Cluster, node: string, words: string[]): Res | undefined {
  const verb = words.find((w) => !w.startsWith("-"));
  if (!verb || ["config", "help", "options", "completion"].includes(verb) || words.includes("--help") || words.includes("-h")) return undefined;
  const host = cluster.state.hosts[node];
  const pid = 200000 + (host.nextPid += 7);
  const chunks: Chunk[] = [];
  for (let i = 0; i < 5; i++) {
    const stamp = klogStamp("E", cluster.now, host.seq++);
    chunks.push({ fd: 2, text: `${stamp} ${String(pid).padStart(7, " ")} memcache.go:265] "Unhandled Error" err="couldn't get current server API group list: Get \\"http://localhost:8080/api?timeout=32s\\": dial tcp [::1]:8080: connect: connection refused"` });
  }
  chunks.push({ fd: 2, text: "The connection to the server localhost:8080 was refused - did you specify the right host or port?" });
  return { chunks, ok: false };
}

/** kubectl on a node: only the control plane has a kubeconfig (admin.conf, readable by root); elsewhere it finds no cluster. */
export function kubectlOnNode(ctx: HostCtx, words: string[]): Res | undefined {
  const sess = currentSession(ctx.shell);
  if (!sess) return undefined;
  const host = ctx.cluster.state.hosts[sess.node];
  let conf: string | undefined;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--kubeconfig") conf = words[i + 1];
    else if (words[i].startsWith("--kubeconfig=")) conf = words[i].slice(13);
  }
  conf ??= ctx.shell?.vars.get("KUBECONFIG")?.value || undefined;
  if (conf === undefined) return noKubeconfig(ctx.cluster, sess.node, words);
  const p = normPath(conf);
  const f = host.files[p];
  if (!f) return err(`error: error loading config file "${conf}": open ${conf}: no such file or directory`);
  if (!(f.mode & 0o004) && sess.user !== "root") return err(`error: error loading config file "${conf}": open ${conf}: permission denied`);
  if (host.role !== "control-plane" || !/\/(super-)?admin\.conf$/.test(p)) return noKubeconfig(ctx.cluster, sess.node, words);
  return undefined;
}

// ---------------------------------------------------------------- systemctl

const unitName = (u: ServiceName) => `${u}.service`;
const unitFile = (host: HostState, u: ServiceName) => unitPaths(host.files).find((p) => p.endsWith(`/${unitName(u)}`) && p.startsWith("/usr/lib")) ?? unitPaths(host.files).find((p) => p.endsWith(`/${unitName(u)}`));

function dropIns(host: HostState, u: ServiceName): string[] {
  return unitPaths(host.files)
    .filter((p) => p.includes(`/${unitName(u)}.d/`))
    .sort((a, b) => (basename(a) < basename(b) ? -1 : 1));
}

const RELOAD_WARNING = (u: ServiceName) => `Warning: The unit file, source configuration file or drop-ins of ${unitName(u)} changed on disk. Run 'systemctl daemon-reload' to reload units.`;

function statusText(cluster: Cluster, node: string, u: ServiceName, root: boolean): { text: string; ok: boolean } {
  const host = cluster.state.hosts[node];
  const svc = host.services[u];
  const now = cluster.now;
  const file = unitFile(host, u)!;
  const drops = dropIns(host, u);
  const glyph = svc.active === "active" ? "●" : svc.active === "failed" ? "×" : svc.active === "activating" ? "●" : "○";
  const lines = [`${glyph} ${unitName(u)} - ${SERVICE_DESCRIPTION[u]}`, `     Loaded: loaded (${file}; ${svc.enabled ? "enabled" : "disabled"}; preset: enabled)`];
  if (drops.length) {
    lines.push(`    Drop-In: ${dirname(drops[0])}`);
    lines.push(`             └─${drops.map(basename).join(", ")}`);
  }
  const ago = sinceAgo(now - svc.since);
  if (svc.active === "active") lines.push(`     Active: active (running) since ${systemdStamp(svc.since)}; ${ago}`);
  else if (svc.active === "activating") lines.push(`     Active: activating (auto-restart) (Result: exit-code) since ${systemdStamp(svc.since)}; ${ago}`);
  else if (svc.active === "failed") lines.push(`     Active: failed (Result: exit-code) since ${systemdStamp(svc.since)}; ${ago}`);
  else lines.push(`     Active: inactive (dead) since ${systemdStamp(svc.since)}; ${ago}`);
  if (svc.active === "inactive" && svc.duration !== undefined) lines.push(`   Duration: ${(svc.duration / 1000).toFixed(3).replace(/\.?0+$/, "")}s`);
  lines.push(` Invocation: ${svc.invocation}`, `       Docs: ${SERVICE_DOCS[u]}`);
  const exec = svc.execStart ?? (u === "containerd" ? "/usr/bin/containerd" : "/usr/bin/kubelet");
  const exit = svc.active === "activating" || svc.active === "failed" ? `(code=exited, status=${svc.failure?.status ?? "1/FAILURE"})` : "(code=exited, status=0/SUCCESS)";
  if (svc.active === "active") {
    const up = (now - svc.since) / 1000;
    lines.push(`   Main PID: ${svc.pid} (${u})`, `      Tasks: ${u === "kubelet" ? 16 : 24} (limit: 2871)`, `     Memory: ${(u === "kubelet" ? 35.2 : 28.4).toFixed(1)}M (peak: ${(u === "kubelet" ? 36.1 : 29.0).toFixed(1)}M)`, `        CPU: ${(0.9 + up * 0.025).toFixed(3)}s`, `     CGroup: /system.slice/${unitName(u)}`, `             └─${svc.pid} ${svc.cmdline ?? exec}`);
  } else {
    lines.push(`    Process: ${svc.pid} ExecStart=${exec} ${exit}`, `   Main PID: ${svc.pid} ${exit}`, `   Mem peak: ${u === "kubelet" ? "26.4" : "28.2"}M`, `        CPU: 574ms`);
  }
  const ring = host.journal[u] ?? [];
  if (root) {
    lines.push("");
    for (const j of ring.slice(-10)) lines.push(`${journalStamp(j.t)} ${node} ${j.text}`);
  }
  if (needsReload(host, u)) lines.push("", RELOAD_WARNING(u));
  return { text: lines.join("\n"), ok: svc.active === "active" };
}

function systemctl(ctx: HostCtx, sess: HostSession, args: string[]): Res {
  const cluster = ctx.cluster;
  const node = sess.node;
  const host = cluster.state.hosts[node];
  const flags = args.filter((a) => a.startsWith("-"));
  const pos = args.filter((a) => !a.startsWith("-"));
  const verb = pos[0];
  const unitsArg = pos.slice(1);
  const root = sess.user === "root";
  const now = flags.includes("--now");
  if (!verb) return out("");
  const need = (min = 1): Res | undefined => (unitsArg.length >= min ? undefined : err(`Too few arguments.`));
  const find = (raw: string): ServiceName | undefined => UNIT_NAMES[raw];
  const notFound = (raw: string, how: "status" | "start" | "enable" | "cat") =>
    how === "status" ? `Unit ${raw.endsWith(".service") ? raw : raw + ".service"} could not be found.` : how === "start" ? `Failed to ${verb} ${raw.endsWith(".service") ? raw : raw + ".service"}: Unit ${raw.endsWith(".service") ? raw : raw + ".service"} not found.` : how === "enable" ? `Failed to ${verb} unit: Unit file ${raw.endsWith(".service") ? raw : raw + ".service"} does not exist.` : `No files found for ${raw.endsWith(".service") ? raw : raw + ".service"}.`;
  // polkit refuses a user who is not root: systemd says so and points at the unit's status.
  const denied = (what: string, unit?: ServiceName) => err(`${what}: Interactive authentication required.${unit ? `\nSee system logs and 'systemctl status ${unitName(unit)}' for details.` : ""}`);

  switch (verb) {
    case "status": {
      const bad = need();
      if (bad) return bad;
      const chunks: Chunk[] = [];
      let ok = true;
      for (const raw of unitsArg) {
        const u = find(raw);
        if (!u) {
          chunks.push({ fd: 2, text: notFound(raw, "status") });
          ok = false;
          continue;
        }
        const st = statusText(cluster, node, u, root);
        chunks.push({ fd: 1, text: st.text });
        if (!st.ok) ok = false;
      }
      return { chunks, ok };
    }
    case "is-active": {
      const bad = need();
      if (bad) return bad;
      const rows = unitsArg.map((raw) => {
        const u = find(raw);
        return u ? host.services[u].active : "inactive";
      });
      return { chunks: [{ fd: 1, text: rows.join("\n") }], ok: rows.every((r) => r === "active") };
    }
    case "is-enabled": {
      const bad = need();
      if (bad) return bad;
      const chunks: Chunk[] = [];
      let ok = true;
      for (const raw of unitsArg) {
        const u = find(raw);
        if (!u) {
          chunks.push({ fd: 2, text: `Failed to get unit file state for ${raw.endsWith(".service") ? raw : raw + ".service"}: No such file or directory` });
          ok = false;
        } else {
          chunks.push({ fd: 1, text: host.services[u].enabled ? "enabled" : "disabled" });
          if (!host.services[u].enabled) ok = false;
        }
      }
      return { chunks, ok };
    }
    case "cat": {
      const bad = need();
      if (bad) return bad;
      const chunks: Chunk[] = [];
      let ok = true;
      for (const raw of unitsArg) {
        const u = find(raw);
        if (!u) {
          chunks.push({ fd: 2, text: notFound(raw, "cat") });
          ok = false;
          continue;
        }
        const parts = [unitFile(host, u)!, ...dropIns(host, u)].map((p) => `# ${p}\n${host.files[p].content.replace(/\n$/, "")}`);
        chunks.push({ fd: 1, text: parts.join("\n\n") });
      }
      return { chunks, ok };
    }
    case "daemon-reload":
      if (!root) return denied("Failed to reload daemon");
      daemonReload(cluster, node);
      return out("");
    case "start":
    case "stop":
    case "restart":
    case "reload": {
      const bad = need();
      if (bad) return bad;
      const chunks: Chunk[] = [];
      let ok = true;
      for (const raw of unitsArg) {
        const u = find(raw);
        if (!u) {
          chunks.push({ fd: 2, text: notFound(raw, "start") });
          ok = false;
          continue;
        }
        if (!root) return denied(`Failed to ${verb} ${unitName(u)}`, u);
        if (verb === "reload") {
          chunks.push({ fd: 2, text: `Failed to reload ${unitName(u)}: Job type reload is not applicable for unit ${unitName(u)}.` });
          ok = false;
          continue;
        }
        if (verb !== "stop" && needsReload(host, u)) chunks.push({ fd: 2, text: RELOAD_WARNING(u) });
        if (verb === "start") startService(cluster, node, u);
        else if (verb === "stop") stopService(cluster, node, u);
        else restartService(cluster, node, u);
      }
      return { chunks, ok };
    }
    case "enable":
    case "disable": {
      const bad = need();
      if (bad) return bad;
      const chunks: Chunk[] = [];
      let ok = true;
      for (const raw of unitsArg) {
        const u = find(raw);
        if (!u) {
          chunks.push({ fd: 2, text: notFound(raw, "enable") });
          ok = false;
          continue;
        }
        if (!root) return denied(`Failed to ${verb} unit`);
        const svc = host.services[u];
        const link = `/etc/systemd/system/multi-user.target.wants/${unitName(u)}`;
        if (verb === "enable" && !svc.enabled) chunks.push({ fd: 1, text: `Created symlink '${link}' → '${unitFile(host, u)}'.` });
        if (verb === "disable" && svc.enabled) chunks.push({ fd: 1, text: `Removed '${link}'.` });
        setEnabled(cluster, node, u, verb === "enable");
        if (now) {
          if (verb === "enable") startService(cluster, node, u);
          else stopService(cluster, node, u);
        }
      }
      return { chunks, ok };
    }
  }
  return err(`Unknown command verb '${verb}'.`);
}

// ---------------------------------------------------------------- journalctl

/** `--since`: the relative forms people type (`-90s`, `-5min`, `10 minutes ago`); undefined when it is something else. */
function sinceMs(text: string): number | undefined {
  const m = /^-?\s*(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?|d|days?)(\s+ago)?$/.exec(text.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const u = m[2][0] === "m" && m[2] !== "months" ? 60_000 : m[2][0] === "h" ? 3_600_000 : m[2][0] === "d" ? 86_400_000 : 1000;
  return n * u;
}

function journalctl(ctx: HostCtx, sess: HostSession, args: string[]): Res {
  const cluster = ctx.cluster;
  const node = sess.node;
  const host = cluster.state.hosts[node];
  const units: ServiceName[] = [];
  let lines: number | undefined;
  let follow = false;
  let reverse = false;
  let since: number | undefined;
  let quiet = false;
  let unknown = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // A unit that is not modelled has no entries.
    const unit = (v: string | undefined) => {
      const u = v === undefined ? undefined : UNIT_NAMES[v];
      if (u) units.push(u);
      else unknown = true;
    };
    if (a === "-u" || a === "--unit") unit(args[++i]);
    else if (a.startsWith("--unit=")) unit(a.slice(7));
    else if (a === "-n" || a === "--lines") lines = parseInt(args[++i] ?? "", 10);
    else if (a.startsWith("--lines=")) lines = parseInt(a.slice(8), 10);
    else if (/^-n\d+$/.test(a)) lines = parseInt(a.slice(2), 10);
    else if (a === "--since" || a === "-S") {
      const v = args[++i] ?? "";
      since = sinceMs(v);
      if (since === undefined) return err(`Failed to parse timestamp: ${v}`);
    } else if (a.startsWith("--since=")) {
      since = sinceMs(a.slice(8));
      if (since === undefined) return err(`Failed to parse timestamp: ${a.slice(8)}`);
    } else if (a === "--follow") follow = true;
    else if (a === "--reverse") reverse = true;
    else if (a === "--no-pager" || a === "--no-hostname" || a === "--utc") continue;
    else if (a.startsWith("--")) return err(`journalctl: unrecognized option '${a}'`);
    else if (a.startsWith("-") && a.length > 1) {
      // Clusters like -fu, -xeu, -rn.
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === "f") follow = true;
        else if (ch === "r") reverse = true;
        else if (ch === "q") quiet = true;
        else if (ch === "u" || ch === "n") {
          const v = a.slice(k + 1) || args[++i];
          if (ch === "u") unit(v);
          else lines = parseInt(v ?? "", 10);
          break;
        } else if (!"xeabklmo".includes(ch)) return err(`journalctl: invalid option -- '${ch}'`);
      }
    }
  }
  if (sess.user !== "root") {
    // Not an error: the candidate sees nothing (capture, kubeadm Ubuntu 24.04: exit 0).
    const hint = quiet ? [] : ["Hint: You are currently not seeing messages from other users and the system.", "      Users in groups 'adm', 'systemd-journal' can see all messages.", "      Pass -q to turn off this notice."];
    return out([...hint, "-- No entries --"].join("\n"));
  }
  const want = units.length ? units : unknown ? [] : (["containerd", "kubelet"] as ServiceName[]);
  let rows = want.flatMap((u) => host.journal[u] ?? []).sort((a, b) => a.t - b.t);
  if (since !== undefined) rows = rows.filter((r) => r.t >= cluster.now - since!);
  const n = lines !== undefined && !isNaN(lines) ? lines : follow ? 10 : undefined;
  if (n !== undefined) rows = n === 0 ? [] : rows.slice(-n);
  if (reverse) rows = [...rows].reverse();
  const body = rows.length ? rows.map((r) => `${journalStamp(r.t)} ${node} ${r.text}`).join("\n") : "-- No entries --";
  const res: Res = { chunks: [{ fd: 1, text: body }], ok: true };
  if (!follow) return res;
  // Streaming re-runs the command without -f: it shows the last lines again as the terminal refreshes.
  return { ...res, watch: `journalctl ${units.map((u) => `-u ${u}`).join(" ")} -n ${n ?? 10} --no-pager`.replace("journalctl  ", "journalctl ") };
}

// ---------------------------------------------------------------- dispatch

/** The commands only a node host has, plus `ssh` from the base terminal. Undefined: not one of ours. */
export function hostCommand(ctx: HostCtx, words: string[]): Res | undefined {
  if (words[0] === "ssh") return ssh(ctx, words.slice(1));
  const sess = currentSession(ctx.shell);
  if (!sess) return undefined;
  switch (words[0]) {
    case "systemctl":
      return systemctl(ctx, sess, words.slice(1));
    case "journalctl":
      return journalctl(ctx, sess, words.slice(1));
    case "crictl": {
      const host = ctx.cluster.state.hosts[sess.node];
      return crictl(ctx.cluster, words.slice(1), { node: sess.node, now: ctx.cluster.now, root: sess.user === "root", containerdUp: host.services.containerd.active === "active" });
    }
    case "hostname":
      return out(sess.node);
  }
  return undefined;
}

export { HOME_DIR };

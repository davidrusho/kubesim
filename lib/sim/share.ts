// Shareable Sandbox links: the cluster snapshot, trimmed (no Events, logs or
// metrics) and deflate-compressed, in the URL hash. Nothing leaves the
// browser until the Learner shares the link themselves; there is no backend.
//
// A link is untrusted input: it is size-capped before and after
// decompression, parsed without prototype-ish keys, and checked for the shape
// the engine needs before it is ever handed to a Cluster.

import { objKey, type ClusterState } from "@/lib/engine";

export const SHARE_PARAM = "cluster";
const VERSION = "1";

/** Drops what a shared cluster can do without: Events, container logs, metrics samples. */
export function trimForShare(state: ClusterState): ClusterState {
  const objects: ClusterState["objects"] = {};
  for (const [k, o] of Object.entries(state.objects)) if (o.kind !== "Event") objects[k] = o;
  const pods: ClusterState["pods"] = {};
  for (const [uid, p] of Object.entries(state.pods)) {
    pods[uid] = { ...p, containers: Object.fromEntries(Object.entries(p.containers).map(([n, c]) => [n, { ...c, reqs: [], flow: undefined }])) };
  }
  return { ...state, objects, pods, logs: {}, metrics: { at: 0, pods: {}, nodes: {} }, loadStats: undefined, loadLost: undefined };
}

function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Limits for what a link may hold. A kubesim cluster worth sharing is far smaller. */
export const SHARE_LIMITS = {
  /** Characters of the encoded token (a URL this long is already unusual). */
  token: 2_000_000,
  /** Bytes after decompression (anything bigger is a zip bomb or garbage). */
  bytes: 8 * 1024 * 1024,
  objects: 3000,
  pods: 600,
  nodes: 50,
  /** Per Node host. */
  hostFiles: 200,
  fileBytes: 64 * 1024,
  journalLines: 300,
};

const TOO_LARGE = "That link is too large to be a kubesim cluster.";
const NOT_A_CLUSTER = "That link doesn't contain a cluster.";

async function pipe(data: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([data]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new LinkError(TOO_LARGE);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** An error whose message is meant for the Learner. */
class LinkError extends Error {}

/** JSON.parse that refuses keys which could reach an object's prototype. */
function parseSafe(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (FORBIDDEN_KEYS.has(key)) throw new LinkError(NOT_A_CLUSTER);
    return value;
  });
}

const isName = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 253;

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max = 1000) => typeof v === "string" && v.length <= max;
const optStr = (v: unknown, max = 1000) => v === undefined || str(v, max);
const optNum = (v: unknown) => v === undefined || num(v);

function soundService(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const f = v.failure;
  return (
    typeof v.enabled === "boolean" &&
    (v.active === "active" || v.active === "inactive" || v.active === "failed" || v.active === "activating") &&
    num(v.since) &&
    num(v.restarts) &&
    num(v.pid) &&
    str(v.invocation, 100) &&
    optNum(v.duration) &&
    optStr(v.execStart) &&
    optStr(v.cmdline) &&
    optStr(v.staticPodPath) &&
    (f === undefined || (isRecord(f) && str(f.status, 100) && num(f.retryAt)))
  );
}

/** A host block with every field the engine reads of the right type, and counts and sizes a cluster worth sharing never reaches. */
function soundHost(h: unknown): boolean {
  if (!isRecord(h) || (h.role !== "control-plane" && h.role !== "worker") || !num(h.nextPid) || !num(h.seq)) return false;
  if (!isRecord(h.services) || !soundService(h.services.kubelet) || !soundService(h.services.containerd)) return false;
  if (!isRecord(h.files) || Object.keys(h.files).length > SHARE_LIMITS.hostFiles) return false;
  for (const [p, f] of Object.entries(h.files)) {
    if (!str(p, 500) || !isRecord(f) || !str(f.content, SHARE_LIMITS.fileBytes) || !num(f.mode) || !num(f.mtime) || (f.opaque !== undefined && typeof f.opaque !== "boolean")) return false;
  }
  if (!isRecord(h.journal) || Object.keys(h.journal).length > 4) return false;
  for (const l of Object.values(h.journal)) {
    if (!Array.isArray(l) || l.length > SHARE_LIMITS.journalLines || !l.every((x) => isRecord(x) && num(x.t) && str(x.text, 4000))) return false;
  }
  if (!isRecord(h.loaded) || Object.keys(h.loaded).length > 50 || !Object.values(h.loaded).every((t) => str(t, SHARE_LIMITS.fileBytes))) return false;
  if (!isRecord(h.static) || Object.keys(h.static).length > SHARE_LIMITS.hostFiles) return false;
  for (const e of Object.values(h.static)) {
    if (!isRecord(e) || !str(e.hash, 100) || !optStr(e.pod, 600) || !optNum(e.createAt) || !optStr(e.logged, 200)) return false;
    if (e.bad !== undefined && !(isRecord(e.bad) && str(e.bad.err, 4000) && num(e.bad.loggedAt))) return false;
  }
  return true;
}

/** The parts of a snapshot the engine can't start without, with sane sizes. */
function checkCluster(v: unknown): ClusterState {
  if (!isRecord(v) || !isRecord(v.config) || !isRecord(v.objects) || !isRecord(v.pods) || !isRecord(v.nodes)) throw new LinkError(NOT_A_CLUSTER);
  for (const k of ["now", "rng", "rv"] as const) if (typeof v[k] !== "number" || !Number.isFinite(v[k])) throw new LinkError(NOT_A_CLUSTER);
  for (const k of ["logs", "volumes", "scheduleAttempts", "timers", "hpa"] as const) if (v[k] !== undefined && !isRecord(v[k])) throw new LinkError(NOT_A_CLUSTER);
  const objects = Object.entries(v.objects);
  const pods = Object.entries(v.pods);
  const nodes = Object.entries(v.nodes);
  if (objects.length > SHARE_LIMITS.objects || pods.length > SHARE_LIMITS.pods || nodes.length > SHARE_LIMITS.nodes) throw new LinkError(TOO_LARGE);
  for (const [key, o] of objects) {
    if (!isRecord(o) || typeof o.kind !== "string" || !isRecord(o.metadata)) throw new LinkError(NOT_A_CLUSTER);
    const m = o.metadata;
    if (!isName(m.name) || (m.namespace !== undefined && !isName(m.namespace)) || (m.uid !== undefined && typeof m.uid !== "string")) throw new LinkError(NOT_A_CLUSTER);
    if (m.labels !== undefined && !isRecord(m.labels)) throw new LinkError(NOT_A_CLUSTER);
    if (o.spec !== undefined && !isRecord(o.spec)) throw new LinkError(NOT_A_CLUSTER);
    // Every object sits under the key the engine itself would give it.
    if (key !== objKey(o.kind, m.namespace as string | undefined, m.name as string)) throw new LinkError(NOT_A_CLUSTER);
  }
  for (const [, p] of pods) if (!isRecord(p) || !isRecord(p.containers)) throw new LinkError(NOT_A_CLUSTER);
  for (const [, n] of nodes) if (!isRecord(n)) throw new LinkError(NOT_A_CLUSTER);
  // Node hosts (ADR 0003): the engine reads their services, files and journals on every step, so a block of the wrong shape or size is dropped and rebuilt as the defaults.
  if (v.hosts !== undefined && !(isRecord(v.hosts) && Object.keys(v.hosts).length <= SHARE_LIMITS.nodes && Object.values(v.hosts).every(soundHost))) delete v.hosts;
  // Card positions: a capped map of finite numbers, or dropped.
  if (v.layout !== undefined) {
    const ok = isRecord(v.layout) && Object.keys(v.layout).length <= SHARE_LIMITS.objects && Object.values(v.layout).every((p) => isRecord(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x as number) < 1e5 && Math.abs(p.y as number) < 1e5);
    if (!ok) delete v.layout;
  }
  return v as unknown as ClusterState;
}

export async function encodeCluster(state: ClusterState): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(trimForShare(state)));
  const packed = await pipe(json, new CompressionStream("deflate-raw"));
  return `${VERSION}.${toB64Url(packed)}`;
}

export async function decodeCluster(token: string): Promise<ClusterState> {
  if (token.length > SHARE_LIMITS.token) throw new Error(TOO_LARGE);
  const [v, body] = token.split(".");
  if (v !== VERSION || !body) throw new Error("This link was made by a different version of kubesim.");
  try {
    const json = await pipe(fromB64Url(body), new DecompressionStream("deflate-raw"), SHARE_LIMITS.bytes);
    return checkCluster(parseSafe(new TextDecoder("utf-8", { fatal: true }).decode(json)));
  } catch (e) {
    if (e instanceof LinkError) throw new Error(e.message);
    throw new Error("That link is damaged (was it cut short when it was copied?).");
  }
}

/** The share token in a URL hash like #cluster=1.abc…, if any. A token that isn't valid percent-encoding comes back as "" (which fails to decode, with a message). */
export function tokenFromHash(hash: string): string | undefined {
  const m = hash.replace(/^#/, "").split("&").find((kv) => kv.startsWith(`${SHARE_PARAM}=`));
  if (!m) return undefined;
  try {
    return decodeURIComponent(m.slice(SHARE_PARAM.length + 1));
  } catch {
    return "";
  }
}

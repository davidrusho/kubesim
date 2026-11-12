// A faithful-enough kubectl for the Simulated Cluster. The shell (shell.ts)
// splits a line into commands; this file resolves the kubectl command path,
// parses its flags from the per-command tables (args.ts), checks RBAC when
// impersonating (--as), talks to the Cluster API and prints what real kubectl
// prints, honouring --dry-run and -o on every command that changes things.

import {
  ApiError,
  Cluster,
  apiServerRefusal,
  KIND_LIST,
  authorize,
  forbiddenMessage,
  missingRoleReasons,
  kindByName,
  matchesSelectorString,
  metricsAvailable,
  parseSelectorString,
  request,
  rfc3339,
  rulesFor,
  runArgv,
  execEnv,
  userFor,
  type AnyObject,
  type Attributes,
  type ControllerRevision,
  type DaemonSet,
  type Deployment,
  type KindInfo,
  type KubeEvent,
  type Node,
  type Pod,
  type ReplicaSet,
  type StatefulSet,
  type Taint,
  type UserInfo,
} from "@/lib/engine";
import { KNOWN_BINS, SHELLS } from "@/lib/engine/images";
import { explain } from "./explain";
import * as A from "@/lib/sim/actions";
import { baseTable, checkOutput, isWholeFormat, printObjects, printWhole, PrintError, refName, tableRows, toApiShape, toYaml } from "./printers";
import { describeObject } from "./describe";
import { evalPath, formatValue, JsonPathError } from "./jsonpath";
import * as G from "./generators";
import { FlagError, GLOBAL_FLAGS, SIMULATED_VERBS, UNSIMULATED_SUBS, UNSIMULATED_VERBS, helpFor, optionsHelp, parseArgs, resolveSub, specFor, splitLeadingGlobals, type Args, type FlagValue } from "./args";
import { err, newShell, out, runScript, type Chunk, type Res, type ShellState } from "./shell";
import { ManifestError, decodeError, kindForObject, mappingError, missingTypeError, parseManifest } from "./manifests";
import { PATCH_TYPES, PatchError, applyPatch, parsePatch } from "./patch";
import { complete as completeLine } from "./complete";
import { currentSession, hostCommand, hostEnv, kubectlOnNode } from "./hostshell";

export interface KubectlContext {
  cluster: Cluster;
  namespace: string;
  /** The Learner's virtual files (Editor buffers, redirected output). */
  files?: Record<string, string>;
  /** Re-running a streaming command the terminal is still showing, not a fresh one. */
  live?: boolean;
  /** This terminal session's aliases and variables. */
  shell?: ShellState;
}

export interface CommandResult {
  out: string;
  ok: boolean;
  /** A streaming command (get -w, logs -f, rollout status, wait): re-run it live. */
  watch?: string;
  /** Ask the UI to open this file in the Editor (kubectl edit, nano, vi). */
  openFile?: string;
  /** Set when nano / vi / vim opened it: the Editor then behaves like that tool. */
  editor?: "nano" | "vi";
}

// ---------------------------------------------------------------- errors and flags

class CmdError extends Error {}

const flag = (a: Args, ...names: string[]): FlagValue | undefined => {
  for (const n of names) {
    const v = a.flags[n];
    if (v === undefined) continue;
    return Array.isArray(v) ? v[v.length - 1] : v;
  }
  return undefined;
};
const sflag = (a: Args, ...names: string[]) => {
  const v = flag(a, ...names);
  return typeof v === "string" ? v : undefined;
};
const bflag = (a: Args, name: string) => flag(a, name) === true;
const aflag = (a: Args, name: string): string[] => {
  const v = a.flags[name];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
};

// ---------------------------------------------------------------- resources

function kindOf(word: string): KindInfo {
  const k = kindByName(word);
  if (!k) throw new CmdError(`error: the server doesn't have a resource type "${word}"`);
  return k;
}

const ref = (k: KindInfo, name: string) => refName(k, name);
const plural = (k: KindInfo) => (k.group ? `${k.plural}.${k.group}` : k.plural);
const notFound = (k: KindInfo, name: string) => `Error from server (NotFound): ${plural(k)} "${name}" not found`;

/** cli-runtime's ResourceTypeOrNameArgs: "TYPE[,TYPE] [NAME…]" or "TYPE/NAME…", never both. */
function targets(pos: string[], what = "get"): { k: KindInfo; names: string[] }[] {
  if (pos.length === 0) throw new CmdError(`error: You must specify the type of resource to ${what}. Use "kubectl api-resources" for a complete list of supported resources.`);
  const slashes = pos.filter((p) => p.includes("/")).length;
  if (slashes > 0 && slashes !== pos.length) {
    throw new CmdError(`error: there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. 'kubectl ${what} resource/<resource_name>' instead of 'kubectl ${what} resource resource/<resource_name>'`);
  }
  if (slashes) {
    const out: { k: KindInfo; names: string[] }[] = [];
    for (const p of pos) {
      const parts = p.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new CmdError("error: arguments in resource/name form must have a single resource and name");
      const k = kindOf(parts[0]);
      const hit = out.find((x) => x.k === k);
      if (hit) hit.names.push(parts[1]);
      else out.push({ k, names: [parts[1]] });
    }
    return out;
  }
  return pos[0]
    .split(",")
    .filter(Boolean)
    .map((t) => ({ k: kindOf(t), names: pos.slice(1) }));
}

function nsOf(ctx: KubectlContext, a: Args): string {
  return sflag(a, "--namespace") || ctx.namespace;
}

// ---------------------------------------------------------------- sessions, RBAC and dry-run

type Dry = "none" | "client" | "server";

interface Session {
  ctx: KubectlContext;
  a: Args;
  /** "get", "create deployment"… */
  path: string;
  user?: UserInfo;
  /** The command's source text, re-run for streaming output. */
  line: string;
  stdin?: string;
  /** stderr lines printed before the output (deprecations, Warning: lines). */
  warnings: string[];
  dry: Dry;
  /** The throwaway copy of the cluster a --dry-run=server request runs against. */
  sandbox?: Cluster;
}

/** Checks RBAC when impersonating; the default admin user may do anything. */
function can(s: Session, verb: string, k: KindInfo | { group: string; plural: string; namespaced: boolean }, ns: string | undefined, name?: string, subresource?: string) {
  if (!s.user) return;
  const attrs: Attributes = { verb, group: k.group, resource: k.plural, subresource, name, namespace: k.namespaced ? ns : undefined };
  if (!authorize(s.ctx.cluster, s.user, attrs)) {
    const p = subresource ? `${k.plural}` : k.group ? `${k.plural}.${k.group}` : k.plural;
    throw new CmdError(forbiddenMessage(s.user, attrs, p, missingRoleReasons(s.ctx.cluster, s.user, attrs.namespace)));
  }
}

/** klog's warning line, as GetDryRunStrategy prints it. */
function klogWarning(c: Cluster, msg: string): string {
  const t = rfc3339(c.now);
  return `W${t.slice(5, 7)}${t.slice(8, 10)} ${t.slice(11, 19)}.000000       1 helpers.go:731] ${msg}`;
}

/** cmdutil.GetDryRunStrategy. */
function dryRunOf(a: Args, c: Cluster, warnings: string[]): Dry {
  const v = a.flags["--dry-run"];
  if (v === undefined || v === false) return "none";
  const raw = String(v);
  if (raw === "unchanged") {
    warnings.push(klogWarning(c, "--dry-run is deprecated and can be replaced with --dry-run=client."));
    return "client";
  }
  if (raw === "client" || raw === "server" || raw === "none") return raw;
  if (/^(1|t|T|TRUE|true|True)$/.test(raw)) {
    warnings.push(klogWarning(c, `--dry-run=${raw} is deprecated (boolean value) and can be replaced with --dry-run=client.`));
    return "client";
  }
  if (/^(0|f|F|FALSE|false|False)$/.test(raw)) {
    warnings.push(klogWarning(c, `--dry-run=${raw} is deprecated (boolean value) and can be replaced with --dry-run=none.`));
    return "none";
  }
  throw new CmdError(`error: Invalid dry-run value (${raw}). Must be "none", "server", or "client".`);
}

const suffix = (s: Session) => (s.dry === "client" ? " (dry run)" : s.dry === "server" ? " (server dry run)" : "");

/** The cluster a write goes to: the real one, or a throwaway copy for --dry-run=server. */
function writeTarget(s: Session): Cluster {
  if (s.dry !== "server") return s.ctx.cluster;
  return (s.sandbox ??= new Cluster(s.ctx.cluster.snapshot()));
}

/** The simulator runs every Pod in the browser: more than this per workload freezes the tab (the share-link loader caps clusters at 600 Pods). */
export const MAX_REPLICAS = 100;

function capReplicas(o: AnyObject): void {
  const spec = o.spec as { replicas?: unknown; maxReplicas?: unknown; parallelism?: unknown } | undefined;
  const n = Math.max(...[spec?.replicas, spec?.maxReplicas, o.kind === "Job" ? spec?.parallelism : 0].map((x) => (typeof x === "number" ? x : 0)));
  if (n > MAX_REPLICAS) throw new CmdError(`error: kubesim limits replicas to ${MAX_REPLICAS} per workload so your browser stays responsive`);
}

/** The impersonated user, for the apiserver's RBAC escalation check on create/update/apply. */
const req = (s: Session) => (s.user ? { user: s.user } : {});

/** Creates an object (or, for client dry-run, just returns it). */
function doCreate(s: Session, obj: AnyObject): AnyObject {
  capReplicas(obj);
  if (s.dry === "client") return obj;
  const clean = structuredClone(obj);
  delete (clean as { status?: unknown }).status;
  return writeTarget(s).create(clean, req(s));
}

/** Replaces an object (or, for client dry-run, just returns the would-be object). */
function doReplace(s: Session, obj: AnyObject): AnyObject {
  capReplicas(obj);
  if (s.dry === "client") return obj;
  return writeTarget(s).replace(obj, req(s));
}

/** What a write command prints: `-o` output of the result, or "<ref> <verb>[ (dry run)]". */
function report(s: Session, k: KindInfo, objs: AnyObject[], word: string): string {
  const output = sflag(s.a, "--output");
  if (output === "name") return objs.map((o) => ref(k, o.metadata.name)).join("\n");
  if (output) return objs.map((o) => printWhole([o], { output, allNs: false })).join(output === "yaml" ? "\n---\n" : "\n");
  return objs.map((o) => `${ref(k, o.metadata.name)} ${word}${suffix(s)}`).join("\n");
}

/** Throws early on a bad -o, before anything changes. */
function checkOut(s: Session, allowWide = false) {
  checkOutput(sflag(s.a, "--output"), allowWide);
}

/** Object(s) and the errors met along the way, printed together like kubectl's aggregate errors. */
interface Partial {
  out: string[];
  errs: string[];
}
const partialRes = (p: Partial): Res => ({ chunks: [...(p.out.length ? [{ fd: 1 as const, text: p.out.join("\n") }] : []), ...p.errs.map((e) => ({ fd: 2 as const, text: e }))], ok: p.errs.length === 0 });

/** Messages from deliberate throws: our own error classes, and plain `Error`s the engine raises on bad input. */
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof JsonPathError || e instanceof FlagError || (e?.constructor === Error && !/^(error|Error from server|The \S+ "|Warning)/.test(m))) return `error: ${m}`;
  return m;
};
/** JS crashes (TypeError, RangeError…) are bugs in the simulator, never shown to the Learner as-is. */
const isUserError = (e: unknown) => e instanceof CmdError || e instanceof ApiError || e instanceof G.GenError || e instanceof ManifestError || e instanceof PatchError || e instanceof PrintError || e instanceof JsonPathError || e instanceof FlagError || (e instanceof Error && e.constructor === Error);

// ---------------------------------------------------------------- manifests (-f)

/** Reads -f FILE (or -f - from stdin) into objects, with kubectl's parse errors. */
function readManifests(s: Session, verb: string): { objs: AnyObject[]; source: string }[] {
  const files = s.ctx.files ?? {};
  const out: { objs: AnyObject[]; source: string }[] = [];
  if (sflag(s.a, "--kustomize")) throw new CmdError("error: the simulator doesn't run kustomize (-k). Apply the manifests one file at a time with -f FILE.");
  for (const f of aflag(s.a, "--filename")) {
    const source = f === "-" ? "STDIN" : f;
    const text = f === "-" ? (s.stdin ?? "") : files[f.replace(/^\.\//, "")];
    if (text === undefined) throw new CmdError(`error: the path "${f}" does not exist\nTry "ls" to see your files, or write one in the YAML editor.`);
    const objs = parseManifest(text, source);
    for (const o of objs) {
      const e = missingTypeError(o, source);
      if (e) throw new ManifestError(e);
    }
    out.push({ objs, source });
  }
  if (!out.some((x) => x.objs.length)) throw new CmdError(`error: no objects passed to ${verb}`);
  return out;
}

/** "Error from server (X): rest" → "Error from server (X): error when <doing> "FILE": rest". */
function whenDoing(e: unknown, doing: string, source: string): string {
  const m = errText(e);
  const hit = m.match(/^Error from server \(([^)]+)\): ([\s\S]*)$/);
  return hit ? `Error from server (${hit[1]}): error when ${doing} "${source}": ${hit[2]}` : m;
}

/** Kind mapping and JSON type checks for one manifest object. */
function checkObject(o: AnyObject, source: string, ns: string): KindInfo {
  const k = kindForObject(o);
  if (!k) throw new ManifestError(mappingError(o, source, kindByName(String(o.kind ?? ""))?.namespaced === false ? undefined : (o.metadata?.namespace ?? ns)));
  const bad = decodeError(o, k);
  if (bad) throw new ManifestError(`Error from server (BadRequest): ${bad}`);
  return k;
}

// ---------------------------------------------------------------- get

const FIELD_OK: Record<string, string[]> = {
  Pod: ["metadata.name", "metadata.namespace", "spec.nodeName", "spec.restartPolicy", "spec.schedulerName", "spec.serviceAccountName", "status.phase", "status.podIP", "status.nominatedNodeName"],
  Event: ["involvedObject.kind", "involvedObject.name", "involvedObject.namespace", "involvedObject.uid", "reason", "type", "source", "reportingComponent"],
  Node: ["metadata.name", "spec.unschedulable"],
  Namespace: ["metadata.name", "status.phase"],
  Secret: ["metadata.name", "metadata.namespace", "type"],
  Job: ["metadata.name", "metadata.namespace", "status.successful"],
};

function fieldFilter(k: KindInfo, expr: string): (o: AnyObject) => boolean {
  const parts = expr
    .split(",")
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^([\w.]+)\s*(==|!=|=)\s*(.*)$/);
      if (!m) throw new CmdError(`error: invalid field selector: ${p}`);
      const allowed = FIELD_OK[k.kind] ?? ["metadata.name", "metadata.namespace"];
      if (!allowed.includes(m[1])) throw new CmdError(`Error from server (BadRequest): Unable to find "${k.group ? `${k.group}/` : "/"}${k.version}, Resource=${k.plural}" that match label selector "", field selector "${expr}": field label not supported: ${m[1]}`);
      return { path: m[1], neg: m[2] === "!=", value: m[3] };
    });
  return (o) =>
    parts.every((p) => {
      const v = evalPath(toApiShape(o), `.${p.path}`).map(formatValue)[0] ?? "";
      return (v === p.value) !== p.neg;
    });
}

/** --sort-by: a JSONPath; it's an error when no object has the field. */
function sortObjects(objs: AnyObject[], by: string): AnyObject[] {
  const path = by.replace(/^\{|\}$/g, "");
  const full = path.startsWith(".") ? path : `.${path}`;
  const key = (o: AnyObject) => evalPath(toApiShape(o), full)[0];
  if (objs.length > 1 && objs.every((o) => key(o) === undefined)) throw new CmdError(`error: couldn't find any field with path "{${full}}" in the list of objects`);
  return [...objs].sort((x, y) => {
    const a = key(x);
    const b = key(y);
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
  });
}

const ALL_KINDS = ["pods", "services", "daemonsets", "deployments", "replicasets", "statefulsets", "horizontalpodautoscalers", "cronjobs", "jobs"];

/** The apiserver's deprecation warning for v1 Endpoints (a response header, printed on stderr). */
export const ENDPOINTS_WARNING = "Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice";

function endpointsWarning(s: Session, kinds: string[]) {
  if (kinds.includes("Endpoints") && !s.warnings.includes(ENDPOINTS_WARNING)) s.warnings.push(ENDPOINTS_WARNING);
}

function cmdGet(s: Session): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const allNs = bflag(a, "--all-namespaces");
  const ns = nsOf(ctx, a);
  const output = sflag(a, "--output");
  checkOutput(output);
  const selStr = sflag(a, "--selector");
  const selector = selStr ? parseSelectorString(selStr) : undefined;
  const field = sflag(a, "--field-selector");
  const sortBy = sflag(a, "--sort-by");
  const isAll = a.pos[0] === "all";
  let tgts: { k: KindInfo; names: string[]; nsOverride?: string }[];
  if (aflag(a, "--filename").length) {
    tgts = [];
    for (const { objs, source } of readManifests(s, "get")) {
      for (const o of objs) {
        const k = checkObject(o, source, ns);
        tgts.push({ k, names: [o.metadata.name], nsOverride: o.metadata.namespace });
      }
    }
  } else tgts = targets(isAll ? [ALL_KINDS.join(","), ...a.pos.slice(1)] : a.pos);
  if (allNs && tgts.some((t) => t.names.length)) throw new CmdError("error: a resource cannot be retrieved by name across all namespaces");
  endpointsWarning(s, tgts.map((t) => t.k.kind));
  const p: Partial = { out: [], errs: [] };
  const groups: { k: KindInfo; objs: AnyObject[]; listed: boolean }[] = [];
  for (const { k, names, nsOverride } of tgts) {
    let objs: AnyObject[] = [];
    if (names.length) {
      for (const n of names) {
        const nsx = nsOverride ?? ns;
        can(s, "get", k, nsx, n);
        const o = c.raw(k.kind, k.namespaced ? nsx : undefined, n);
        if (o) objs.push(o);
        else if (!bflag(a, "--ignore-not-found")) p.errs.push(notFound(k, n));
      }
    } else {
      can(s, "list", k, allNs ? undefined : ns);
      objs = c.list(k.kind, k.namespaced && !allNs ? ns : undefined);
      if (allNs && k.namespaced) objs = [...objs].sort((x, y) => (x.metadata.namespace! < y.metadata.namespace! ? -1 : x.metadata.namespace! > y.metadata.namespace! ? 1 : 0));
      if (selector) objs = objs.filter((o) => matchesSelectorString(o.metadata.labels, selector));
      if (field) objs = objs.filter(fieldFilter(k, field));
    }
    if (sortBy) objs = sortObjects(objs, sortBy);
    groups.push({ k, objs, listed: !names.length });
  }
  const found = groups.filter((g) => g.objs.length);
  const multi = tgts.length > 1 || isAll;
  if (!found.length) {
    if (!p.errs.length && !bflag(a, "--ignore-not-found")) {
      const k = tgts[0].k;
      // Printed on stderr, so `| wc -l` counts 0.
      return { chunks: [{ fd: 2, text: k.namespaced && !allNs ? `No resources found in ${ns} namespace.` : "No resources found" }], ok: true };
    }
    return partialRes(p);
  }
  if (isWholeFormat(output)) {
    const objs = found.flatMap((g) => g.objs);
    const listed = multi || found.some((g) => g.listed) || objs.length > 1;
    p.out.push(printWhole(objs, { output, allNs, listed, noHeaders: bflag(a, "--no-headers") }));
    return partialRes(p);
  }
  const parts: string[] = [];
  for (const { k, objs, listed } of found) {
    let text = printObjects(c, k, objs, {
      output,
      allNs,
      showLabels: bflag(a, "--show-labels"),
      labelColumns: aflag(a, "--label-columns").flatMap((x) => x.split(",")),
      noHeaders: bflag(a, "--no-headers"),
      listed,
    });
    if (multi && output !== "name") {
      const idx = allNs && k.namespaced ? 1 : 0;
      text = text
        .split("\n")
        .map((l, i) => {
          if (i === 0 && !bflag(a, "--no-headers")) return l;
          const cols = l.split(/(\s{3,})/);
          cols[idx * 2] = ref(k, cols[idx * 2]);
          return cols.join("");
        })
        .join("\n");
      text = baseTable(text.split("\n").map((l) => l.split(/\s{3,}/)));
    }
    parts.push(text);
  }
  p.out.push(parts.join(output === "name" ? "\n" : "\n\n"));
  return partialRes(p);
}

// ---------------------------------------------------------------- describe

function cmdDescribe(s: Session): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const allNs = bflag(a, "--all-namespaces");
  const selStr = sflag(a, "--selector");
  const out: string[] = [];
  const p: Partial = { out: [], errs: [] };
  const tgts = targets(a.pos, "describe");
  endpointsWarning(s, tgts.map((t) => t.k.kind));
  for (const { k, names } of tgts) {
    const pool = () => c.list(k.kind, k.namespaced && !allNs ? ns : undefined);
    let objs: AnyObject[];
    if (names.length) {
      objs = names.flatMap((n) => {
        can(s, "get", k, ns, n);
        const exact = c.raw(k.kind, k.namespaced ? ns : undefined, n);
        if (exact) return [exact];
        // kubectl describe matches name prefixes: `describe pod web` finds web-7c5d…
        const pre = pool().filter((o) => o.metadata.name.startsWith(n));
        if (!pre.length) p.errs.push(notFound(k, n));
        return pre;
      });
    } else {
      can(s, "list", k, ns);
      objs = pool();
      if (selStr) objs = objs.filter((o) => matchesSelectorString(o.metadata.labels, parseSelectorString(selStr)));
      if (!objs.length) return { chunks: [{ fd: 2, text: k.namespaced && !allNs ? `No resources found in ${ns} namespace.` : "No resources found" }], ok: true };
    }
    for (const o of objs) out.push(describeObject(c, k.kind, o));
  }
  if (out.length) p.out.push(out.join("\n\n\n"));
  return partialRes(p);
}

// ---------------------------------------------------------------- rollout

function ownedBy<T extends { apiVersion: string; kind: string; metadata: AnyObject["metadata"] }>(c: Cluster, kind: string, ns: string | undefined, owner: AnyObject): T[] {
  return c.list<T>(kind, ns).filter((x) => x.metadata.ownerReferences?.some((r) => r.uid === owner.metadata.uid));
}

function rolloutStatus(c: Cluster, kind: string, o: AnyObject): { out: string; done: boolean } {
  const name = o.metadata.name;
  if (kind === "Deployment") {
    const d = o as unknown as Deployment;
    const want = d.spec?.replicas ?? 1;
    const st = d.status ?? {};
    if (st.conditions?.some((x) => x.reason === "ProgressDeadlineExceeded")) throw new CmdError(`error: deployment "${name}" exceeded its progress deadline`);
    if ((st.updatedReplicas ?? 0) < want) return { out: `Waiting for deployment "${name}" rollout to finish: ${st.updatedReplicas ?? 0} out of ${want} new replicas have been updated...`, done: false };
    if ((st.replicas ?? 0) > (st.updatedReplicas ?? 0)) return { out: `Waiting for deployment "${name}" rollout to finish: ${(st.replicas ?? 0) - (st.updatedReplicas ?? 0)} old replicas are pending termination...`, done: false };
    if ((st.availableReplicas ?? 0) < want) return { out: `Waiting for deployment "${name}" rollout to finish: ${st.availableReplicas ?? 0} of ${want} updated replicas are available...`, done: false };
    return { out: `deployment "${name}" successfully rolled out`, done: true };
  }
  if (kind === "StatefulSet") {
    const s = o as unknown as StatefulSet;
    const want = s.spec?.replicas ?? 1;
    const st = s.status ?? { replicas: 0 };
    const partition = s.spec?.updateStrategy?.rollingUpdate?.partition ?? 0;
    if ((st.readyReplicas ?? 0) < want) return { out: `Waiting for ${want - (st.readyReplicas ?? 0)} pods to be ready...`, done: false };
    if (partition > 0) {
      const target = want - partition;
      if ((st.updatedReplicas ?? 0) < target) return { out: `Waiting for partitioned roll out to finish: ${st.updatedReplicas ?? 0} out of ${target} new pods have been updated...`, done: false };
      return { out: `partitioned roll out complete: ${st.updatedReplicas ?? 0} new pods have been updated...`, done: true };
    }
    if (st.updateRevision !== st.currentRevision) return { out: `waiting for statefulset rolling update to complete ${st.updatedReplicas ?? 0} pods at revision ${st.updateRevision}...`, done: false };
    return { out: `statefulset rolling update complete ${st.currentReplicas ?? want} pods at revision ${st.currentRevision}...`, done: true };
  }
  if (kind === "DaemonSet") {
    const d = o as unknown as DaemonSet;
    const st = d.status;
    const want = st?.desiredNumberScheduled ?? 0;
    if ((st?.updatedNumberScheduled ?? 0) < want) return { out: `Waiting for daemon set "${name}" rollout to finish: ${st?.updatedNumberScheduled ?? 0} out of ${want} new pods have been updated...`, done: false };
    if ((st?.numberAvailable ?? 0) < want) return { out: `Waiting for daemon set "${name}" rollout to finish: ${st?.numberAvailable ?? 0} of ${want} updated pods are available...`, done: false };
    return { out: `daemon set "${name}" successfully rolled out`, done: true };
  }
  throw new CmdError(`error: no status viewer has been implemented for ${kind}`);
}

const ROLLOUT_KINDS = ["Deployment", "StatefulSet", "DaemonSet"];

function templateText(t: { metadata?: { labels?: Record<string, string> }; spec: { containers: { name: string; image: string }[] } }): string {
  return ["Pod Template:", `  Labels:\t${Object.entries(t.metadata?.labels ?? {}).map(([x, y]) => `${x}=${y}`).join("\n\t")}`, "  Containers:", ...t.spec.containers.map((ct) => `   ${ct.name}:\n    Image:\t${ct.image}`)].join("\n");
}

function cmdRollout(s: Session): Res | string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const sub = s.path.split(" ")[1];
  const ns = nsOf(ctx, a);
  const selStr = sflag(a, "--selector");
  // restart/pause/resume take TYPE alone (every object of that type) or a selector.
  const tgts = targets(a.pos, "rollout").map((t) => ({
    k: t.k,
    names: t.names.length ? t.names : sub === "restart" || selStr ? c.list(t.k.kind, ns).filter((o) => !selStr || matchesSelectorString(o.metadata.labels, parseSelectorString(selStr))).map((o) => o.metadata.name) : [],
  }));
  if (!tgts.some((t) => t.names.length)) {
    if (sub === "restart" || selStr) return { chunks: [{ fd: 2, text: `No resources found in ${ns} namespace.` }], ok: true };
    throw new CmdError("error: required resource not specified");
  }
  if (sub === "undo") checkOut(s);
  const p: Partial = { out: [], errs: [] };
  for (const { k, names } of tgts) {
    for (const name of names) {
      const o = c.raw(k.kind, ns, name);
      if (!o) {
        p.errs.push(notFound(k, name));
        continue;
      }
      const r = ref(k, name);
      try {
        switch (sub) {
          case "status": {
            if (!ROLLOUT_KINDS.includes(k.kind)) throw new CmdError(`error: no status viewer has been implemented for ${k.kind}`);
            can(s, "get", k, ns, name);
            const st = rolloutStatus(c, k.kind, o);
            const live = !st.done && flag(a, "--watch") !== false;
            return { chunks: [{ fd: 1, text: st.out }], ok: true, ...(live ? { watch: s.line } : {}) };
          }
          case "history": {
            if (!ROLLOUT_KINDS.includes(k.kind)) throw new CmdError(`error: no history viewer has been implemented for ${k.kind}`);
            can(s, "list", k, ns);
            const want = sflag(a, "--revision");
            if (k.kind === "Deployment") {
              const rss = ownedBy<ReplicaSet>(c, "ReplicaSet", ns, o);
              const rev = (x: ReplicaSet) => Number(x.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
              if (want && want !== "0") {
                const hit = rss.find((x) => rev(x) === Number(want));
                if (!hit) throw new CmdError(`error: unable to find the specified revision`);
                p.out.push(`${r} with revision #${want}\n${templateText(hit.spec!.template)}`);
              } else p.out.push(`${r}\n` + baseTable([["REVISION", "CHANGE-CAUSE"], ...rss.sort((x, y) => rev(x) - rev(y)).map((x) => [String(rev(x)), x.metadata.annotations?.["kubernetes.io/change-cause"] ?? "<none>"])]));
              break;
            }
            const revs = ownedBy<ControllerRevision>(c, "ControllerRevision", ns, o).sort((x, y) => x.revision - y.revision);
            p.out.push(`${r}\n` + baseTable([["REVISION", "CHANGE-CAUSE"], ...revs.map((x) => [String(x.revision), "<none>"])]));
            break;
          }
          case "undo": {
            if (!ROLLOUT_KINDS.includes(k.kind)) throw new CmdError(`error: no rollbacker has been implemented for "${k.kind}"`);
            can(s, "patch", k, ns, name);
            const to = Number(sflag(a, "--to-revision") ?? 0) || undefined;
            let next: AnyObject;
            if (k.kind === "Deployment") {
              const t = A.undoTarget(c, o as unknown as Deployment, to);
              if (t.error) throw new CmdError(t.error);
              if (t.skip) {
                p.out.push(`${r} skipped rollback (current template already matches revision ${t.revision})`);
                break;
              }
              next = { ...o, spec: { ...(o.spec as object), template: t.template } } as AnyObject;
            } else {
              const revs = ownedBy<ControllerRevision>(c, "ControllerRevision", ns, o).sort((x, y) => y.revision - x.revision);
              const target = to ? revs.find((x) => x.revision === to) : revs[1];
              if (!target) throw new CmdError(to ? `error: unable to find specified revision ${to} in history` : `error: no rollout history found for ${k.singular} "${name}"`);
              const tpl = structuredClone((target.data as { spec: { template: AnyObject & { $patch?: string } } }).spec.template);
              delete tpl.$patch;
              next = { ...o, spec: { ...(o.spec as object), template: tpl } } as AnyObject;
            }
            const res = doReplace(s, next);
            p.out.push(sflag(a, "--output") ? report(s, k, [res], "rolled back") : `${r} rolled back${suffix(s)}`);
            break;
          }
          case "restart": {
            if (!ROLLOUT_KINDS.includes(k.kind)) throw new CmdError(`error: ${plural(k)} "${name}" restarting is not supported`);
            if ((o.spec as { paused?: boolean })?.paused) throw new CmdError(`error: ${plural(k)} "${name}" can't restart paused deployment (run rollout resume first)`);
            can(s, "patch", k, ns, name);
            const x = structuredClone(o) as AnyObject & { spec: { template: { metadata?: { annotations?: Record<string, string> } } } };
            x.spec.template.metadata = { ...(x.spec.template.metadata ?? {}), annotations: { ...(x.spec.template.metadata?.annotations ?? {}), "kubectl.kubernetes.io/restartedAt": rfc3339(c.now) } };
            const res = c.replace(x, req(s));
            p.out.push(sflag(a, "--output") ? report(s, k, [res], "restarted") : `${r} restarted`);
            break;
          }
          case "pause":
          case "resume": {
            // objectpauser.go / objectresumer.go: only Deployments; the errors come back as `error: <resource> "<name>" <err>`.
            if (k.kind !== "Deployment") throw new CmdError(`error: ${plural(k)} "${name}" ${sub === "pause" ? "pausing" : "resuming"} is not supported`);
            can(s, "patch", k, ns, name);
            const d = o as unknown as Deployment;
            if (!!d.spec?.paused === (sub === "pause")) throw new CmdError(`error: ${plural(k)} "${name}" ${sub === "pause" ? "is already paused" : "is not paused"}`);
            c.replace({ ...d, spec: { ...d.spec!, paused: sub === "pause" || undefined } }, req(s));
            p.out.push(`${r} ${sub === "pause" ? "paused" : "resumed"}`);
            break;
          }
        }
      } catch (e) {
        if (!isUserError(e)) throw e;
        p.errs.push(errText(e));
      }
    }
  }
  return partialRes(p);
}

// ---------------------------------------------------------------- pods: logs, exec, run

/** Resolves POD, TYPE/NAME (deploy/web, job/pi…) to a Pod, and how many Pods matched. */
function podsFor(c: Cluster, ns: string, target: string): { pod: Pod; count: number } {
  if (!target.includes("/")) return { pod: c.get<Pod>("Pod", ns, target), count: 1 };
  const [t, n] = target.split("/");
  const k = kindOf(t);
  if (k.kind === "Pod") return { pod: c.get<Pod>("Pod", ns, n), count: 1 };
  const o = c.get(k.kind, ns, n) as AnyObject & { spec?: { selector?: { matchLabels?: Record<string, string> } | Record<string, string> } };
  const sel = k.kind === "Service" ? (o.spec?.selector as Record<string, string>) : (o.spec?.selector as { matchLabels?: Record<string, string> })?.matchLabels;
  const pods = c.list<Pod>("Pod", ns).filter((x) => !x.metadata.deletionTimestamp && sel && Object.entries(sel).every(([kk, v]) => x.metadata.labels?.[kk] === v));
  const running = pods.find((p) => p.status?.phase === "Running") ?? pods[0];
  if (!running) throw new CmdError(`error: no pods found for ${target}`);
  return { pod: running, count: pods.length };
}

function containerOf(p: Pod, a: Args): { name: string; note?: string } {
  const want = sflag(a, "--container");
  const names = p.spec!.containers.map((x) => x.name);
  if (want) {
    if (!names.includes(want)) throw new CmdError(`error: container ${want} is not valid for pod ${p.metadata.name}`);
    return { name: want };
  }
  const def = p.metadata.annotations?.["kubectl.kubernetes.io/default-container"];
  if (names.length > 1) return { name: def ?? names[0], note: `Defaulted container "${def ?? names[0]}" out of: ${names.join(", ")}` };
  return { name: names[0] };
}

/** Go's time.ParseDuration, in ms. */
function goDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  let ms = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) ms += parseFloat(m[1]) * { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms"];
  return ms || (/^\d+$/.test(s) ? parseInt(s, 10) * 1000 : fallbackMs);
}

function cmdLogs(s: Session): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const selStr = sflag(a, "--selector");
  let pods: Pod[];
  const lines: Chunk[] = [];
  if (selStr) {
    pods = c.list<Pod>("Pod", ns).filter((p) => matchesSelectorString(p.metadata.labels, parseSelectorString(selStr))).slice(0, Number(sflag(a, "--max-log-requests") ?? 5));
    if (!pods.length) return { chunks: [{ fd: 2, text: `No resources found in ${ns} namespace.` }], ok: true };
  } else {
    const target = a.pos[0];
    if (!target) throw new CmdError("error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee 'kubectl logs -h' for help and examples");
    const found = podsFor(c, ns, target);
    pods = [found.pod];
    if (found.count > 1) lines.push({ fd: 2, text: `Found ${found.count} pods, using pod/${found.pod.metadata.name}` });
  }
  const out: string[] = [];
  // With a selector, --tail defaults to 10 (logs.go).
  const tailRaw = sflag(a, "--tail") ?? (selStr ? "10" : "-1");
  for (const pod of pods) {
    can(s, "get", { group: "", plural: "pods", namespaced: true }, ns, pod.metadata.name, "log");
    const all = bflag(a, "--all-containers");
    const cs: { name: string; note?: string }[] = all ? pod.spec!.containers.map((x) => ({ name: x.name })) : [containerOf(pod, a)];
    for (const { name: cname, note } of cs) {
      if (note && pods.length === 1) lines.push({ fd: 2, text: note });
      const prev = bflag(a, "--previous");
      const ls0 = c.logsFor(pod, cname, prev);
      if (ls0 === undefined) throw new CmdError(`Error from server (BadRequest): previous terminated container "${cname}" in pod "${pod.metadata.name}" not found`);
      const st = pod.status?.containerStatuses?.find((x) => x.name === cname);
      if (!prev && st?.state.waiting && !(st.restartCount > 0)) throw new CmdError(`Error from server (BadRequest): container "${cname}" in pod "${pod.metadata.name}" is waiting to start: ${st.state.waiting.reason}`);
      if (!pod.spec?.nodeName) throw new CmdError(`Error from server (BadRequest): container "${cname}" in pod "${pod.metadata.name}" is waiting to start: ContainerCreating`);
      let ls = ls0;
      const since = sflag(a, "--since");
      if (since) ls = ls.filter((l) => c.now - l.t <= goDuration(since, Infinity));
      if (Number(tailRaw) >= 0) ls = Number(tailRaw) === 0 ? [] : ls.slice(-Number(tailRaw));
      const ts = bflag(a, "--timestamps");
      const prefix = bflag(a, "--prefix");
      out.push(...ls.map((l) => `${prefix ? `[pod/${pod.metadata.name}/${cname}] ` : ""}${ts ? rfc3339(l.t).replace("Z", ".000000000Z") + " " : ""}${l.text}`));
    }
  }
  let text = out.join("\n");
  const limit = Number(sflag(a, "--limit-bytes") ?? 0);
  if (limit > 0) text = text.slice(0, limit);
  return { chunks: [...lines, ...(text ? [{ fd: 1 as const, text }] : [])], ok: true };
}

function curlArgs(words: string[]): { url?: string; host?: string } {
  const hIdx = words.findIndex((w) => w === "-H" || w === "--header");
  const host = hIdx >= 0 ? words[hIdx + 1]?.match(/^host:\s*(.+)$/i)?.[1] : undefined;
  const skip = new Set(["-H", "--header", "-o", "-w", "-X", "-m", "--max-time", "--connect-timeout", "-d", "--data", "-T", "-u", "-A", "--user-agent"]);
  const url = words.find((w, i) => !w.startsWith("-") && !skip.has(words[i - 1]));
  return { url, host };
}

function curl(ctx: KubectlContext, words: string[]): Res {
  const { url, host } = curlArgs(words);
  if (!url) return err("curl: try 'curl --help' or 'curl --manual' for more information");
  if (/^[a-z]+:\/\/(\/|$)/i.test(url)) return err("curl: (3) URL rejected: No host part in the URL");
  const r = request(ctx.cluster, url, { hostHeader: host });
  if (!r.ok) return err(r.error ?? "curl: (7) Failed to connect");
  if (words.includes("-I") || words.includes("--head")) return out(`HTTP/1.1 ${r.status} ${r.status === 200 ? "OK" : ""}`.trim());
  if ((words.includes("-f") || words.includes("--fail") || words.some((w) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(w) && w !== "-f")) && (r.status ?? 200) >= 400) return err(`curl: (22) The requested URL returned error: ${r.status}`);
  return out((r.body ?? "").replace(/\n$/, ""));
}

/** busybox wget, as in the images learners use for it. */
function wget(ctx: KubectlContext, words: string[]): Res {
  const args = words.filter((w) => !/^-q?O-?$/.test(w) && !/^-[qS]+$/.test(w) && w !== "-O" && w !== "--quiet");
  const { url, host } = curlArgs(args);
  if (!url) return err("BusyBox v1.36.1 (2023-05-18 22:34:17 UTC) multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-o LOGFILE] [--header STR]\n\t[--post-data STR | --post-file FILE] [-Y on/off]\n\t[-P DIR] [-U AGENT] [-T SEC] URL...");
  const r = request(ctx.cluster, url.includes("://") ? url : `http://${url}`, { hostHeader: host });
  const hostName = url.replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0];
  if (!r.ok) {
    const e = r.error ?? "";
    if (/\(6\)/.test(e)) return err(`wget: bad address '${hostName}'`);
    if (/\(28\)/.test(e)) return err("wget: download timed out");
    return err(`wget: can't connect to remote host: Connection refused`);
  }
  if ((r.status ?? 200) >= 400) return err(`wget: server returned error: HTTP/1.1 ${r.status} ${r.status === 404 ? "Not Found" : r.status === 403 ? "Forbidden" : r.status === 503 ? "Service Temporarily Unavailable" : "Error"}`);
  return out((r.body ?? "").replace(/\n$/, ""));
}

function cmdExec(s: Session): Res | string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  // exec.go ToOptions: exactly one positional (the pod) before "--"; the old `exec POD CMD` form is gone.
  if (a.dashAt === 0 || (a.dashAt < 0 && a.pos.length === 0)) throw new CmdError("error: pod, type/name or --filename must be specified");
  if ((a.dashAt < 0 && a.pos.length > 1) || a.dashAt > 1) throw new CmdError("error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead\nSee 'kubectl exec -h' for help and examples");
  const target = a.pos[0];
  const pod = podsFor(c, ns, target).pod;
  can(s, "create", { group: "", plural: "pods", namespaced: true }, ns, pod.metadata.name, "exec");
  const argv = a.rest;
  if (!argv.length) throw new CmdError("error: you must specify at least one command for the container");
  if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") throw new CmdError(`error: cannot exec into a container in a completed pod; current phase is ${pod.status.phase}`);
  const { name, note } = containerOf(pod, a);
  const notes: Chunk[] = note ? [{ fd: 2, text: note }] : [];
  const ct = pod.spec!.containers.find((x) => x.name === name)!;
  const crt = c.state.pods[pod.metadata.uid]?.containers[name];
  if (!crt || (crt.phase !== "running" && crt.phase !== "stopping")) throw new CmdError(`error: unable to upgrade connection: container not found ("${name}")`);
  const info = execEnv(c, pod, ct, crt.env ?? {});
  const bin = argv[0].split("/").pop()!;
  const notFoundBin = `error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${pod.metadata.uid.replace(/-/g, "").slice(0, 12)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${argv[0]}": executable file not found in $PATH: unknown`;
  if (info.flavor === "none" && !["curl", "wget"].includes(bin)) throw new CmdError(notFoundBin);
  if (!SHELLS.has(argv[0]) && !KNOWN_BINS.has(bin)) throw new CmdError(notFoundBin);
  if (SHELLS.has(argv[0]) && !argv.includes("-c")) {
    return { chunks: [...notes, { fd: 1, text: `(The simulator can't open an interactive shell. Run one command at a time instead, for example:\n  kubectl exec ${target} -- ls /\n  kubectl exec ${target} -- sh -c "echo hi > /tmp/x; cat /tmp/x")` }], ok: true };
  }
  const r = runArgv(info, argv);
  c.markChanged();
  const text = r.out.replace(/\n$/, "");
  const chunks: Chunk[] = [...notes, ...(text ? [{ fd: 1 as const, text }] : [])];
  if (r.code !== 0) return { chunks: [...chunks, { fd: 2, text: `command terminated with exit code ${r.code}` }], ok: false };
  return { chunks, ok: true };
}

/** `kubectl run tmp --rm -it --image=busybox -- wget -qO- http://web`: a throwaway Pod that runs one command. */
function ephemeral(s: Session, pod: Pod): Res {
  const c = s.ctx.cluster;
  const argv = [...(pod.spec!.containers[0].command ?? []), ...(pod.spec!.containers[0].args ?? [])];
  const worker = c.list<Node>("Node").find((n) => n.metadata.labels?.["node-role.kubernetes.io/control-plane"] === undefined);
  const temp: Pod = { ...structuredClone(pod), metadata: { ...pod.metadata, uid: `ephemeral-${pod.metadata.name}`, resourceVersion: "", creationTimestamp: c.now }, spec: { ...pod.spec!, nodeName: worker?.metadata.name ?? "worker-1" }, status: { phase: "Running", podIP: "10.244.1.250" } };
  const deleted = `pod "${pod.metadata.name}" deleted from ${pod.metadata.namespace} namespace`;
  if (!argv.length || (SHELLS.has(argv[0]) && !argv.includes("-c"))) {
    return out(`If you don't see a command prompt, try pressing enter.\n(The simulator can't attach an interactive shell. Give the Pod a command instead:\n  kubectl run ${pod.metadata.name} --rm -it --image=${pod.spec!.containers[0].image} -- wget -qO- http://SERVICE)\n${deleted}`);
  }
  const ee = execEnv(c, temp, temp.spec!.containers[0], {});
  const r = runArgv(ee, argv);
  r.out = r.out.replace(/\n$/, "");
  return { chunks: [...(r.out ? [{ fd: 1 as const, text: r.out }] : []), { fd: 1, text: deleted }, ...(r.code ? [{ fd: 2 as const, text: `pod ${pod.metadata.namespace}/${pod.metadata.name} terminated (Error)` }] : [])], ok: r.code === 0 };
}

// ---------------------------------------------------------------- top

function cmdTop(s: Session): string | Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const what = s.path.split(" ")[1];
  if (!metricsAvailable(c)) throw new CmdError("error: Metrics API not available");
  const m = c.state.metrics;
  const sort = sflag(a, "--sort-by");
  if (sort && sort !== "cpu" && sort !== "memory") throw new CmdError("error: --sort-by accepts only cpu or memory");
  const cpu = (x: number) => `${Math.round(x)}m`;
  const table = (rows: string[][]) => baseTable(bflag(a, "--no-headers") ? rows.slice(1) : rows);
  const mem = (x: number) => `${Math.floor(x / 2 ** 20)}Mi`;
  const selStr = sflag(a, "--selector");
  if (what === "node") {
    can(s, "list", { group: "metrics.k8s.io", plural: "nodes", namespaced: false }, undefined);
    let nodes = c.list<Node>("Node");
    if (selStr) nodes = nodes.filter((n) => matchesSelectorString(n.metadata.labels, parseSelectorString(selStr)));
    if (a.pos[0]) {
      nodes = nodes.filter((n) => n.metadata.name === a.pos[0]);
      if (!nodes.length) throw new CmdError(`Error from server (NotFound): nodes "${a.pos[0]}" not found`);
    }
    const rows = nodes
      .filter((n) => m.nodes[n.metadata.name])
      .map((n) => {
        const u = m.nodes[n.metadata.name];
        const cap = { cpu: parseFloat(n.status!.allocatable.cpu) * 1000, mem: parseInt(n.status!.allocatable.memory, 10) * 1024 };
        return [n.metadata.name, cpu(u.cpu), `${Math.trunc((u.cpu / cap.cpu) * 100)}%`, mem(u.memory), `${Math.trunc((u.memory / cap.mem) * 100)}%`];
      });
    if (a.pos[0] && !rows.length) throw new CmdError(`error: metrics not available yet`);
    if (sort === "cpu") rows.sort((x, y) => parseInt(y[1], 10) - parseInt(x[1], 10));
    if (sort === "memory") rows.sort((x, y) => parseInt(y[3], 10) - parseInt(x[3], 10));
    return table([["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"], ...rows]);
  }
  const allNs = bflag(a, "--all-namespaces");
  const ns = nsOf(ctx, a);
  can(s, "list", { group: "metrics.k8s.io", plural: "pods", namespaced: true }, ns);
  let pods = c.list<Pod>("Pod", allNs ? undefined : ns);
  if (allNs) pods = [...pods].sort((x, y) => (x.metadata.namespace! < y.metadata.namespace! ? -1 : x.metadata.namespace! > y.metadata.namespace! ? 1 : 0));
  if (selStr) pods = pods.filter((p) => matchesSelectorString(p.metadata.labels, parseSelectorString(selStr)));
  if (a.pos[0]) pods = pods.filter((p) => p.metadata.name === a.pos[0]);
  const withM = pods.filter((p) => m.pods[p.metadata.uid]);
  if (a.pos[0] && !withM.length) {
    if (!pods.length) throw new CmdError(`Error from server (NotFound): pods "${a.pos[0]}" not found`);
    throw new CmdError(`error: metrics not available yet`);
  }
  if (!pods.length) return { chunks: [{ fd: 2, text: allNs ? "No resources found" : `No resources found in ${ns} namespace.` }], ok: true };
  if (!withM.length) throw new CmdError("error: metrics not available yet");
  if (sort === "cpu") withM.sort((x, y) => m.pods[y.metadata.uid].cpu - m.pods[x.metadata.uid].cpu);
  if (sort === "memory") withM.sort((x, y) => m.pods[y.metadata.uid].memory - m.pods[x.metadata.uid].memory);
  if (bflag(a, "--containers")) {
    return table([[...(allNs ? ["NAMESPACE"] : []), "POD", "NAME", "CPU(cores)", "MEMORY(bytes)"], ...withM.flatMap((p) => Object.entries(m.pods[p.metadata.uid].containers).map(([cn, u]) => [...(allNs ? [p.metadata.namespace ?? ""] : []), p.metadata.name, cn, cpu(u.cpu), mem(u.memory)]))]);
  }
  const rows = withM.map((p) => [...(allNs ? [p.metadata.namespace ?? ""] : []), p.metadata.name, cpu(m.pods[p.metadata.uid].cpu), mem(m.pods[p.metadata.uid].memory)]);
  if (bflag(a, "--sum")) {
    const tot = withM.reduce((acc, p) => ({ cpu: acc.cpu + m.pods[p.metadata.uid].cpu, mem: acc.mem + m.pods[p.metadata.uid].memory }), { cpu: 0, mem: 0 });
    rows.push([...(allNs ? [""] : []), "", "________", "________"], [...(allNs ? [""] : []), "", cpu(tot.cpu), mem(tot.mem)]);
  }
  return table([[...(allNs ? ["NAMESPACE"] : []), "NAME", "CPU(cores)", "MEMORY(bytes)"], ...rows]);
}

// ---------------------------------------------------------------- auth

function cmdAuth(s: Session): Res | string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const user = s.user ?? userFor(undefined);
  if (s.path === "auth whoami") {
    const output = sflag(a, "--output");
    if (output) {
      checkOut(s);
      const review = { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview", metadata: { creationTimestamp: null }, status: { userInfo: { groups: user.groups, username: user.name } } };
      return output === "yaml" ? toYaml(review).trimEnd() : output === "json" ? JSON.stringify(review, null, 4) : printWhole([review as unknown as AnyObject], { output, allNs: false });
    }
    return baseTable([["ATTRIBUTE", "VALUE"], ["Username", user.name], ["Groups", `[${user.groups.join(" ")}]`]]);
  }
  const ns = bflag(a, "--all-namespaces") ? undefined : nsOf(ctx, a);
  const quiet = bflag(a, "--quiet");
  if (bflag(a, "--list")) {
    const rules = rulesFor(c, user, ns);
    const rows = [["Resources", "Non-Resource URLs", "Resource Names", "Verbs"]];
    for (const r of rules) {
      if (r.nonResourceURLs?.length) rows.push(["", `[${r.nonResourceURLs.join(" ")}]`, "[]", `[${r.verbs.join(" ")}]`]);
      for (const res of r.resources ?? []) for (const g of r.apiGroups ?? [""]) rows.push([g && g !== "" ? `${res}.${g}` : res, "[]", `[${(r.resourceNames ?? []).join(" ")}]`, `[${r.verbs.join(" ")}]`]);
    }
    return baseTable(bflag(a, "--no-headers") ? rows.slice(1) : rows);
  }
  const [verb, res0] = a.pos;
  if (!verb || !res0) throw new CmdError("error: you must specify two arguments: verb resource or verb resource/resourceName.\nSee 'kubectl auth can-i -h' for help and examples");
  const answer = (ok: boolean, warning?: string): Res => ({ chunks: [...(warning ? [{ fd: 2 as const, text: warning }] : []), ...(quiet ? [] : [{ fd: 1 as const, text: ok ? "yes" : "no" }])], ok });
  if (res0.startsWith("/")) return answer(authorize(c, user, { verb, group: "", resource: "", nonResourceURL: res0 }));
  // resourceTokens := strings.SplitN(args[1], "/", 2): the part after "/" is a resource NAME, never a
  // subresource (that's --subresource), so `deployments.apps/scale` asks about a Deployment named "scale".
  const slash = res0.indexOf("/");
  const res = slash < 0 ? res0 : res0.slice(0, slash);
  const name = slash < 0 ? undefined : res0.slice(slash + 1);
  const r = canIResource(res);
  const ok = authorize(c, user, { verb, group: r.group, resource: r.resource, subresource: sflag(a, "--subresource"), name, namespace: r.namespaced ? ns : undefined });
  return answer(ok, r.warning);
}

/** Resources served by aggregated APIs the simulator models without a stored kind (metrics-server). */
const EXTRA_RESOURCES: { group: string; version: string; plural: string; singular: string; namespaced: boolean }[] = [
  { group: "metrics.k8s.io", version: "v1beta1", plural: "pods", singular: "podmetrics", namespaced: true },
  { group: "metrics.k8s.io", version: "v1beta1", plural: "nodes", singular: "nodemetrics", namespaced: false },
];

/**
 * CanIOptions.resourceFor: "*", a known resource (plural, singular or short name, optionally qualified as
 * RESOURCE.GROUP or RESOURCE.VERSION.GROUP), or an unknown one, which is still asked about verbatim after
 * a warning.
 */
function canIResource(arg: string): { group: string; resource: string; namespaced: boolean; warning?: string } {
  if (arg === "*") return { group: "*", resource: "*", namespaced: true };
  const lower = arg.toLowerCase();
  const info = kindByName(lower);
  if (info) return { group: info.group, resource: info.plural, namespaced: info.namespaced };
  const dot = lower.indexOf(".");
  const resource = dot < 0 ? lower : lower.slice(0, dot);
  let group = dot < 0 ? "" : lower.slice(dot + 1);
  for (const x of EXTRA_RESOURCES) {
    if (resource !== x.plural && resource !== x.singular) continue;
    if (group === x.group || group === `${x.version}.${x.group}`) return { group: x.group, resource: x.plural, namespaced: x.namespaced };
  }
  // ParseResourceArg: "a.b.c" is first tried as resource a, version b, group c.
  if (group.includes(".") && KIND_LIST.some((k) => k.group && group === `${k.version}.${k.group}`)) group = group.slice(group.indexOf(".") + 1);
  // nonStandardResourceNames: users and groups are impersonation targets, not API resources.
  if (!group && (resource === "users" || resource === "groups")) return { group: "", resource: arg, namespaced: true };
  return {
    group: "",
    resource: arg,
    namespaced: true,
    warning: group ? `Warning: the server doesn't have a resource type '${resource}' in group '${group}'` : `Warning: the server doesn't have a resource type '${resource}'`,
  };
}

// ---------------------------------------------------------------- create, run, apply, replace

/** Generator commands take exactly one NAME (create_*.go NameFromCommandArgs). */
function nameArg(s: Session): string {
  if (s.a.pos.length !== 1) throw new CmdError(`error: exactly one NAME is required, got ${s.a.pos.length}\nSee 'kubectl ${s.path} -h' for help and examples`);
  return s.a.pos[0];
}

/** Creates (or, with --dry-run, prints) a generated object. */
function emit(s: Session, obj: AnyObject, verbWord = "created"): string {
  const { a } = s;
  const k = kindOf(obj.kind);
  const output = sflag(a, "--output");
  checkOut(s);
  // Client-side generators only set a namespace when you pass -n.
  if (s.dry === "client" && !sflag(a, "--namespace")) delete obj.metadata.namespace;
  if (s.dry !== "client") can(s, "create", k, obj.metadata.namespace);
  const made = doCreate(s, obj);
  if (output) return report(s, k, [made], verbWord);
  return `${ref(k, obj.metadata.name)} ${verbWord}${suffix(s)}`;
}

function createFromFiles(s: Session): Res {
  const { ctx } = s;
  const ns = nsOf(ctx, s.a);
  checkOut(s);
  const p: Partial = { out: [], errs: [] };
  for (const { objs, source } of readManifests(s, "create")) {
    for (const d of objs) {
      try {
        const k = checkObject(d, source, ns);
        if (k.namespaced) d.metadata.namespace ??= ns;
        if (!d.metadata?.name && !(d.metadata as { generateName?: string })?.generateName) {
          throw new ManifestError(`The ${d.kind} "" is invalid: metadata.name: Required value: name or generateName is required`);
        }
        can(s, "create", k, d.metadata.namespace);
        const made = doCreate(s, d);
        p.out.push(report(s, k, [made], "created"));
      } catch (e) {
        if (!isUserError(e)) throw e;
        p.errs.push(whenDoing(e, "creating", source));
      }
    }
  }
  return partialRes(p);
}

const CREATE_SUBS: Record<string, (s: Session, ns: string) => AnyObject> = {
  "create namespace": (s) => ({ apiVersion: "v1", kind: "Namespace", metadata: { name: nameArg(s) }, spec: {}, status: {} }) as unknown as AnyObject,
  "create deployment": (s, ns) => G.genDeployment(nameArg(s), ns, s.a.flags, s.a.rest) as unknown as AnyObject,
  "create service clusterip": (s, ns) => G.genService("clusterip", nameArg(s), ns, s.a.flags) as unknown as AnyObject,
  "create service nodeport": (s, ns) => G.genService("nodeport", nameArg(s), ns, s.a.flags) as unknown as AnyObject,
  "create service loadbalancer": (s, ns) => G.genService("loadbalancer", nameArg(s), ns, s.a.flags) as unknown as AnyObject,
  "create service externalname": (s, ns) => G.genService("externalname", nameArg(s), ns, s.a.flags) as unknown as AnyObject,
  "create configmap": (s, ns) => G.genConfigMap(nameArg(s), ns, s.a.flags, s.ctx.files ?? {}),
  "create secret generic": (s, ns) => G.genSecret("generic", nameArg(s), ns, s.a.flags, s.ctx.files ?? {}),
  "create secret tls": (s, ns) => G.genSecret("tls", nameArg(s), ns, s.a.flags, s.ctx.files ?? {}),
  "create secret docker-registry": (s, ns) => G.genSecret("docker-registry", nameArg(s), ns, s.a.flags, s.ctx.files ?? {}),
  "create job": (s, ns) => G.genJob(s.ctx.cluster, nameArg(s), ns, s.a.flags, s.a.rest),
  "create cronjob": (s, ns) => G.genCronJob(nameArg(s), ns, s.a.flags, s.a.rest),
  "create serviceaccount": (s, ns) => ({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: nameArg(s), namespace: ns } }) as unknown as AnyObject,
  "create role": (s, ns) => G.genRole("Role", nameArg(s), ns, s.a.flags),
  "create clusterrole": (s, ns) => G.genRole("ClusterRole", nameArg(s), ns, s.a.flags),
  "create rolebinding": (s, ns) => G.genBinding("RoleBinding", nameArg(s), ns, s.a.flags),
  "create clusterrolebinding": (s, ns) => G.genBinding("ClusterRoleBinding", nameArg(s), ns, s.a.flags),
  "create ingress": (s, ns) => G.genIngress(nameArg(s), ns, s.a.flags),
};

function cmdCreate(s: Session): Res | string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  if (s.path === "create") {
    if (aflag(a, "--filename").length || sflag(a, "--kustomize")) return createFromFiles(s);
    if (a.pos.length) throw new CmdError(`error: unknown command "${a.pos[0]}" for "kubectl create"\n\nThe simulator can create: configmap, clusterrole, clusterrolebinding, cronjob, deployment, ingress, job, namespace, role, rolebinding, secret, service, serviceaccount, token (or use -f FILE)`);
    return err(`Error: must specify one of -f and -k\n\n${helpFor("create")}`);
  }
  if (s.path === "create token") {
    const name = nameArg(s);
    can(s, "create", { group: "", plural: "serviceaccounts", namespaced: true }, ns, name, "token");
    c.get("ServiceAccount", ns, name);
    const payload = btoa(JSON.stringify({ aud: aflag(a, "--audience").length ? aflag(a, "--audience") : ["https://kubernetes.default.svc.cluster.local"], sub: `system:serviceaccount:${ns}:${name}`, exp: 1767261600 })).replace(/=+$/, "");
    return `eyJhbGciOiJSUzI1NiIsImtpZCI6Imt1YmVzaW0ifQ.${payload}.c2ltdWxhdGVkLXNpZ25hdHVyZQ`;
  }
  const gen = CREATE_SUBS[s.path];
  return emit(s, gen(s, ns));
}

function cmdRun(s: Session): Res | string {
  const { ctx, a } = s;
  const ns = nsOf(ctx, a);
  const name = a.pos[0];
  checkOut(s);
  let pod = G.genPod(name, sflag(a, "--image") ?? "", ns, a.flags, a.rest.length ? a.rest : a.pos.slice(1));
  // --overrides: a patch over the generated Pod (run.go overrideFields), JSON merge by default, so a
  // containers list replaces the generated one rather than merging into it.
  const overrides = sflag(a, "--overrides");
  if (overrides) {
    const type = sflag(a, "--override-type") ?? "merge";
    if (!(PATCH_TYPES as readonly string[]).includes(type)) throw new CmdError(`error: --override-type must be one of [${PATCH_TYPES.join(" ")}], not "${type}"`);
    try {
      pod = applyPatch(pod, parsePatch(overrides), type) as unknown as typeof pod;
    } catch (e) {
      if (e instanceof PatchError) throw new CmdError(e.message);
      throw e;
    }
  }
  const rm = bflag(a, "--rm");
  const attach = bflag(a, "--stdin") || bflag(a, "--tty") || bflag(a, "--attach");
  if (rm && !attach) throw new CmdError("error: --rm should only be used for attached containers");
  const port = sflag(a, "--port");
  if (bflag(a, "--expose") && !port) throw new CmdError("error: --port must be set when exposing a service");
  if (rm && attach && s.dry === "none") {
    can(s, "create", kindOf("Pod"), ns);
    return ephemeral(s, pod);
  }
  // run.go generateService: a Service named after the Pod, selecting its labels, on --port.
  const svc = bflag(a, "--expose")
    ? ({ apiVersion: "v1", kind: "Service", metadata: { name, namespace: ns }, spec: { ports: [{ port: parseInt(port!, 10), protocol: "TCP", targetPort: parseInt(port!, 10) }], selector: pod.metadata.labels }, status: { loadBalancer: {} } } as unknown as AnyObject)
    : undefined;
  const output = sflag(a, "--output");
  if (svc && output && output !== "name") {
    if (s.dry === "client" && !sflag(a, "--namespace")) {
      delete svc.metadata.namespace;
      delete pod.metadata.namespace;
    }
    const made = [doCreate(s, svc), doCreate(s, pod as unknown as AnyObject)];
    return made.map((o) => printWhole([o], { output, allNs: false })).join(output === "yaml" ? "\n---\n" : "\n");
  }
  const lines = [...(svc ? [emit(s, svc)] : []), emit(s, pod as unknown as AnyObject)];
  if (attach && s.dry === "none") lines.push("If you don't see a command prompt, try pressing enter.\n(The simulator runs Pods detached: use kubectl logs and kubectl exec to talk to it.)");
  return lines.join("\n");
}

/** Applies parsed manifest objects: shared by `kubectl apply -f` and the Editor's Apply button. */
function applyObjects(s: Session, docs: { objs: AnyObject[]; source: string }[]): Res {
  const { ctx } = s;
  const output = sflag(s.a, "--output");
  const serverSide = bflag(s.a, "--server-side");
  const p: Partial = { out: [], errs: [] };
  for (const { objs, source } of docs) {
    for (const d of objs) {
      try {
        const k = checkObject(d, source, ctx.namespace);
        if (k.namespaced) d.metadata.namespace ??= nsOf(ctx, s.a);
        if (!d.metadata?.name) {
          throw new ManifestError(`error: error when retrieving current configuration of:\nResource: "${k.group ? `${k.group}/` : "/"}${k.version}, Resource=${k.plural}", GroupVersionKind: "${k.group ? `${k.group}/` : "/"}${k.version}, Kind=${k.kind}"\nName: "", Namespace: "${k.namespaced ? d.metadata.namespace : ""}"\nfrom server for: "${source}": resource name may not be empty`);
        }
        const exists = !!ctx.cluster.raw(k.kind, d.metadata.namespace, d.metadata.name);
        if (s.user) {
          const attrs: Attributes = { verb: exists ? "patch" : "create", group: k.group, resource: k.plural, name: exists ? d.metadata.name : undefined, namespace: k.namespaced ? d.metadata.namespace : undefined };
          if (!authorize(ctx.cluster, s.user, attrs)) throw new CmdError(forbiddenMessage(s.user, attrs, k.group ? `${k.plural}.${k.group}` : k.plural));
        }
        capReplicas(d);
        // Dry runs apply to a throwaway copy, so -o shows the merged result.
        const target = s.dry === "none" ? ctx.cluster : (s.sandbox ??= new Cluster(ctx.cluster.snapshot()));
        const r = target.apply(d, req(s));
        const word = serverSide ? "serverside-applied" : r.action;
        p.out.push(output ? report(s, k, [r.obj], word) : `${ref(k, d.metadata.name)} ${word}${suffix(s)}`);
      } catch (e) {
        if (!isUserError(e)) throw e;
        const exists = (() => {
          const k = kindForObject(d);
          return !!(k && d.metadata?.name && ctx.cluster.raw(k.kind, d.metadata.namespace, d.metadata.name));
        })();
        p.errs.push(whenDoing(e, exists ? "patching" : "creating", source));
      }
    }
  }
  return partialRes(p);
}

function cmdApply(s: Session): Res {
  if (!aflag(s.a, "--filename").length && !sflag(s.a, "--kustomize")) throw new CmdError("error: must specify one of -f and -k");
  checkOut(s);
  return applyObjects(s, readManifests(s, "apply"));
}

function cmdReplace(s: Session): Res {
  const { ctx } = s;
  if (!aflag(s.a, "--filename").length) throw new CmdError("error: must specify --filename to replace");
  checkOut(s);
  const ns = nsOf(ctx, s.a);
  const p: Partial = { out: [], errs: [] };
  for (const { objs, source } of readManifests(s, "replace")) {
    for (const d of objs) {
      try {
        const k = checkObject(d, source, ns);
        if (k.namespaced) d.metadata.namespace ??= ns;
        can(s, "update", k, d.metadata.namespace, d.metadata.name);
        const cur = ctx.cluster.raw(k.kind, d.metadata.namespace, d.metadata.name);
        if (!cur) throw new CmdError(notFound(k, d.metadata.name));
        let res: AnyObject;
        if (bflag(s.a, "--force") && s.dry === "none") {
          capReplicas(d);
          ctx.cluster.delete(k.kind, d.metadata.namespace, d.metadata.name, { force: true });
          res = ctx.cluster.create(d, req(s));
        } else res = doReplace(s, { ...d, metadata: { ...cur.metadata, ...d.metadata } } as AnyObject);
        p.out.push(report(s, k, [res], "replaced"));
      } catch (e) {
        if (!isUserError(e)) throw e;
        p.errs.push(whenDoing(e, "replacing", source));
      }
    }
  }
  return partialRes(p);
}

// ---------------------------------------------------------------- delete

function cmdDelete(s: Session): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const output = sflag(a, "--output");
  if (output && output !== "name") throw new CmdError(`error: unexpected -o output mode: ${output}. We only support '-o name'`);
  const graceRaw = sflag(a, "--grace-period");
  const force = bflag(a, "--force");
  const now = bflag(a, "--now");
  // delete.go Complete/Validate.
  let grace = graceRaw !== undefined ? Number(graceRaw) : -1;
  if (now) {
    if (grace !== -1) throw new CmdError("error: --now and --grace-period cannot be specified together");
    grace = 1;
  }
  if (grace === 0 && !force) grace = 1;
  if (force && grace < 0) grace = 0;
  if (grace > 0 && force) throw new CmdError("error: --force and --grace-period greater than 0 cannot be specified together");
  const selStr = sflag(a, "--selector");
  const all = bflag(a, "--all");
  if (all && selStr) throw new CmdError("error: cannot set --all and --selector at the same time");
  if (all && sflag(a, "--field-selector")) throw new CmdError("error: cannot set --all and --field-selector at the same time");
  const cascade = flag(a, "--cascade");
  const cascadeS = cascade === undefined || cascade === true ? "background" : String(cascade);
  if (!["background", "foreground", "orphan", "true", "false"].includes(cascadeS)) throw new CmdError(`error: invalid cascade value (${cascadeS}). Must be "background", "foreground", or "orphan"`);
  const propagationPolicy = cascadeS === "orphan" || cascadeS === "false" ? "Orphan" : cascadeS === "foreground" ? "Foreground" : "Background";
  const p: Partial = { out: [], errs: [] };
  if (grace === 0 && force) s.warnings.push("Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.");
  const gone: { kind: string; ns?: string; name: string; uid: string; grace: number }[] = [];
  const del = (k: KindInfo, n: string, nsx: string) => {
    can(s, "delete", k, nsx, n);
    const o = c.raw(k.kind, k.namespaced ? nsx : undefined, n);
    if (!o) {
      if (!bflag(a, "--ignore-not-found")) p.errs.push(notFound(k, n));
      return;
    }
    if (s.dry !== "client") writeTarget(s).delete(k.kind, k.namespaced ? nsx : undefined, n, { force: grace === 0, gracePeriodSeconds: grace >= 0 ? grace : undefined, propagationPolicy });
    if (s.dry === "none") gone.push({ kind: k.kind, ns: k.namespaced ? nsx : undefined, name: n, uid: o.metadata.uid, grace: grace >= 0 ? grace : ((o.spec as { terminationGracePeriodSeconds?: number })?.terminationGracePeriodSeconds ?? 30) });
    if (output === "name") p.out.push(ref(k, n));
    else p.out.push(`${k.singular}${k.group ? "." + k.group : ""} "${n}" ${grace === 0 ? "force deleted" : "deleted"}${k.namespaced ? ` from ${nsx} namespace` : ""}${suffix(s)}`);
  };
  if (aflag(a, "--filename").length) {
    for (const { objs, source } of readManifests(s, "delete")) {
      for (const d of objs) {
        try {
          const k = checkObject(d, source, ns);
          del(k, d.metadata.name, d.metadata.namespace ?? ns);
        } catch (e) {
          if (!isUserError(e)) throw e;
          p.errs.push(errText(e));
        }
      }
    }
  } else {
    const allNs = bflag(a, "--all-namespaces");
    for (const { k, names } of targets(a.pos, "delete")) {
      if (!names.length && !all && !selStr && !sflag(a, "--field-selector")) throw new CmdError("error: resource(s) were provided, but no name was specified");
      if (names.length) {
        for (const n of names) del(k, n, ns);
        continue;
      }
      let list = c.list(k.kind, k.namespaced && !allNs ? ns : undefined).filter((o) => !selStr || matchesSelectorString(o.metadata.labels, parseSelectorString(selStr)));
      const field = sflag(a, "--field-selector");
      if (field) list = list.filter(fieldFilter(k, field));
      if (k.kind === "Namespace" && all) list = list.filter((o) => !["default", "kube-system", "kube-public", "kube-node-lease", "local-path-storage", "ingress-nginx"].includes(o.metadata.name));
      for (const o of list) del(k, o.metadata.name, o.metadata.namespace ?? ns);
    }
    if (!p.out.length && !p.errs.length) return { chunks: [{ fd: 2, text: "No resources found" }], ok: true };
  }
  // --wait (default true): kubectl blocks until the objects are really gone (graceful termination, finalizers).
  if (gone.length && flag(a, "--wait") !== false) {
    const exists = (g: (typeof gone)[number]) => c.raw(g.kind, g.ns, g.name)?.metadata.uid === g.uid;
    const timeout = sflag(a, "--timeout") && sflag(a, "--timeout") !== "0" && sflag(a, "--timeout") !== "0s" ? goDuration(sflag(a, "--timeout"), 0) : undefined;
    const cap = timeout ?? Math.min(120_000, Math.max(...gone.map((g) => (g.kind === "Namespace" ? 60 : g.grace + 10))) * 1000);
    for (let t = 0; t < cap && gone.some(exists); t += 250) c.advance(250);
    const left = gone.find(exists);
    if (left && timeout !== undefined) p.errs.push(`error: timed out waiting for the condition on ${kindByName(left.kind)!.plural}/${left.name}`);
  }
  return partialRes(p);
}

// ---------------------------------------------------------------- scale, set, label, taint, patch, expose, autoscale

/** Objects named by TYPE NAME…, TYPE/NAME…, or TYPE with --all / -l. */
function selected(s: Session, pos: string[], what: string): { k: KindInfo; name: string }[] {
  const { ctx, a } = s;
  const ns = nsOf(ctx, a);
  const selStr = sflag(a, "--selector");
  const out: { k: KindInfo; name: string }[] = [];
  for (const t of targets(pos, what)) {
    if (t.names.length) out.push(...t.names.map((name) => ({ k: t.k, name })));
    else if (bflag(a, "--all") || selStr) {
      const list = ctx.cluster.list(t.k.kind, t.k.namespaced ? ns : undefined).filter((o) => !selStr || matchesSelectorString(o.metadata.labels, parseSelectorString(selStr)));
      out.push(...list.map((o) => ({ k: t.k, name: o.metadata.name })));
    } else throw new CmdError("error: resource(s) were provided, but no name was specified");
  }
  return out;
}

function cmdScale(s: Session): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  checkOut(s);
  const raw = sflag(a, "--replicas");
  if (raw === undefined) throw new CmdError('error: required flag(s) "replicas" not set');
  const n = Number(raw);
  if (n < 0) throw new CmdError("error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0");
  const cur = sflag(a, "--current-replicas");
  const p: Partial = { out: [], errs: [] };
  const items = selected(s, a.pos, "scale");
  if (!items.length) return { chunks: [{ fd: 2, text: `No resources found in ${ns} namespace.` }], ok: true };
  for (const { k, name } of items) {
    try {
      if (!["Deployment", "ReplicaSet", "StatefulSet"].includes(k.kind)) throw new CmdError(`error: cannot scale ${k.plural}`);
      can(s, "patch", k, ns, name, "scale");
      const o = c.raw(k.kind, ns, name) as unknown as Deployment | undefined;
      if (!o) throw new CmdError(notFound(k, name));
      if (cur !== undefined && cur !== "-1" && (o.spec?.replicas ?? 1) !== Number(cur)) throw new CmdError(`error: Expected replicas to be ${cur}, was ${o.spec?.replicas ?? 1}`);
      const res = doReplace(s, { ...o, spec: { ...o.spec!, replicas: n } } as unknown as AnyObject);
      p.out.push(report(s, k, [res], "scaled"));
    } catch (e) {
      if (!isUserError(e)) throw e;
      p.errs.push(errText(e));
    }
  }
  return partialRes(p);
}

function workloadTemplate(o: AnyObject): { spec: { containers: AnyObject["spec"] & { name: string }[] } } | undefined {
  if (o.kind === "Pod") return { spec: o.spec as never };
  if (o.kind === "CronJob") return (o.spec as { jobTemplate: { spec: { template: never } } }).jobTemplate.spec.template;
  return (o.spec as { template?: never })?.template;
}

/**
 * cmdutil.GetResourcesAndPairs: resources first, then KEY=VAL / KEY- (or NAME=IMAGE) changes.
 * A resource after a change is an error.
 */
function resourcesAndPairs(args: string[], pairType: string, isPair = (x: string) => (x.includes("=") && !x.startsWith("=")) || x.endsWith("-")): { resources: string[]; pairs: string[] } {
  const resources: string[] = [];
  const pairs: string[] = [];
  let inPairs = false;
  for (const x of args) {
    if (isPair(x)) {
      inPairs = true;
      pairs.push(x);
    } else if (inPairs) throw new CmdError(`error: all resources must be specified before ${pairType} changes: ${x}`);
    else resources.push(x);
  }
  return { resources, pairs };
}

type Tpl = { spec: { containers: { name: string; image: string; env?: { name: string; value?: string; valueFrom?: unknown }[]; envFrom?: unknown[]; resources?: { limits?: Record<string, string>; requests?: Record<string, string> } }[]; serviceAccountName?: string } };

function cmdSet(s: Session): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const what = s.path.split(" ")[1];
  checkOut(s);
  let resources: string[];
  let pairs: string[];
  if (what === "serviceaccount") {
    if (a.pos.length < 2) throw new CmdError("error: serviceaccount is required\nSee 'kubectl set serviceaccount -h' for help and examples");
    resources = a.pos.slice(0, -1);
    pairs = a.pos.slice(-1);
  } else ({ resources, pairs } = resourcesAndPairs(a.pos, what === "image" ? "image" : what === "env" ? "env" : "resource"));
  if (what === "image" && !pairs.length) throw new CmdError("error: at least one image update is required");
  if (what === "env" && !pairs.length && !sflag(a, "--from") && !aflag(a, "--env").length && !bflag(a, "--list")) throw new CmdError("error: at least one environment variable must be provided");
  const limits = sflag(a, "--limits");
  const requests = sflag(a, "--requests");
  if (what === "resources" && !limits && !requests) throw new CmdError("error: you must specify an update to requests or limits (in the form of --requests/--limits)");
  if (!resources.length) throw new CmdError(`error: one or more resources must be specified as <resource> <name> or <resource>/<name>`);
  const p: Partial = { out: [], errs: [] };
  for (const { k, name } of selected(s, resources, "set")) {
    try {
      can(s, "patch", k, ns, name);
      const cur = c.raw(k.kind, k.namespaced ? ns : undefined, name);
      if (!cur) throw new CmdError(notFound(k, name));
      const o = structuredClone(cur);
      const tpl = workloadTemplate(o) as unknown as Tpl | undefined;
      if (!tpl) throw new CmdError(`error: ${plural(k)} "${name}" has no pod template`);
      const pick = () => {
        const cn = sflag(a, "--containers") ?? "*";
        return tpl.spec.containers.filter((x) => cn === "*" || cn.split(",").includes(x.name));
      };
      let word = "";
      if (what === "image") {
        for (const kv of pairs) {
          const i = kv.indexOf("=");
          const [cn, img] = [kv.slice(0, i), kv.slice(i + 1)];
          const cts = tpl.spec.containers.filter((x) => x.name === cn || cn === "*");
          if (!cts.length) throw new CmdError(`error: unable to find container named "${cn}"`);
          for (const ct of cts) ct.image = img;
        }
        word = "image updated";
      } else if (what === "env") {
        if (bflag(a, "--list")) {
          p.out.push(pick().flatMap((ct) => [`# ${k.kind} ${name}, container ${ct.name}`, ...(ct.env ?? []).map((e) => (e.value !== undefined ? `${e.name}=${e.value}` : `# ${e.name} from ${Object.keys(e.valueFrom ?? {})[0] ?? "a field"}`))]).join("\n"));
          continue;
        }
        // --from=secret/NAME|configmap/NAME adds one env var per key, each with valueFrom
        // (set_env.go: keyToEnvName upper-cases the key and turns other characters into _).
        let fromVars: { name: string; valueFrom: unknown }[] = [];
        const from = sflag(a, "--from");
        if (from) {
          const [fk, fn] = from.split("/");
          const fromKind = kindOf(fk);
          if (fromKind.kind !== "ConfigMap" && fromKind.kind !== "Secret") throw new CmdError(`error: unsupported resource specified in --from`);
          const src = c.get(fromKind.kind, ns, fn) as AnyObject & { data?: Record<string, string> };
          const prefix = sflag(a, "--prefix") ?? "";
          const refField = fromKind.kind === "ConfigMap" ? "configMapKeyRef" : "secretKeyRef";
          const keys = aflag(a, "--keys");
          fromVars = Object.keys(src.data ?? {})
            .filter((key) => !keys.length || keys.includes(key))
            .sort()
            .map((key) => ({ name: prefix + key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase(), valueFrom: { [refField]: { name: fn, key } } }));
        }
        for (const ct of pick()) {
          for (const v of fromVars) {
            const env = (ct.env ??= []);
            const i = env.findIndex((e) => e.name === v.name);
            if (i >= 0) env[i] = v;
            else env.push(v);
          }
          for (const kv of [...pairs, ...aflag(a, "--env")]) {
            if (kv.endsWith("-") && !kv.includes("=")) ct.env = (ct.env ?? []).filter((e) => e.name !== kv.slice(0, -1));
            else {
              const i = kv.indexOf("=");
              if (i < 0) throw new CmdError(`error: invalid env: ${kv}`);
              const env = (ct.env ??= []);
              const curEnv = env.find((e) => e.name === kv.slice(0, i));
              if (curEnv) {
                curEnv.value = kv.slice(i + 1);
                delete curEnv.valueFrom;
              } else env.push({ name: kv.slice(0, i), value: kv.slice(i + 1) });
            }
          }
        }
        word = "env updated";
      } else if (what === "resources") {
        const parse = (v?: string) => (v ? Object.fromEntries(v.split(",").map((x) => x.split("="))) : undefined);
        const lim = parse(limits);
        const req = parse(requests);
        for (const ct of pick()) {
          ct.resources = { ...(ct.resources ?? {}), ...(lim ? { limits: { ...(ct.resources?.limits ?? {}), ...lim } } : {}), ...(req ? { requests: { ...(ct.resources?.requests ?? {}), ...req } } : {}) };
        }
        word = "resource requirements updated";
      } else {
        tpl.spec.serviceAccountName = pairs[0];
        word = "serviceaccount updated";
      }
      const res = doReplace(s, o);
      p.out.push(report(s, k, [res], word));
    } catch (e) {
      if (!isUserError(e)) throw e;
      p.errs.push(errText(e));
    }
  }
  return partialRes(p);
}

/** validation.IsQualifiedName / IsValidLabelValue, as kubectl label checks them before sending. */
const QUALIFIED = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]{0,61})?[A-Za-z0-9])?$/;

function cmdMeta(s: Session, field: "labels" | "annotations"): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const what = field === "labels" ? "label" : "annotate";
  checkOut(s);
  const { resources, pairs } = resourcesAndPairs(a.pos, field === "labels" ? "label" : "annotation");
  if (!resources.length) throw new CmdError("error: one or more resources must be specified as <resource> <name> or <resource>/<name>");
  const list = bflag(a, "--list");
  if (!pairs.length && !list) throw new CmdError(`error: at least one ${field === "labels" ? "label" : "annotation"} update is required`);
  const changes: { key: string; value?: string }[] = [];
  for (const kv of pairs) {
    if (kv.endsWith("-") && !kv.includes("=")) {
      changes.push({ key: kv.slice(0, -1) });
      continue;
    }
    const i = kv.indexOf("=");
    const key = kv.slice(0, i);
    const value = kv.slice(i + 1);
    if (field === "labels" && (!QUALIFIED.test(key) || !LABEL_VALUE.test(value))) throw new CmdError(`error: invalid label spec: ${kv}`);
    changes.push({ key, value });
  }
  const p: Partial = { out: [], errs: [] };
  const allNs = bflag(a, "--all-namespaces");
  const items: { k: KindInfo; name: string; ns: string }[] = [];
  for (const t of targets(resources, what)) {
    if (t.names.length) items.push(...t.names.map((name) => ({ k: t.k, name, ns })));
    else if (bflag(a, "--all") || sflag(a, "--selector") || sflag(a, "--field-selector")) {
      const selStr = sflag(a, "--selector");
      let objs = c.list(t.k.kind, t.k.namespaced && !allNs ? ns : undefined).filter((o) => !selStr || matchesSelectorString(o.metadata.labels, parseSelectorString(selStr)));
      const fs = sflag(a, "--field-selector");
      if (fs) objs = objs.filter(fieldFilter(t.k, fs));
      items.push(...objs.map((o) => ({ k: t.k, name: o.metadata.name, ns: o.metadata.namespace ?? ns })));
    } else throw new CmdError("error: resource(s) were provided, but no name was specified");
  }
  for (const { k, name, ns: nsx } of items) {
    try {
      can(s, "patch", k, nsx, name);
      const o = c.raw(k.kind, k.namespaced ? nsx : undefined, name);
      if (!o) throw new CmdError(notFound(k, name));
      const m = { ...(o.metadata[field] ?? {}) };
      if (list) {
        p.out.push(Object.entries(m).map(([key, v]) => `${key}=${v}`).join("\n"));
        continue;
      }
      for (const ch of changes) {
        if (ch.value === undefined) delete m[ch.key];
        else {
          if (m[ch.key] !== undefined && m[ch.key] !== ch.value && !bflag(a, "--overwrite")) throw new CmdError(`error: '${ch.key}' already has a value (${m[ch.key]}), and --overwrite is false`);
          m[ch.key] = ch.value;
        }
      }
      const same = JSON.stringify(m) === JSON.stringify(o.metadata[field] ?? {});
      const res = same && s.dry === "none" ? o : doReplace(s, { ...o, metadata: { ...o.metadata, [field]: Object.keys(m).length ? m : undefined } } as AnyObject);
      p.out.push(report(s, k, [res], `${same ? "not " : ""}${field === "labels" ? "labeled" : "annotated"}`));
    } catch (e) {
      if (!isUserError(e)) throw e;
      p.errs.push(errText(e));
    }
  }
  return partialRes(p);
}

function cmdTaint(s: Session): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  checkOut(s);
  const [kindWord, ...rest] = a.pos;
  if (!kindWord || !/^(node|nodes|no)$/.test(kindWord.split("/")[0])) throw new CmdError("error: at least one resource name must be specified since 'all' parameter is not set");
  const selStr = sflag(a, "--selector");
  const nodes = kindWord.includes("/") ? [kindWord.split("/")[1]] : bflag(a, "--all") || selStr ? c.list<Node>("Node").filter((n) => !selStr || matchesSelectorString(n.metadata.labels, parseSelectorString(selStr))).map((n) => n.metadata.name) : rest.length ? [rest.shift()!] : [];
  if (!nodes.length) throw new CmdError("error: at least one resource name must be specified since 'all' parameter is not set");
  const specs = rest;
  if (!specs.length) throw new CmdError("error: at least one taint update is required");
  const p: Partial = { out: [], errs: [] };
  for (const name of nodes) {
    try {
      can(s, "patch", kindOf("Node"), undefined, name);
      const n = c.get<Node>("Node", undefined, name);
      let taints: Taint[] = [...(n.spec?.taints ?? [])];
      let removed = false;
      for (const spec of specs) {
        if (spec.endsWith("-")) {
          const body = spec.slice(0, -1);
          const [key, effect] = body.split(":");
          const before = taints.length;
          taints = taints.filter((t) => !(t.key === key.split("=")[0] && (!effect || t.effect === effect)));
          if (taints.length === before) throw new CmdError(`error: taint "${body}" not found`);
          removed = true;
          continue;
        }
        const m = spec.match(/^([^=:]+)(?:=([^:]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/);
        if (!m) {
          const eff = spec.split(":")[1];
          throw new CmdError(eff ? `error: invalid taint effect: ${eff}, unsupported taint effect` : `error: invalid taint spec: ${spec}`);
        }
        const [, key, value, effect] = m;
        const existing = taints.find((t) => t.key === key && t.effect === effect);
        if (existing && !bflag(a, "--overwrite")) throw new CmdError(`error: node ${name} already has ${key} taint(s) with same effect(s) and --overwrite is false`);
        taints = taints.filter((t) => !(t.key === key && t.effect === effect));
        taints.push({ key, ...(value ? { value } : {}), effect: effect as Taint["effect"], ...(effect === "NoExecute" ? { timeAdded: c.now } : {}) });
      }
      const res = doReplace(s, { ...n, spec: { ...n.spec, taints: taints.length ? taints : undefined } } as unknown as AnyObject);
      p.out.push(report(s, kindOf("Node"), [res], removed && specs.every((x) => x.endsWith("-")) ? "untainted" : "tainted"));
    } catch (e) {
      if (!isUserError(e)) throw e;
      p.errs.push(errText(e));
    }
  }
  return partialRes(p);
}

function cmdPatch(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  checkOut(s);
  const type = sflag(a, "--type") ?? "strategic";
  if (!(PATCH_TYPES as readonly string[]).includes(type)) throw new CmdError(`error: --type must be one of [json merge strategic], not "${type}"`);
  let raw = sflag(a, "--patch");
  const pf = sflag(a, "--patch-file");
  if (raw !== undefined && pf) throw new CmdError("error: cannot specify --patch and --patch-file together");
  if (pf) {
    raw = ctx.files?.[pf.replace(/^\.\//, "")];
    if (raw === undefined) throw new CmdError(`error: unable to read patch file: open ${pf}: no such file or directory`);
  }
  if (!raw) throw new CmdError("error: must specify --patch or --patch-file containing the contents of the patch");
  const t = targets(a.pos, "patch")[0];
  const name = t.names[0];
  if (!name) throw new CmdError("error: resource(s) were provided, but no name was specified");
  const patch = parsePatch(raw);
  can(s, "patch", t.k, ns, name);
  const o = c.get(t.k.kind, t.k.namespaced ? ns : undefined, name);
  const next = applyPatch(o, patch, type) as unknown as AnyObject;
  if (next.metadata?.name !== name) throw new CmdError(`Error from server (BadRequest): the name of the object (${next.metadata?.name ?? ""}) does not match the name on the URL (${name})`);
  if (next.kind !== o.kind) throw new CmdError(`Error from server (BadRequest): the kind of the object (${next.kind ?? ""}) does not match the kind on the URL (${o.kind})`);
  const bad = decodeError(next, t.k);
  if (bad) throw new CmdError(`Error from server (BadRequest): ${bad}`);
  const before = JSON.stringify(o);
  const res = doReplace(s, next);
  const output = sflag(a, "--output");
  if (output) return report(s, t.k, [res], "patched");
  const after = s.dry === "none" ? JSON.stringify(c.get(t.k.kind, t.k.namespaced ? ns : undefined, name)) : JSON.stringify(res);
  return `${ref(t.k, name)} patched${before === after ? " (no change)" : ""}${suffix(s)}`;
}

function cmdExpose(s: Session): string {
  const { ctx, a } = s;
  const ns = nsOf(ctx, a);
  const t = targets(a.pos, "expose")[0];
  if (!t.names[0]) throw new CmdError("error: resource(s) were provided, but no name was specified");
  can(s, "get", t.k, ns, t.names[0]);
  // Real kubectl fetches the object first, then checks polymorphichelpers.canBeExposed: pod, service,
  // replicationcontroller, deployment, replicaset. The error names the GroupKind, e.g. "StatefulSet.apps".
  if (!["Deployment", "ReplicaSet", "Pod", "Service", "ReplicationController"].includes(t.k.kind)) {
    ctx.cluster.get(t.k.kind, t.k.namespaced ? ns : undefined, t.names[0]);
    throw new CmdError(`error: cannot expose a ${t.k.kind}${t.k.group ? `.${t.k.group}` : ""}`);
  }
  const svc = G.genExpose(ctx.cluster, t.k.kind, t.names[0], ns, a.flags) as unknown as AnyObject;
  const labels = sflag(a, "--labels");
  if (labels) svc.metadata.labels = Object.fromEntries(labels.split(",").map((x) => x.split("=")));
  const sel = sflag(a, "--selector");
  if (sel) (svc.spec as { selector: Record<string, string> }).selector = Object.fromEntries(sel.split(",").map((x) => x.split("=")));
  return emit(s, svc, "exposed");
}

function cmdAutoscale(s: Session): string {
  const { ctx, a } = s;
  const ns = nsOf(ctx, a);
  const t = targets(a.pos, "autoscale")[0];
  if (!t.names[0]) throw new CmdError("error: resource(s) were provided, but no name was specified");
  if (!["Deployment", "ReplicaSet", "StatefulSet"].includes(t.k.kind)) throw new CmdError(`error: cannot autoscale a ${t.k.kind}: not a scalable resource`);
  ctx.cluster.get(t.k.kind, ns, t.names[0]);
  return emit(s, G.genHPA(t.k.kind, t.names[0], ns, a.flags), "autoscaled");
}

// ---------------------------------------------------------------- wait, nodes

/** When each streaming `kubectl wait` started, per cluster, so --timeout works across re-runs. */
const waitStarts = new WeakMap<Cluster, Map<string, number>>();

function cmdWait(s: Session): Res {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const forS = sflag(a, "--for");
  if (!forS) throw new CmdError("error: --for must be set: --for=condition=Ready, --for=delete or --for=jsonpath='{.status.phase}'=Running");
  const selStr = sflag(a, "--selector");
  const objs: { k: KindInfo; name: string; o?: AnyObject }[] = [];
  for (const t of targets(a.pos, "wait")) {
    const names = t.names.length ? t.names : c.list(t.k.kind, t.k.namespaced ? ns : undefined).filter((o) => bflag(a, "--all") || (selStr && matchesSelectorString(o.metadata.labels, parseSelectorString(selStr)))).map((o) => o.metadata.name);
    if (!names.length && forS !== "create") throw new CmdError("error: no matching resources found");
    for (const n of names) {
      can(s, "get", t.k, ns, n);
      objs.push({ k: t.k, name: n, o: c.raw(t.k.kind, t.k.namespaced ? ns : undefined, n) });
    }
  }
  const met = (x: { o?: AnyObject }): boolean => {
    if (forS === "delete") return !x.o;
    if (forS === "create") return !!x.o;
    if (!x.o) throw new CmdError(`Error from server (NotFound): ${objs[0].k.plural} "${objs[0].name}" not found`);
    const cm = forS.match(/^condition=([^=]+)(?:=(.+))?$/i);
    if (cm) {
      const want = (cm[2] ?? "True").toLowerCase();
      const conds = (x.o.status as { conditions?: { type: string; status: string }[] })?.conditions ?? [];
      return conds.some((cd) => cd.type.toLowerCase() === cm[1].toLowerCase() && cd.status.toLowerCase() === want);
    }
    const jm = forS.match(/^jsonpath=\{?(.+?)\}?(?:=(.*))?$/);
    if (jm) {
      const v = evalPath(toApiShape(x.o), jm[1].replace(/^'|'$/g, ""));
      return jm[2] === undefined ? v.length > 0 : v.map(formatValue).includes(jm[2].replace(/^'|'$/g, ""));
    }
    throw new CmdError(`error: unrecognized condition: "${forS}"`);
  };
  const starts = waitStarts.get(c) ?? waitStarts.set(c, new Map()).get(c)!;
  if (objs.every(met)) {
    starts.delete(s.line);
    return out(objs.map((x) => `${ref(x.k, x.name)} condition met`).join("\n"));
  }
  // Default --timeout is 30s (of simulated time here).
  const started = starts.get(s.line) ?? c.now;
  starts.set(s.line, started);
  if (c.now - started >= goDuration(sflag(a, "--timeout"), 30_000)) {
    starts.delete(s.line);
    const pending = objs.find((x) => !met(x))!;
    return err(`error: timed out waiting for the condition on ${pending.k.plural}/${pending.name}`);
  }
  return { chunks: [], ok: true, watch: s.line };
}

function nodesArg(s: Session, verb: string): string[] {
  const { a, ctx } = s;
  const selStr = sflag(a, "--selector");
  if (selStr) return ctx.cluster.list<Node>("Node").filter((n) => matchesSelectorString(n.metadata.labels, parseSelectorString(selStr))).map((n) => n.metadata.name);
  if (!a.pos.length) throw new CmdError(`error: USAGE: ${verb} NODE [flags]\nSee 'kubectl ${verb} -h' for help and examples`);
  return a.pos.map((p) => (p.includes("/") ? p.split("/")[1] : p));
}

function cmdCordon(s: Session, on: boolean): Res {
  const c = s.ctx.cluster;
  const p: Partial = { out: [], errs: [] };
  for (const node of nodesArg(s, on ? "cordon" : "uncordon")) {
    try {
      can(s, "patch", kindOf("Node"), undefined, node);
      const n = c.get<Node>("Node", undefined, node);
      if (!!n.spec?.unschedulable === on) {
        p.out.push(`node/${node} already ${on ? "cordoned" : "uncordoned"}`);
        continue;
      }
      if (s.dry !== "client") writeTarget(s).replace({ ...n, spec: { ...n.spec, unschedulable: on || undefined } }, req(s));
      p.out.push(`node/${node} ${on ? "cordoned" : "uncordoned"}${suffix(s)}`);
    } catch (e) {
      if (!isUserError(e)) throw e;
      p.errs.push(errText(e));
    }
  }
  return partialRes(p);
}

const DRAIN_RETRY_MS = 5000;

/** A drain still waiting on evictions its PodDisruptionBudgets refused, and the nodes after it. */
interface DrainRun {
  p: Partial;
  node: string;
  pending: Pod[];
  rest: string[];
  next: number;
  started: number;
}
const drainRuns = new WeakMap<Cluster, Map<string, DrainRun>>();

/** Go's time.Duration.String() for whole milliseconds: 5s, 1m0s, 1h30m0s. */
function goDurationString(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h ? `${h}h${m}m` : m ? `${m}m` : ""}${(ms % 60_000) / 1000}s`;
}

/**
 * kubectl drain. A Pod its PodDisruptionBudget can't spare is retried every 5s
 * (drain.go evictPods), so the command keeps streaming until the budget allows it,
 * --timeout runs out, or Ctrl+C. Nodes after a blocked one wait their turn.
 */
function cmdDrain(s: Session): Res {
  const { a } = s;
  const c = s.ctx.cluster;
  const runs = drainRuns.get(c) ?? drainRuns.set(c, new Map()).get(c)!;
  const timeout = goDuration(sflag(a, "--timeout"), 0);
  const prev = s.ctx.live ? runs.get(s.line) : undefined;
  runs.delete(s.line);
  const p: Partial = prev?.p ?? { out: [], errs: [] };
  const nodes = prev ? prev.rest : nodesArg(s, "drain");
  if (prev) {
    const { node } = prev;
    if (timeout && c.now - prev.started >= timeout) {
      const why = `drain did not complete within ${goDurationString(timeout)}`;
      p.errs.push([`There are pending pods in node "${node}" when an error occurred: ${why}`, ...prev.pending.map((x) => `pod/${x.metadata.name}`), `error: unable to drain node "${node}" due to error: ${why}, continuing command...`, "There are pending nodes to be drained:", ` ${node}`, `error: ${why}`].join("\n"));
      return partialRes(p);
    }
    if (c.now < prev.next) {
      runs.set(s.line, prev);
      return { ...partialRes(p), watch: s.line };
    }
    const lines: string[] = [];
    const pending = A.evictPods(c, prev.pending, lines);
    c.tick(0);
    if (!pending.length) lines.push(`node/${node} drained`);
    p.out[p.out.length - 1] += "\n" + lines.join("\n");
    if (pending.length) {
      runs.set(s.line, { ...prev, pending, next: c.now + DRAIN_RETRY_MS });
      return { ...partialRes(p), watch: s.line };
    }
  }
  for (const [i, node] of nodes.entries()) {
    can(s, "patch", kindOf("Node"), undefined, node);
    // Dry runs drain a throwaway copy, then mark what would have happened.
    const target = s.dry === "none" ? c : (s.sandbox ??= new Cluster(c.snapshot()));
    const r = A.drain(target, node, {
      ignoreDaemonSets: bflag(a, "--ignore-daemonsets"),
      deleteEmptyDir: bflag(a, "--delete-emptydir-data") || bflag(a, "--delete-local-data"),
      force: bflag(a, "--force"),
      disableEviction: bflag(a, "--disable-eviction"),
      dryRun: s.dry !== "none",
    });
    let text = r.out;
    if (s.dry !== "none") {
      text = text
        .split("\n")
        .filter((l) => !/^pod\/\S+ evicted$/.test(l))
        .map((l) => (/^(node\/\S+ (cordoned|drained)|evicting pod \S+)$/.test(l) ? l + suffix(s) : l))
        .join("\n");
    }
    if (r.ok) p.out.push(text);
    else p.errs.push(text);
    if (r.blocked.length) {
      runs.set(s.line, { p, node, pending: r.blocked, rest: nodes.slice(i + 1), next: c.now + DRAIN_RETRY_MS, started: c.now });
      return { ...partialRes(p), watch: s.line };
    }
  }
  return partialRes(p);
}

// ---------------------------------------------------------------- config, version, cluster-info, events, api-*

const CONTEXT = "kind-kubesim";

function kubeconfig(ctx: KubectlContext) {
  return {
    apiVersion: "v1",
    clusters: [{ cluster: { "certificate-authority-data": "DATA+OMITTED", server: "https://127.0.0.1:6443" }, name: CONTEXT }],
    contexts: [{ context: { cluster: CONTEXT, ...(ctx.namespace !== "default" ? { namespace: ctx.namespace } : {}), user: CONTEXT }, name: CONTEXT }],
    "current-context": CONTEXT,
    kind: "Config",
    preferences: {},
    users: [{ name: CONTEXT, user: { "client-certificate-data": "DATA+OMITTED", "client-key-data": "DATA+OMITTED" } }],
  };
}

function cmdConfig(s: Session): string | Res {
  const { ctx, a } = s;
  switch (s.path) {
    case "config set-context": {
      const name = a.pos[0];
      if (!name && !bflag(a, "--current")) throw new CmdError("error: you must specify a non-empty context name or --current\nSee 'kubectl config set-context -h' for help and examples");
      if (name && name !== CONTEXT) throw new CmdError(`error: the simulator has a single context, "${CONTEXT}"; use --current (or ${CONTEXT}) instead of "${name}"`);
      const nsFlag = a.flags["--namespace"];
      if (typeof nsFlag === "string") ctx.namespace = nsFlag || "default";
      return `Context "${CONTEXT}" modified.`;
    }
    case "config current-context":
      return CONTEXT;
    case "config use-context":
      if (!a.pos[0]) throw new CmdError("error: Unexpected args: []\nSee 'kubectl config use-context -h' for help and examples");
      if (a.pos[0] !== CONTEXT) throw new CmdError(`error: no context exists with the name: "${a.pos[0]}"`);
      return `Switched to context "${CONTEXT}".`;
    case "config get-contexts": {
      if (sflag(a, "--output") === "name") return CONTEXT;
      const rows = [["CURRENT", "NAME", "CLUSTER", "AUTHINFO", "NAMESPACE"], ["*", CONTEXT, CONTEXT, CONTEXT, ctx.namespace === "default" ? "" : ctx.namespace]];
      return baseTable(bflag(a, "--no-headers") ? rows.slice(1) : rows);
    }
    case "config get-clusters":
    case "config get-users":
      return `NAME\n${CONTEXT}`;
    case "config view": {
      const output = sflag(a, "--output") ?? "yaml";
      if (output === "json") return JSON.stringify(kubeconfig(ctx), null, 4);
      if (output === "yaml") return toYaml(kubeconfig(ctx)).trimEnd();
      return printWhole([kubeconfig(ctx) as unknown as AnyObject], { output, allNs: false });
    }
  }
  throw new CmdError("error: the simulator supports: config view, current-context, get-contexts, use-context, set-context --current --namespace=NAME");
}

function cmdVersion(s: Session): string {
  const output = sflag(s.a, "--output");
  const info = (gitVersion: string) => ({ major: "1", minor: "37", gitVersion, gitCommit: "0000000000000000000000000000000000000000", gitTreeState: "clean", buildDate: "2026-09-15T00:00:00Z", goVersion: "go1.25.1", compiler: "gc", platform: "linux/amd64" });
  const doc = { clientVersion: info("v1.37.0"), kustomizeVersion: "v5.7.1", ...(bflag(s.a, "--client") ? {} : { serverVersion: info("v1.37.0") }) };
  if (output === "json") return JSON.stringify(doc, null, 2);
  if (output === "yaml") return toYaml(doc).trimEnd();
  if (output) throw new CmdError("error: --output must be 'yaml' or 'json'");
  return bflag(s.a, "--client") ? "Client Version: v1.37.0\nKustomize Version: v5.7.1" : "Client Version: v1.37.0\nKustomize Version: v5.7.1\nServer Version: v1.37.0 (simulated)";
}

function cmdClusterInfo(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  if (s.path === "cluster-info") {
    if (a.pos.length) throw new CmdError(`error: unknown command "${a.pos.join(" ")}"\nSee 'kubectl cluster-info -h' for help and examples`);
    return "Kubernetes control plane is running at https://127.0.0.1:6443\nCoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.";
  }
  // cluster-info dump: the nodes, then each namespace's objects, then every container's logs.
  const namespaces = bflag(a, "--all-namespaces") ? c.list("Namespace").map((n) => n.metadata.name) : aflag(a, "--namespaces").length ? aflag(a, "--namespaces") : ["kube-system", nsOf(ctx, a)];
  const list = (kind: string, objs: AnyObject[]) => JSON.stringify({ kind: `${kind}List`, apiVersion: kindByName(kind)?.group ? `${kindByName(kind)!.group}/${kindByName(kind)!.version}` : "v1", metadata: { resourceVersion: "" }, items: objs.map((o) => toApiShape(o)) }, null, 4);
  const parts = [list("Node", c.list("Node"))];
  for (const ns of [...new Set(namespaces)]) {
    for (const kind of ["Event", "ReplicationController", "Service", "DaemonSet", "Deployment", "ReplicaSet", "Pod"]) {
      if (!kindByName(kind)) continue;
      parts.push(list(kind, c.list(kind, ns)));
    }
    for (const p of c.list<Pod>("Pod", ns)) {
      for (const ct of p.spec?.containers ?? []) {
        const logs = c.logsFor(p, ct.name, false) ?? [];
        parts.push(`==== START logs for container ${ct.name} of pod ${ns}/${p.metadata.name} ====\n${logs.map((l) => l.text).join("\n")}\n==== END logs for container ${ct.name} of pod ${ns}/${p.metadata.name} ====`);
      }
    }
  }
  return parts.join("\n");
}

/** kubectl events: like get events, but newest last and with --for and --types. */
function cmdEvents(s: Session): Res | string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const allNs = bflag(a, "--all-namespaces");
  const ns = nsOf(ctx, a);
  const output = sflag(a, "--output");
  checkOutput(output, false);
  let evs = c.list<KubeEvent>("Event", allNs ? undefined : ns);
  const forS = sflag(a, "--for");
  if (forS) {
    const [t, n] = forS.includes("/") ? forS.split("/") : [forS, ""];
    const k = kindOf(t);
    if (!n) throw new CmdError(`error: --for must be in resource/name form`);
    evs = evs.filter((e) => e.involvedObject.kind === k.kind && e.involvedObject.name === n);
  }
  const types = aflag(a, "--types");
  for (const t of types) if (t !== "Normal" && t !== "Warning") throw new CmdError(`error: valid --types are Normal or Warning`);
  if (types.length) evs = evs.filter((e) => types.includes(e.type));
  evs = [...evs].sort((x, y) => x.lastTimestamp - y.lastTimestamp);
  const res = { chunks: [] as Chunk[], ok: true, ...(bflag(a, "--watch") ? { watch: s.line.replace(/\s(-w|--watch)\b/, "") } : {}) };
  if (!evs.length) return { ...res, chunks: [{ fd: 2, text: allNs ? "No events found." : `No events found in ${ns} namespace.` }] };
  if (output === "name") return evs.map((e) => `event/${e.metadata.name}`).join("\n");
  if (output) return printWhole(evs as unknown as AnyObject[], { output, allNs, listed: true });
  const rows = evs.map((e) => [...(allNs ? [e.metadata.namespace ?? ""] : []), (tableRows(c, "Event", [e as unknown as AnyObject], false)[1] ?? [])[0], e.type, e.reason, `${e.involvedObject.kind}/${e.involvedObject.name}`, e.message.replace(/\n/g, " ")]);
  const head = [...(allNs ? ["NAMESPACE"] : []), "LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"];
  return { ...res, chunks: [{ fd: 1, text: baseTable(bflag(a, "--no-headers") ? rows : [head, ...rows]) }] };
}

function cmdApiResources(s: Session): string {
  const { a } = s;
  let list = KIND_LIST;
  const namespaced = a.flags["--namespaced"];
  if (namespaced !== undefined) list = list.filter((k) => k.namespaced === namespaced);
  const group = sflag(a, "--api-group");
  if (group !== undefined) list = list.filter((k) => k.group === group);
  const output = sflag(a, "--output");
  if (output && output !== "name" && output !== "wide") throw new CmdError(`error: --output ${output} is not available`);
  if (sflag(a, "--sort-by") === "name") list = [...list].sort((x, y) => x.plural.localeCompare(y.plural));
  if (sflag(a, "--sort-by") === "kind") list = [...list].sort((x, y) => x.kind.localeCompare(y.kind));
  if (output === "name") return list.map((k) => (k.group ? `${k.plural}.${k.group}` : k.plural)).join("\n");
  const verbs = (k: KindInfo) => (k.kind === "Event" || k.kind === "ControllerRevision" ? "[create delete deletecollection get list patch update watch]" : "[create delete deletecollection get list patch update watch]");
  const rows = [["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND", ...(output === "wide" ? ["VERBS"] : [])], ...list.map((k) => [k.plural, k.shortNames.join(","), k.group ? `${k.group}/${k.version}` : k.version, String(k.namespaced), k.kind, ...(output === "wide" ? [verbs(k)] : [])])];
  return baseTable(bflag(a, "--no-headers") ? rows.slice(1) : rows);
}

// ---------------------------------------------------------------- misc

const REAL_VERBS = [...SIMULATED_VERBS, ...UNSIMULATED_VERBS];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function suggest(word: string): string | undefined {
  const best = REAL_VERBS.filter((v) => v !== "help" && v !== "options").map((v) => [v, distance(word, v)] as const).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? best[0] : undefined;
}

/** A clean, editable manifest for an object (what kubectl edit shows, minus status). */
export function manifestFor(o: AnyObject): string {
  const annotations = { ...(o.metadata.annotations ?? {}) };
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  for (const k of Object.keys(annotations)) if (k.startsWith("deployment.kubernetes.io/")) delete annotations[k];
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!["apiVersion", "kind", "metadata", "status"].includes(k)) body[k] = v;
  const clean: Record<string, unknown> = {
    apiVersion: o.apiVersion,
    kind: o.kind,
    metadata: { name: o.metadata.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}), ...(o.metadata.labels ? { labels: o.metadata.labels } : {}), ...(Object.keys(annotations).length ? { annotations } : {}) },
    ...body,
  };
  return toYaml(toApiShape(clean));
}

const HELP = `kubectl controls the simulated Kubernetes cluster.

Basic:          get, describe, create, run, expose, delete, apply -f FILE, edit, explain, patch, label, annotate
Files:          ls, cat FILE, echo, kubectl get … -o yaml > FILE (the Editor edits these files)
Deploy:         scale, autoscale, set image|env|resources, rollout status|history|undo|restart|pause|resume
Workloads:      Deployments, StatefulSets, DaemonSets, Jobs, CronJobs (kubectl create job|cronjob …)
Config:         create configmap|secret --from-literal=K=V, env and volume mounts, create serviceaccount
Troubleshoot:   logs [-f] [-p], get -w, events, exec POD -- CMD, top pods|nodes, wait --for=…
                run tmp --rm -it --image=busybox -- wget -qO- http://SERVICE
                Ctrl+C stops a streaming command
Networking:     Services, Ingress (curl http://localhost or a rule's host), NetworkPolicy
Access:         create role|rolebinding, auth can-i VERB RESOURCE --as=USER, auth whoami
Cluster:        cordon, uncordon, drain --ignore-daemonsets, taint nodes, label nodes
Namespaces:     create namespace NAME, -n NAME, config set-context --current --namespace=NAME
Output:         -o wide|yaml|json|name|jsonpath=…|custom-columns=…, --sort-by, --field-selector, -L
Shell:          curl, wget, echo, cat, ls, pwd, rm; pipes into grep, head, tail, wc, sort, uniq, awk, cut,
                tr, base64, xargs, tee; > FILE, >> FILE, << EOF (here-documents), 2>&1, &&, ||, ;
                alias, unalias, export, unset, env, printenv, source FILE (or . FILE), $VAR and \${VAR}
                nano, vi, vim FILE edit FILE in the YAML editor tab, with nano or vim keys
                Aliases and variables last for this terminal session only. Every command takes --help.

Examples:
  kubectl create deployment web --image=nginx --replicas=3
  kubectl create deployment web --image=nginx --dry-run=client -o yaml > web.yaml
  kubectl expose deployment web --port=80
  curl http://web
  kubectl get pods -o jsonpath='{.items[*].metadata.name}'`;

// ---------------------------------------------------------------- dispatch

/** Finds "rollout status", "create secret generic"… in the words after the verb. */
function resolvePath(verb: string, words: string[]): { path: string; words: string[]; unknownSub?: string } {
  let path = verb;
  let rest = [...words];
  for (;;) {
    const spec = specFor(path);
    if (!spec?.subcommands) return { path, words: rest };
    const union = [...spec.flags, ...spec.subcommands.flatMap((x) => specFor(`${path} ${x.name}`)?.flags ?? [])];
    const probe = parseArgs(rest, { flags: union, cmdPath: `kubectl ${path}`, lenient: true });
    if (!probe.pos.length) return { path, words: rest };
    const sub = resolveSub(spec, probe.pos[0]);
    if (!sub) return { path, words: rest, unknownSub: probe.pos[0] };
    rest = rest.filter((_, i) => i !== probe.posIdx[0]);
    path = `${path} ${sub}`;
  }
}

/** What kubectl does without the apiserver: `config` edits the kubeconfig, `options` and help are text, and `version --client` is the client's own. */
function runsOffline(path: string, a: Args): boolean {
  return path === "config" || path.startsWith("config ") || path === "options" || (path === "version" && bflag(a, "--client"));
}

function runKubectlWords(ctx: KubectlContext, words: string[], stdin: string | undefined, text: string): Res {
  const c = ctx.cluster;
  // Warnings left over from UI actions aren't this command's.
  c.drainWarnings();
  const { lead, rest } = splitLeadingGlobals(words);
  if (lead.some((w) => w === "-h" || w === "--help")) return out(HELP);
  const verb = rest[0];
  if (verb === undefined) {
    // `kubectl` alone (or with only global flags) prints help.
    try {
      parseArgs(lead, { flags: [], cmdPath: "kubectl" });
    } catch (e) {
      if (e instanceof FlagError) return err(`error: ${e.message}\nSee 'kubectl --help' for usage.`);
      throw e;
    }
    return out(HELP);
  }
  if (verb === "help") {
    const sub = rest.slice(1).filter((w) => !w.startsWith("-"));
    if (!sub.length) return out(HELP);
    const r = resolvePath(sub[0], sub.slice(1));
    return specFor(r.path) ? out(helpFor(r.path)) : err(`Unknown help topic [\`${sub.join(" ")}\`]`);
  }
  if (!specFor(verb)) {
    if (UNSIMULATED_VERBS.includes(verb)) return err(`kubectl ${verb} is a real command, but the simulator doesn't run it.\nType "help" for the commands it does run.`);
    const sug = suggest(verb);
    return err(sug ? `error: unknown command "${verb}" for "kubectl"\n\nDid you mean this?\n\t${sug}` : `error: unknown command "${verb}" for "kubectl"\nRun 'kubectl --help' for usage.`);
  }
  const resolved = resolvePath(verb, rest.slice(1));
  const path = resolved.path;
  if (UNSIMULATED_SUBS.has(path) || !specFor(path)) return err(`kubectl ${path} is a real command, but the simulator doesn't run it.\nType "kubectl ${path.split(" ")[0]} --help" for the subcommands it does run.`);
  const spec = specFor(path)!;
  const cmdWords = [...lead, ...resolved.words];
  let a: Args;
  try {
    a = parseArgs(cmdWords, { flags: spec.flags, cmdPath: `kubectl ${path}` });
  } catch (e) {
    if (e instanceof FlagError) return err(`error: ${e.message}\nSee 'kubectl ${path} --help' for usage.`);
    throw e;
  }
  if (a.flags["--help"] === true) return out(helpFor(path));
  // Command groups without a Run of their own print their help and exit 1 (DefaultSubCommandRun).
  if (spec.subcommands && !spec.runnable) {
    if (resolved.unknownSub) return err(`error: unknown command "${a.pos.join(" ")}"\nSee 'kubectl ${path} -h' for help and examples`);
    return err(helpFor(path));
  }
  if (path === "cluster-info" && resolved.unknownSub) return err(`error: unknown command "${a.pos.join(" ")}"\nSee 'kubectl cluster-info -h' for help and examples`);
  // The apiserver does not answer: whatever would reach it is refused, as on the node (ADR 0003, decision 5).
  const refusal = apiServerRefusal(c);
  if (refusal && !runsOffline(path, a)) return err(refusal);
  const warnings: string[] = [...a.deprecations];
  const asUser = sflag(a, "--as");
  const s: Session = { ctx, a, path, user: asUser ? userFor(asUser, aflag(a, "--as-group")) : undefined, line: text, stdin, warnings, dry: "none" };
  let res: Res;
  try {
    s.dry = a.flags["--dry-run"] !== undefined ? dryRunOf(a, c, warnings) : "none";
    res = toRes(dispatch(s, verb));
  } catch (e) {
    if (isUserError(e)) res = err(errText(e));
    else {
      // Never show a JavaScript exception to the Learner; keep it for whoever is debugging the simulator.
      console.error("kubesim: kubectl crashed on", JSON.stringify(text), e);
      res = err("error: the simulator hit an internal problem running this command (it's a bug in kubesim, not in your command)");
    }
  }
  // apiserver Warning: headers, from the real cluster or the --dry-run=server copy.
  const apiWarnings = [...c.drainWarnings(), ...(s.sandbox?.drainWarnings() ?? [])];
  const pre = [...warnings, ...apiWarnings.filter((w) => !warnings.some((x) => x.endsWith(w))).map((w) => (w.startsWith("Warning:") ? w : `Warning: ${w}`))];
  return { ...res, chunks: [...pre.map((t) => ({ fd: 2 as const, text: t })), ...res.chunks] };
}

const toRes = (x: Res | string): Res => (typeof x === "string" ? out(x) : x);

function dispatch(s: Session, verb: string): Res | string {
  const { ctx, a } = s;
  const ns = nsOf(ctx, a);
  switch (verb) {
    case "version":
      return cmdVersion(s);
    case "cluster-info":
      return cmdClusterInfo(s);
    case "get": {
      const r = cmdGet(s);
      const w = bflag(a, "--watch") || bflag(a, "--watch-only");
      return w ? { ...r, watch: s.line.replace(/\s(-w|--watch|--watch-only)(=true)?(?=\s|$)/, "") } : r;
    }
    case "describe":
      return cmdDescribe(s);
    case "run":
      return cmdRun(s);
    case "create":
      return cmdCreate(s);
    case "apply":
      return cmdApply(s);
    case "replace":
      return cmdReplace(s);
    case "edit": {
      const t = targets(a.pos, "edit")[0];
      if (!t?.names[0]) throw new CmdError("error: edit requires a resource name, e.g. kubectl edit deployment web");
      can(s, "get", t.k, ns, t.names[0]);
      const o = ctx.cluster.get(t.k.kind, t.k.namespaced ? ns : undefined, t.names[0]);
      const name = `${t.k.singular}-${t.names[0]}.yaml`;
      (ctx.files ??= {})[name] = manifestFor(o);
      const editor = ctx.shell?.vars.get("KUBE_EDITOR")?.value ?? ctx.shell?.vars.get("EDITOR")?.value;
      return { chunks: [{ fd: 1, text: editor ? `Opened ${name} in the YAML editor tab, not in ${editor} (the simulator has no real editor). Change it, then press Apply.` : `Opened ${name} in the YAML editor. Change it, then press Apply.` }], ok: true, openFile: name };
    }
    case "explain":
      if (!a.pos[0]) throw new CmdError("error: You must specify the type of resource to explain, e.g. kubectl explain pod.spec");
      try {
        return explain(a.pos[0], bflag(a, "--recursive"));
      } catch (e) {
        throw new CmdError((e as Error).message);
      }
    case "api-resources":
      return cmdApiResources(s);
    case "api-versions":
      return [...new Set(KIND_LIST.map((k) => (k.group ? `${k.group}/${k.version}` : k.version)))].sort().join("\n");
    case "delete":
      return cmdDelete(s);
    case "scale":
      return cmdScale(s);
    case "autoscale":
      return cmdAutoscale(s);
    case "set":
      return cmdSet(s);
    case "patch":
      return cmdPatch(s);
    case "rollout":
      return cmdRollout(s);
    case "expose":
      return cmdExpose(s);
    case "logs": {
      const r = cmdLogs(s);
      return bflag(a, "--follow") ? { ...r, watch: s.line.replace(/\s(-f|--follow)(=true)?(?=\s|$)/, "") } : r;
    }
    case "label":
      return cmdMeta(s, "labels");
    case "annotate":
      return cmdMeta(s, "annotations");
    case "taint":
      return cmdTaint(s);
    case "cordon":
    case "uncordon":
      return cmdCordon(s, verb === "cordon");
    case "drain":
      return cmdDrain(s);
    case "exec":
      return cmdExec(s);
    case "top":
      return cmdTop(s);
    case "auth":
      return cmdAuth(s);
    case "wait":
      return cmdWait(s);
    case "config":
      return cmdConfig(s);
    case "events":
      return cmdEvents(s);
    case "options":
      return optionsHelp();
  }
  throw new CmdError(`error: unknown command "${verb}" for "kubectl"`);
}

/** Everything the terminal runs that isn't a shell builtin: kubectl (and k), curl, wget, help, sleep, watch. */
function execFor(ctx: KubectlContext) {
  return (words: string[], stdin: string | undefined, text: string): Res | undefined => {
    // ssh, and on a node host systemctl, journalctl, crictl and hostname (ADR 0003).
    const onHost = hostCommand(ctx, words);
    if (onHost) return onHost;
    switch (words[0]) {
      case "kubectl":
      case "k":
        return kubectlOnNode(ctx, words.slice(1)) ?? runKubectlWords(ctx, words.slice(1), stdin, text.replace(/^k(?=\s|$)/, "kubectl"));
      case "help":
        return out(HELP);
      case "curl":
        return curl(ctx, words.slice(1));
      case "wget":
        return wget(ctx, words.slice(1));
      case "sleep":
        return out("(No need to sleep: the Simulated Cluster keeps running. Use the speed control or kubectl get -w to watch.)");
      case "clear":
        return out("");
      case "watch": {
        // watch [-n SECS] CMD…: re-run the command; the terminal refreshes it until Ctrl+C.
        let i = 1;
        while (i < words.length && words[i].startsWith("-")) i += words[i] === "-n" || words[i] === "--interval" ? 2 : 1;
        const inner = words.slice(i);
        if (!inner.length) return err("Usage:\n watch [options] command");
        const innerText = text.replace(/^watch(\s+(-n\s*\S+|--interval[=\s]\S+|-\S+))*\s+/, "");
        const r = execFor(ctx)(inner, stdin, innerText) ?? err(`sh: 1: ${inner[0]}: not found`);
        return { ...r, watch: innerText };
      }
    }
    return undefined;
  };
}

export function runKubectl(ctx: KubectlContext, line: string): CommandResult {
  const files = (ctx.files ??= {});
  ctx.shell ??= newShell();
  let r: Res;
  try {
    // On a node host the file commands reach the Node's files as well (absolute paths outside the home directory).
    const sess = currentSession(ctx.shell);
    const view = sess ? hostEnv(ctx.cluster, sess, files) : undefined;
    r = runScript({ files: view?.files ?? files, host: view?.host, exec: execFor(ctx), shell: ctx.shell }, line.trim());
  } catch (e) {
    console.error("kubesim: the terminal crashed on", JSON.stringify(line), e);
    r = err("error: the simulator hit an internal problem running this command (it's a bug in kubesim, not in your command)");
  }
  const text = r.chunks
    .map((ch) => ch.text)
    .filter((t) => t !== "")
    .join("\n");
  return { out: text, ok: r.ok, ...(r.watch ? { watch: r.watch } : {}), ...(r.openFile ? { openFile: r.openFile } : {}), ...(r.editor ? { editor: r.editor } : {}) };
}

/** Applies a YAML document stream (the Editor's Apply button). */
export function applyYaml(ctx: KubectlContext, text: string, user?: UserInfo, dryRun?: string, source = "manifest.yaml"): CommandResult {
  const refusal = apiServerRefusal(ctx.cluster);
  if (refusal) return { out: refusal, ok: false };
  const a: Args = { pos: [], flags: {}, rest: [], dashAt: -1, posIdx: [], deprecations: [] };
  const s: Session = { ctx, a, path: "apply", user, line: "kubectl apply", warnings: [], dry: dryRun === "client" || dryRun === "server" ? dryRun : dryRun && dryRun !== "none" && dryRun !== "false" ? "client" : "none" };
  ctx.cluster.drainWarnings();
  let res: Res;
  try {
    const objs = parseManifest(text, source);
    for (const o of objs) {
      const e = missingTypeError(o, source);
      if (e) throw new ManifestError(e);
    }
    if (!objs.length) throw new CmdError("error: no objects passed to apply");
    res = applyObjects(s, [{ objs, source }]);
  } catch (e) {
    if (!isUserError(e)) {
      console.error("kubesim: apply crashed", e);
      res = err("error: the simulator hit an internal problem applying this YAML (it's a bug in kubesim, not in your manifest)");
    } else res = err(errText(e));
  }
  const apiWarnings = [...ctx.cluster.drainWarnings(), ...(s.sandbox?.drainWarnings() ?? [])];
  const chunks = [...[...s.warnings, ...apiWarnings.map((w) => (w.startsWith("Warning:") ? w : `Warning: ${w}`))].map((t) => ({ fd: 2 as const, text: t })), ...res.chunks];
  return { out: chunks.map((c) => c.text).filter(Boolean).join("\n"), ok: res.ok };
}

/** Completions for the terminal's Tab key. */
export function complete(ctx: KubectlContext, line: string): string[] {
  return completeLine(ctx, line);
}

export { GLOBAL_FLAGS };

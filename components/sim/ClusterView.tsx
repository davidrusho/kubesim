"use client";

// 2D Cluster View built for learning. It shows the whole ownership chain:
//   Deployment → ReplicaSet → Pods, StatefulSet / DaemonSet → Pods,
//   CronJob → Job → Pods (Pods placed on their Node) ← Service ← Ingress
// with the scheduler queue on the left, config, storage, policies and access
// in a column on the right, and traffic flowing along the edges.

import { useEffect, useRef, useState } from "react";
import { CalendarClock, Database, FileText, Globe, HardDrive, Hexagon, KeyRound, Layers, Network, Play, Server, ShieldCheck, UserCheck, type LucideIcon } from "lucide-react";
import { fit, onFontsReady, textWidth } from "./textFit";
import { isIsolated, objKey, podRequests, nodeAllocatable, type Cluster, type ConfigMap, type CronJob, type DaemonSet, type Deployment, type Endpoints, type HorizontalPodAutoscaler, type Ingress, type Job, type NetworkPolicy, type Node, type PersistentVolume, type PersistentVolumeClaim, type Pod, type ReplicaSet, type RoleBinding, type Secret, type Service, type StatefulSet } from "@/lib/engine";
import { fnv32a } from "@/lib/engine/util";
import { SYSTEM_NAMESPACES } from "@/lib/engine/bootstrap";
import { PACKET_MS, type Packet } from "@/lib/sim/useSimulation";
import { isRollingOut, podCategory, podStatus, restarts, type PodCategory } from "@/lib/sim/status";
import { PanZoom, type Bounds, type FullShape, type Inset } from "./PanZoom";
import { useDrag, type MoveCallback } from "./DragLayer";
import type { DragItem } from "@/lib/sim/drag";
import type { ObjectKind } from "@/lib/sim/objects";
import type { ControlPlaneStatus } from "@/lib/sim/controlplane";

export type SelKind = ObjectKind;
export type Selection = { kind: SelKind; ns?: string; name: string } | null;

const NODE_W = 338;
const NODE_GAP = 36;
const HEAD = 64;
const PAD = 14;
const CHIP_W = 150;
const CHIP_H = 50;
const CHIP_GAP = 10;
const COLS = 2;
const DEP_H = 58;
const RS_H = 50;
const RS_W = 176;
const Y_DEP = 0;
const Y_RS = 96;
const Y_NODES = 212;
/** Where the Nodes start when no ReplicaSet or Job row sits between them and the workloads. */
const Y_NODES_FOLDED = 124;
/** Gap above the Services row and above the Ingress row. */
const ROW_GAP = 72;
const SVC_W = 240;
const SVC_H = 64;
const ING_W = 250;
const ING_H = 64;
const QUEUE_W = 174;
/** The control plane collapses to this when its system Pods are hidden and nothing else runs there. */
const CP_W = 300;
const CP_BODY = 44;
/** The kubelet row under every Node, when the screen passes `health`. */
const KUBELET_ROW = 24;
const SIDE_W = 200;
const SIDE_H = 44;

/** Corner radius shared by every card (Pods use a little less). */
const R = 12;
const ARROW = 6;

const HUES = [221, 162, 262, 24, 330, 190, 142, 45];
export const hueFor = (name: string) => HUES[fnv32a(name) % HUES.length];
const ownerOf = (o: { metadata: { ownerReferences?: { controller?: boolean; kind: string; name: string; uid: string }[] } }) => o.metadata.ownerReferences?.find((r) => r.controller);

/** Live request rates tick over on this beat of simulated time, like a meter, rather than flickering every frame. */
const RATE_BEAT = 500;
/** Request history kept for a rate and its sparkline: one bucket per second, newest last. */
const BUCKETS = 24;
const RATE_SECONDS = 3;

/** Counts timestamps into one bucket per second up to `t`, oldest first. */
function bucket(times: number[], t: number, out = new Array<number>(BUCKETS).fill(0)): number[] {
  for (const at of times) {
    const i = BUCKETS - 1 - Math.floor((t - at) / 1000);
    if (at <= t && i >= 0) out[i]++;
  }
  return out;
}
/** Requests a Pod served (or answered with a 5xx: `errs`) in each second up to `t`, from its containers' logs. */
function servedSeries(c: Cluster, uid: string, t: number, key: "reqs" | "errs" = "reqs"): number[] {
  const out = new Array<number>(BUCKETS).fill(0);
  for (const crt of Object.values(c.state.pods[uid]?.containers ?? {})) {
    bucket(crt[key] ?? [], t, out);
    // The traffic control's flow, counted per sample rather than per request.
    const f = crt.flow;
    if (f) for (let j = 0; j < f.t.length; j++) addAt(out, f.t[j], t, key === "reqs" ? f.ok[j] + f.err[j] : f.err[j]);
  }
  return out;
}

/** Adds `n` requests at time `at` into the per-second buckets ending at `t`. */
function addAt(out: number[], at: number, t: number, n: number) {
  const i = BUCKETS - 1 - Math.floor((t - at) / 1000);
  if (at <= t && i >= 0) out[i] += n;
}
/** Requests per second over the last few seconds of a series. */
const rateOf = (series: number[]) => series.slice(-RATE_SECONDS).reduce((a, b) => a + b, 0) / RATE_SECONDS;
const fmtRate = (r: number) => `${r < 10 ? r.toFixed(1) : Math.round(r)}/s`;
/** Requests per second, and the share of them failing once it's worth mentioning. */
const fmtTraffic = (r: number, err: number) => (err >= 0.01 ? `${fmtRate(r)} · ${Math.round(err * 100)}% err` : fmtRate(r));
const ERR = "var(--cv-danger)";
/** Text colour for a status, by tone. */
const TONE_TEXT: Record<"ok" | "warn" | "bad" | "muted", string> = { ok: "var(--cv-text)", warn: "var(--cv-warn-text)", bad: "var(--cv-danger-text)", muted: "var(--cv-faint)" };

const CAT: Record<PodCategory, { dot: string; text: string; label?: string }> = {
  ok: { dot: "var(--cv-ok)", text: "var(--cv-ok-text)" },
  starting: { dot: "var(--cv-warn)", text: "var(--cv-warn-text)" },
  bad: { dot: "var(--cv-danger)", text: "var(--cv-danger-text)" },
  done: { dot: "var(--cv-faint)", text: "var(--cv-dim)" },
  gone: { dot: "var(--cv-muted)", text: "var(--cv-faint)" },
  stale: { dot: "var(--cv-muted)", text: "var(--cv-faint)", label: "Unknown" },
};

type Pt = { x: number; y: number };

const curve = (a: Pt, b: Pt) => {
  const dy = Math.max(40, Math.abs(b.y - a.y) * 0.45);
  const s = Math.sign(b.y - a.y) || 1;
  return { d: `M${a.x},${a.y} C${a.x},${a.y + dy * s} ${b.x},${b.y - dy * s} ${b.x},${b.y}`, c1: { x: a.x, y: a.y + dy * s }, c2: { x: b.x, y: b.y - dy * s } };
};
/** Right-angle route with rounded corners, turning at `turnY`. */
const ortho = (a: Pt, b: Pt, turnY: number, r = 10) => {
  if (Math.abs(a.x - b.x) < 1) return `M${a.x},${a.y} V${b.y}`;
  const s = Math.sign(b.x - a.x);
  const rr = Math.max(0, Math.min(r, Math.abs(b.x - a.x) / 2, turnY - a.y, b.y - turnY));
  return `M${a.x},${a.y} V${turnY - rr} Q${a.x},${turnY} ${a.x + s * rr},${turnY} H${b.x - s * rr} Q${b.x},${turnY} ${b.x},${turnY + rr} V${b.y}`;
};
/**
 * One reconcile loop on the ownership wires, as fractions of RELAY_S: the owner's spec is handed
 * down hop by hop, then status comes back up the same way. Every workload runs its own loop.
 */
const RELAY_S = 4.2;
const HOP = {
  toChild: [0, 0.2], // Deployment → ReplicaSet, CronJob → Job
  toPod: [0.2, 0.46], // ReplicaSet → Pod
  direct: [0.06, 0.4], // StatefulSet / DaemonSet → Pod
  fromPod: [0.56, 0.8],
  fromChild: [0.8, 0.98],
} as const;
/** Comet layers, tail first: [length px, width, opacity]. Stacked, they read as a head with a fading tail. */
const TRAIL = [
  [46, 2, 0.12],
  [24, 2.2, 0.3],
  [7, 2.8, 1],
] as const;
const relayBegin = (rootUid: string) => `${(-((fnv32a(rootUid) % 1000) / 1000) * RELAY_S).toFixed(2)}s`;
/** Length of an `ortho` route, near enough for timing a comet along it. */
const orthoLen = (a: Pt, b: Pt, turnY: number) => Math.abs(turnY - a.y) + Math.abs(b.x - a.x) + Math.abs(b.y - turnY);

/**
 * A comet running along a wire during one hop of the relay; `up` runs it from the end back to the start.
 * It covers `span` px in the hop (at least the wire's length), so wires sharing a span move in step.
 */
function Comet({ d, span, hop, root, color, up }: { d: string; span: number; hop: keyof typeof HOP; root: string; color: string; up?: boolean }) {
  const [a, b] = HOP[hop];
  const begin = relayBegin(root);
  const dur = `${RELAY_S}s`;
  return (
    <g className="cv-signal">
      {TRAIL.map(([l, w, o]) => {
        // Dash offsets that park the dash off each end: before the start, and `span` along (past the end).
        const [from, to] = up ? [-span, l] : [l, -span];
        return (
          <path key={l} d={d} fill="none" stroke={color} strokeOpacity={o} strokeWidth={w} strokeLinecap="round" strokeDasharray={`${l} ${span + l * 2}`} strokeDashoffset={from}>
            <animate attributeName="stroke-dashoffset" values={`${from};${from};${to};${to}`} keyTimes={`0;${a};${b};1`} calcMode="spline" keySplines="0 0 1 1;0.5 0 0.3 1;0 0 1 1" dur={dur} begin={begin} repeatCount="indefinite" />
          </path>
        );
      })}
    </g>
  );
}
const arrowDown = (tip: Pt) => `M${tip.x},${tip.y} l${-ARROW * 0.6},${-ARROW} h${ARROW * 1.2} z`;
const hcurve = (a: Pt, b: Pt) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45);
  const s = Math.sign(b.x - a.x) || 1;
  return `M${a.x},${a.y} C${a.x + dx * s},${a.y} ${b.x - dx * s},${b.y} ${b.x},${b.y}`;
};
const onCubic = (a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
};
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

interface Props {
  cluster: Cluster;
  packets: Packet[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  showSystem: boolean;
  slots: Map<string, Map<string, number>>;
  now: number;
  namespace?: string;
  inset?: Inset;
  /** Nodes per row (phones stack them so each stays readable). Default 4. */
  perRow?: number;
  /** Bumped by the screen (e.g. a splitter released) to re-fit the diagram even if it was moved. */
  refit?: number;
  /** See PanZoom: off when the canvas sits inside a scrolling page. */
  captureWheel?: boolean;
  /** A tall canvas: wrap the workloads into rows no wider than the Nodes and put config and storage underneath, so the diagram grows down instead of across. */
  wrap?: boolean;
  /** Each control-plane component's and each kubelet's health. Left out, the control plane draws as four quiet chips and the Nodes have no kubelet row. */
  health?: ControlPlaneStatus;
  /** Set replicas from the canvas (a stepper on Deployment and StatefulSet cards). Left out, the cards have none. */
  onScale?: (kind: "deployment" | "statefulset", ns: string, name: string, replicas: number) => void;
}

type TopKind = "deployment" | "statefulset" | "daemonset" | "cronjob" | "job";
interface TopCard {
  kind: TopKind;
  obj: Deployment | StatefulSet | DaemonSet | CronJob | Job;
  x: number;
  y: number;
  w: number;
  children: { kind: "replicaset" | "job"; obj: ReplicaSet | Job; x: number; y: number }[];
}

/** Everything a Pod refers to: ConfigMaps, Secrets and PVCs (by name, in its namespace). */
function podRefs(p: Pod): { configmap: Set<string>; secret: Set<string>; pvc: Set<string> } {
  const out = { configmap: new Set<string>(), secret: new Set<string>(), pvc: new Set<string>() };
  for (const v of p.spec?.volumes ?? []) {
    if (v.configMap && v.configMap.name !== "kube-root-ca.crt") out.configmap.add(v.configMap.name);
    if (v.secret) out.secret.add(v.secret.secretName);
    if (v.persistentVolumeClaim) out.pvc.add(v.persistentVolumeClaim.claimName);
  }
  for (const c of p.spec?.containers ?? []) {
    for (const e of c.env ?? []) {
      if (e.valueFrom?.configMapKeyRef) out.configmap.add(e.valueFrom.configMapKeyRef.name);
      if (e.valueFrom?.secretKeyRef) out.secret.add(e.valueFrom.secretKeyRef.name);
    }
    for (const e of c.envFrom ?? []) {
      if (e.configMapRef) out.configmap.add(e.configMapRef.name);
      if (e.secretRef) out.secret.add(e.secretRef.name);
    }
  }
  return out;
}

export function ClusterView({ cluster: c, packets, selection, onSelect, showSystem, slots, now, namespace, inset, perRow: perRowProp = 4, refit = 0, captureWheel, wrap: wrapProp = false, health, onScale }: Props) {
  // Enlarged to full screen, the diagram lays itself out for the screen it now has: one Node per row on a
  // phone held upright, wrapped rows on a tall screen.
  const [fullShape, setFullShape] = useState<FullShape>(null);
  const perRow = fullShape === "narrow" ? 1 : fullShape ? Math.max(perRowProp, 2) : perRowProp;
  const wrap = fullShape === "tall" || (fullShape !== "narrow" && wrapProp);
  const [k, setK] = useState(1);
  const drag = useDrag();
  // ---- moving cards: like any canvas, a card goes where it's dropped and its wires follow. Kept in the
  // cluster's state (c.state.layout), so it survives a reload and travels with a share link; Pods move with their Node.
  const [moving, setMoving] = useState<{ key: string; dx: number; dy: number } | null>(null);
  /** Bumped by Tidy up, so the view re-fits the automatic layout. */
  const [tidied, setTidied] = useState(0);
  const movedAt = useRef(0);
  const layout = c.state.layout;
  const custom = !!layout && Object.keys(layout).length > 0;
  /** A finger moves cards only where it doesn't scroll the page (the Sandbox, or any canvas in full screen). */
  const touchMoves = captureWheel !== false || fullShape !== null;
  const baseOf = new Map<string, Pt>();
  /** Where a card goes: where the Learner put it, else the automatic layout, plus any drag in progress. */
  const place = (key: string, x: number, y: number): Pt => {
    const p = layout?.[key];
    const base = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : { x, y };
    baseOf.set(key, base);
    return moving?.key === key ? { x: base.x + moving.dx, y: base.y + moving.dy } : base;
  };
  const keep = (key: string, to: Pt) => {
    c.state.layout = { ...(c.state.layout ?? {}), [key]: { x: Math.round(to.x), y: Math.round(to.y) } };
    c.state.layoutRev = (c.state.layoutRev ?? 0) + 1;
    c.markChanged();
  };
  const tidy = () => {
    delete c.state.layout;
    c.state.layoutRev = (c.state.layoutRev ?? 0) + 1;
    c.markChanged();
    setTidied((n) => n + 1);
  };
  /** Pointer handlers that let a card be dragged to a new spot. With `item`, a drop on something it acts on (a Deployment, the trash) does that instead. */
  const mover = (key: string, item?: DragItem) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (e.pointerType !== "mouse" && !touchMoves) return;
      e.stopPropagation(); // don't pan the canvas
      const from = baseOf.get(key);
      if (!from) return;
      const scale = k;
      const onMove: MoveCallback = (dx, dy, phase) => {
        if (phase === "move") return setMoving({ key, dx: dx / scale, dy: dy / scale });
        setMoving(null);
        movedAt.current = performance.now();
        if (phase === "commit" && (dx || dy)) keep(key, { x: from.x + dx / scale, y: from.y + dy / scale });
      };
      if (drag && item) return drag.begin(item, e, onMove);
      const sx = e.clientX;
      const sy = e.clientY;
      let active = false;
      const off = () => {
        window.removeEventListener("pointermove", mv);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      const mv = (ev: PointerEvent) => {
        if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        active = true;
        onMove(ev.clientX - sx, ev.clientY - sy, "move");
      };
      const up = (ev: PointerEvent) => {
        off();
        if (active) onMove(ev.clientX - sx, ev.clientY - sy, "commit");
      };
      const cancel = () => {
        off();
        if (active) onMove(0, 0, "cancel");
      };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
  });
  /** Drag + drop wiring for an object: its drop key, optional drag source, and highlight. */
  const dnd = (key: string, item?: DragItem) => ({
    "data-drop": key,
    ...(drag && item ? { onPointerDown: (e: React.PointerEvent) => drag.begin(item, e) } : {}),
  });
  const hl = (key: string) => drag?.over === key;
  const dragged = (type: string, ns: string | undefined, name: string) => drag?.dragging?.kind === "object" && drag.dragging.type === type && drag.dragging.name === name && drag.dragging.ns === (ns ?? "default");
  // Labels are measured with the real font; re-render once web fonts arrive.
  const [, setFontTick] = useState(0);
  useEffect(() => onFontsReady(() => setFontTick((t) => t + 1)), []);
  const allNs = !namespace || namespace === "*";
  const nsOk = (ns?: string) => (allNs ? showSystem || !SYSTEM_NAMESPACES.has(ns ?? "") : ns === namespace);
  const nsPrefix = (ns?: string) => (allNs && ns && ns !== "default" ? `${ns}/` : "");
  /** Keyboard + screen-reader props for a selectable object. */
  const act = (sel: Selection, label: string) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    "aria-pressed": isSelObj(sel),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(sel);
      }
      // Delete (Backspace on a Mac keyboard) deletes it, the same as dropping it on the trash.
      if ((e.key === "Delete" || e.key === "Backspace") && sel && drag) {
        e.preventDefault();
        drag.remove(item(sel.kind, sel.ns, sel.name, label.split(",")[0]));
      }
    },
  });
  /** The drag item for an object on the canvas: dropped on the trash, it's deleted. */
  const item = (kind: ObjectKind, ns: string | undefined, name: string, label: string): DragItem => ({ kind: "object", type: kind, ns: ns ?? "default", name, label });
  const isSelObj = (s: Selection) => !!s && !!selection && s.kind === selection.kind && s.name === selection.name && (s.ns ?? "default") === (selection.ns ?? "default");
  const nodes = c.list<Node>("Node");
  const cp = nodes.find((n) => n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined);
  const ordered = cp ? [cp, ...nodes.filter((n) => n !== cp)] : nodes;
  const pods = c.list<Pod>("Pod").filter((p) => nsOk(p.metadata.namespace));
  const services = c.list<Service>("Service").filter((s) => nsOk(s.metadata.namespace) && s.metadata.name !== "kubernetes");
  const deps = c.list<Deployment>("Deployment").filter((d) => nsOk(d.metadata.namespace));
  const stss = c.list<StatefulSet>("StatefulSet").filter((d) => nsOk(d.metadata.namespace));
  const dss = c.list<DaemonSet>("DaemonSet").filter((d) => nsOk(d.metadata.namespace));
  const cjs = c.list<CronJob>("CronJob").filter((d) => nsOk(d.metadata.namespace));
  const jobs = c.list<Job>("Job").filter((d) => nsOk(d.metadata.namespace));
  const rsAll = c.list<ReplicaSet>("ReplicaSet").filter((r) => nsOk(r.metadata.namespace));
  const hpas = c.list<HorizontalPodAutoscaler>("HorizontalPodAutoscaler").filter((h) => nsOk(h.metadata.namespace));
  const ingresses = c.list<Ingress>("Ingress").filter((i) => nsOk(i.metadata.namespace));
  const cms = c.list<ConfigMap>("ConfigMap").filter((m) => nsOk(m.metadata.namespace) && m.metadata.name !== "kube-root-ca.crt" && !SYSTEM_NAMESPACES.has(m.metadata.namespace ?? ""));
  const secrets = c.list<Secret>("Secret").filter((m) => nsOk(m.metadata.namespace) && !SYSTEM_NAMESPACES.has(m.metadata.namespace ?? ""));
  const pvcs = c.list<PersistentVolumeClaim>("PersistentVolumeClaim").filter((m) => nsOk(m.metadata.namespace));
  const netpols = c.list<NetworkPolicy>("NetworkPolicy").filter((m) => nsOk(m.metadata.namespace));
  const bindings = c.list<RoleBinding>("RoleBinding").filter((m) => nsOk(m.metadata.namespace) && !SYSTEM_NAMESPACES.has(m.metadata.namespace ?? ""));

  // ---- workloads: controllers, and the ReplicaSets / Jobs under them
  const groups: Omit<TopCard, "x" | "y" | "w">[] = [
    ...deps.map((d) => ({
      kind: "deployment" as const,
      obj: d,
      children: rsAll
        .filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid))
        .filter((r) => (r.spec?.replicas ?? 0) > 0 || (r.status?.replicas ?? 0) > 0 || r.metadata.annotations?.["deployment.kubernetes.io/revision"] === d.metadata.annotations?.["deployment.kubernetes.io/revision"])
        .sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp)
        .map((r) => ({ kind: "replicaset" as const, obj: r, x: 0, y: Y_RS })),
    })),
    ...stss.map((s) => ({ kind: "statefulset" as const, obj: s, children: [] })),
    ...dss.map((s) => ({ kind: "daemonset" as const, obj: s, children: [] })),
    ...cjs.map((cj) => ({
      kind: "cronjob" as const,
      obj: cj,
      children: jobs
        .filter((j) => ownerOf(j)?.uid === cj.metadata.uid)
        .sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp)
        .slice(-3)
        .map((j) => ({ kind: "job" as const, obj: j, x: 0, y: Y_RS })),
    })),
    ...jobs.filter((j) => !ownerOf(j)).map((j) => ({ kind: "job" as const, obj: j, children: [] })),
  ];
  // A busy cluster (four or more workloads) folds a Deployment's only ReplicaSet into the Deployment's card: that row
  // costs height on every screen and says nothing new until a rollout puts two ReplicaSets side by side.
  const folded = new Map<string, string>();
  if (groups.length >= 4)
    for (const g of groups)
      if (g.kind === "deployment" && g.children.length === 1) {
        folded.set(g.children[0].obj.metadata.uid, g.obj.metadata.uid);
        g.children = [];
      }
  const bareRs = rsAll.filter((r) => !r.metadata.ownerReferences?.length);

  // ---- node + pod layout
  const podPos = new Map<string, Pt & { pod: Pod }>();
  const nodeBoxes: { node: Node; x: number; y: number; h: number; w: number; collapsed: boolean }[] = [];
  const nodePods = new Map<string, Pod[]>();
  /** Slot assignments for this frame. Computed from the previous ones without touching them; committed after render. */
  const nextSlots = new Map<string, Map<string, number>>();
  const pending: Pod[] = [];
  for (const p of pods) {
    const n = p.spec?.nodeName;
    if (n && nodes.some((x) => x.metadata.name === n)) (nodePods.get(n) ?? nodePods.set(n, []).get(n)!).push(p);
    else pending.push(p);
  }
  // A narrow canvas (phones: one Node per row) wraps the workloads, Services and Ingresses into rows this wide;
  // a tall one (`wrap`) wraps them at the width of the Nodes.
  const narrow = perRow === 1;
  let nodesWide = 0;
  for (let r = 0; r < ordered.length; r += perRow) {
    const row = ordered.slice(r, r + perRow);
    nodesWide = Math.max(nodesWide, row.reduce((a, n) => a + (n === cp && !showSystem && !nodePods.get(n.metadata.name)?.length ? CP_W : NODE_W) + NODE_GAP, -NODE_GAP));
  }
  const stacked = narrow || wrap;
  const WRAP = narrow ? 560 : wrap ? Math.max(nodesWide, 560) : Infinity;
  const widths = groups.map((g) => Math.max(g.kind === "deployment" || g.kind === "cronjob" ? (folded.size ? 240 : 280) : 250, g.children.length * (RS_W + 12) - 12));
  const bandRows: number[][] = [];
  groups.forEach((_, i) => {
    const row = bandRows[bandRows.length - 1];
    const used = row ? row.reduce((a, j) => a + widths[j] + 28, 0) : 0;
    if (row && used + widths[i] <= WRAP) row.push(i);
    else bandRows.push([i]);
  });
  const bandY: number[] = [];
  let bandBottom = Y_DEP;
  bandRows.forEach((row, r) => {
    const kids = row.some((i) => groups[i].children.length) || (r === bandRows.length - 1 && bareRs.length > 0);
    bandY.push(r ? bandBottom + 28 : Y_DEP);
    bandBottom = bandY[r] + (kids ? Y_RS + RS_H : DEP_H);
  });
  if (!bandRows.length && bareRs.length) bandBottom = Y_RS + RS_H;
  const yNodes = groups.length || bareRs.length ? Math.max(Y_NODES_FOLDED, bandBottom + 66) : Y_NODES;
  let rowY = yNodes;
  let nodesW = 0;
  for (let r = 0; r < Math.ceil(ordered.length / perRow); r++) {
    const row = ordered.slice(r * perRow, r * perRow + perRow);
    let rowH = 0;
    let rowX = 0;
    const boxes = row.map((node) => {
      const name = node.metadata.name;
      const list = nodePods.get(name) ?? [];
      const collapsed = node === cp && !showSystem && list.length === 0;
      if (collapsed) {
        nextSlots.set(name, new Map());
        const h = HEAD + CP_BODY + (health ? KUBELET_ROW : 0);
        rowH = Math.max(rowH, h);
        const x = rowX;
        rowX += CP_W + NODE_GAP;
        return { node, x, y: rowY, h, w: CP_W, collapsed };
      }
      const m = new Map(slots.get(name) ?? []);
      nextSlots.set(name, m);
      const alive = new Set(list.map((p) => p.metadata.uid));
      for (const uid of [...m.keys()]) if (!alive.has(uid)) m.delete(uid);
      for (const p of list) {
        if (m.has(p.metadata.uid)) continue;
        const used = new Set(m.values());
        let s = 0;
        while (used.has(s)) s++;
        m.set(p.metadata.uid, s);
      }
      const maxSlot = Math.max(-1, ...m.values());
      const rows = Math.max(1, Math.ceil((maxSlot + 1) / COLS));
      const h = HEAD + PAD + rows * (CHIP_H + CHIP_GAP) - CHIP_GAP + PAD + (health ? KUBELET_ROW : 0);
      rowH = Math.max(rowH, h);
      const x = rowX;
      rowX += NODE_W + NODE_GAP;
      for (const p of list) {
        const s = m.get(p.metadata.uid)!;
        podPos.set(p.metadata.uid, { x: x + PAD + (s % COLS) * (CHIP_W + CHIP_GAP), y: rowY + HEAD + PAD + Math.floor(s / COLS) * (CHIP_H + CHIP_GAP), pod: p });
      }
      return { node, x, y: rowY, h, w: NODE_W, collapsed: false };
    });
    nodeBoxes.push(...boxes);
    nodesW = Math.max(nodesW, rowX - NODE_GAP);
    rowY += rowH + NODE_GAP;
  }
  const nodesBottom = rowY - NODE_GAP;
  useEffect(() => {
    for (const [name, m] of nextSlots) slots.set(name, m);
  });
  const qx = -QUEUE_W - NODE_GAP;
  pending.forEach((p, i) => podPos.set(p.metadata.uid, { x: qx + (QUEUE_W - CHIP_W) / 2, y: yNodes + 52 + i * (CHIP_H + CHIP_GAP), pod: p }));
  const queueH = Math.max(160, 52 + pending.length * (CHIP_H + CHIP_GAP) + 8);

  // ---- workloads band: controllers on top, their ReplicaSets / Jobs below, centred over the Nodes
  const topCards: TopCard[] = [];
  const childBox = new Map<string, { x: number; y: number; kind: "replicaset" | "job"; obj: ReplicaSet | Job }>();
  const cardByUid = new Map<string, TopCard>();
  {
    let x = 0;
    let y = Y_DEP;
    bandRows.forEach((row, r) => {
      const total = row.reduce((a, i) => a + widths[i], 0) + (row.length - 1) * 28;
      x = narrow ? 0 : Math.max(0, (nodesW - total) / 2);
      y = bandY[r];
      for (const i of row) {
        const g = groups[i];
        const w = widths[i];
        const start = x + (w - (g.children.length * (RS_W + 12) - 12)) / 2;
        const card: TopCard = { ...g, x, y, w, children: g.children.map((ch, j) => ({ ...ch, x: start + j * (RS_W + 12), y: y + Y_RS })) };
        for (const ch of card.children) childBox.set(ch.obj.metadata.uid, ch);
        cardByUid.set(g.obj.metadata.uid, card);
        topCards.push(card);
        x += w + 28;
      }
    });
    // Bare ReplicaSets get their own boxes, after the last workload.
    bareRs.forEach((rs, j) => childBox.set(rs.metadata.uid, { kind: "replicaset", obj: rs, x: x + j * (RS_W + 12), y: y + Y_RS }));
  }

  // ---- services, then ingresses under them
  const svcY = nodesBottom + ROW_GAP;
  /** Lays a row of equal boxes out under the Nodes, centred over them, wrapping on a narrow canvas. */
  const rowOf = <T,>(items: T[], w: number, h: number, y0: number) => {
    const per = Math.max(1, Math.min(items.length, Math.floor((Math.min(WRAP, 1e5) + 24) / (w + 24))));
    const total = per * (w + 24) - 24;
    const x0 = narrow ? 0 : Math.max(0, (nodesW - total) / 2);
    return items.map((it, i) => ({ it, x: x0 + (i % per) * (w + 24), y: y0 + Math.floor(i / per) * (h + 24) }));
  };
  const svcBoxes = rowOf(services, SVC_W, SVC_H, svcY).map(({ it, x, y }) => ({ s: it, x, y }));
  const svcBox = new Map(svcBoxes.map((b) => [`${b.s.metadata.namespace}/${b.s.metadata.name}`, b]));
  const ingY = (services.length ? Math.max(...svcBoxes.map((b) => b.y)) + SVC_H : nodesBottom) + ROW_GAP;
  const ingBoxes = rowOf(ingresses, ING_W, ING_H, ingY).map(({ it, x, y }) => ({ ing: it, x, y }));

  // ---- config, storage, policy and access column
  // It starts level with the Nodes, below the workloads band, so it only has to clear the Nodes, Services and Ingresses.
  // A narrow canvas puts it under everything instead.
  const lowest = Math.max(nodesBottom, ...svcBoxes.map((b) => b.y + SVC_H), ...ingBoxes.map((b) => b.y + ING_H));
  const sideX = stacked ? 0 : Math.max(nodesW, ...svcBoxes.map((b) => b.x + SVC_W), ...ingBoxes.map((b) => b.x + ING_W)) + 44;
  type Side = { kind: SelKind; ns?: string; name: string; title: string; sub: string; tone: string; x: number; y: number; uid: string; warn?: boolean };
  const sections: { label: string; items: Omit<Side, "x" | "y">[] }[] = [
    {
      label: "CONFIG",
      items: [
        ...cms.map((m) => ({ kind: "configmap" as const, ns: m.metadata.namespace, name: m.metadata.name, uid: m.metadata.uid, title: nsPrefix(m.metadata.namespace) + m.metadata.name, sub: `ConfigMap · ${Object.keys(m.data ?? {}).length} key${Object.keys(m.data ?? {}).length === 1 ? "" : "s"}`, tone: "#0891b2" })),
        ...secrets.map((m) => ({ kind: "secret" as const, ns: m.metadata.namespace, name: m.metadata.name, uid: m.metadata.uid, title: nsPrefix(m.metadata.namespace) + m.metadata.name, sub: `Secret · ${m.type === "Opaque" || !m.type ? "" : `${m.type.replace("kubernetes.io/", "")} · `}${Object.keys(m.data ?? {}).length} key${Object.keys(m.data ?? {}).length === 1 ? "" : "s"}`, tone: "#9333ea" })),
      ],
    },
    {
      label: "STORAGE",
      items: pvcs.map((p) => {
        const pv = p.spec?.volumeName ? (c.raw("PersistentVolume", undefined, p.spec.volumeName) as unknown as PersistentVolume | undefined) : undefined;
        const node = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms?.[0]?.matchExpressions?.[0]?.values?.[0];
        const phase = p.metadata.deletionTimestamp !== undefined ? "Terminating" : (p.status?.phase ?? "Pending");
        return { kind: "pvc" as const, ns: p.metadata.namespace, name: p.metadata.name, uid: p.metadata.uid, title: nsPrefix(p.metadata.namespace) + p.metadata.name, sub: `PVC · ${phase} · ${p.spec?.resources?.requests?.storage ?? ""}${node ? ` · on ${node}` : ""}`, tone: phase === "Bound" ? "#16a34a" : "#f59e0b", warn: phase !== "Bound" };
      }),
    },
    {
      label: "NETWORK POLICIES",
      items: netpols.map((n) => {
        const sel = Object.entries(n.spec?.podSelector?.matchLabels ?? {}).map(([a, b]) => `${a}=${b}`).join(",") || "all pods";
        return { kind: "networkpolicy" as const, ns: n.metadata.namespace, name: n.metadata.name, uid: n.metadata.uid, title: nsPrefix(n.metadata.namespace) + n.metadata.name, sub: `${(n.spec?.policyTypes ?? ["Ingress"]).join("+")} · ${sel} · ${((m) => `${m} pod${m === 1 ? "" : "s"}`)(pods.filter((p) => policySelects(c, n.metadata.namespace!, n.metadata.name, p)).length)}`, tone: "#e11d48" };
      }),
    },
    {
      label: "ACCESS",
      items: bindings.map((b) => ({ kind: "rolebinding" as const, ns: b.metadata.namespace, name: b.metadata.name, uid: b.metadata.uid, title: nsPrefix(b.metadata.namespace) + b.metadata.name, sub: `${(b.subjects ?? []).map((s) => s.name).join(", ") || "nobody"} → ${b.roleRef.name}`, tone: "#475569" })),
    },
  ].filter((s) => s.items.length);
  const sideItems: Side[] = [];
  const sideLabels: { label: string; y: number }[] = [];
  {
    let y = stacked ? lowest + ROW_GAP : yNodes;
    for (const s of sections) {
      sideLabels.push({ label: s.label, y: y - 14 });
      for (const it of s.items) {
        sideItems.push({ ...it, x: sideX, y });
        y += SIDE_H + 8;
      }
      y += 36;
    }
  }
  const sideByKey = new Map(sideItems.map((s) => [`${s.kind}:${s.ns}/${s.name}`, s]));

  // ---- moved cards: each goes where the Learner put it; everything drawn from it (wires, traffic, its Pods) follows.
  const inCard = new Set(topCards.flatMap((t) => t.children.map((ch) => ch.obj.metadata.uid)));
  /** What dragging a box moves: a ReplicaSet or Job under a workload moves the workload's card. */
  const moveKey = new Map<string, string>();
  for (const card of topCards) {
    const cardKey = objKey(card.obj.kind, card.obj.metadata.namespace, card.obj.metadata.name);
    moveKey.set(card.obj.metadata.uid, cardKey);
    for (const ch of card.children) moveKey.set(ch.obj.metadata.uid, cardKey);
    const to = place(cardKey, card.x, card.y);
    const dx = to.x - card.x;
    const dy = to.y - card.y;
    card.x = to.x;
    card.y = to.y;
    for (const ch of card.children) {
      ch.x += dx;
      ch.y += dy;
    }
  }
  for (const b of childBox.values()) {
    if (inCard.has(b.obj.metadata.uid)) continue;
    const key = objKey(b.obj.kind, b.obj.metadata.namespace, b.obj.metadata.name);
    moveKey.set(b.obj.metadata.uid, key);
    const to = place(key, b.x, b.y);
    b.x = to.x;
    b.y = to.y;
  }
  for (const nb of nodeBoxes) {
    const to = place(objKey("Node", undefined, nb.node.metadata.name), nb.x, nb.y);
    const dx = to.x - nb.x;
    const dy = to.y - nb.y;
    nb.x = to.x;
    nb.y = to.y;
    for (const p of nodePods.get(nb.node.metadata.name) ?? []) {
      const at = podPos.get(p.metadata.uid);
      if (at) {
        at.x += dx;
        at.y += dy;
      }
    }
  }
  for (const b of svcBoxes) Object.assign(b, place(objKey("Service", b.s.metadata.namespace, b.s.metadata.name), b.x, b.y));
  for (const b of ingBoxes) Object.assign(b, place(objKey("Ingress", b.ing.metadata.namespace, b.ing.metadata.name), b.x, b.y));
  for (const it of sideItems) Object.assign(it, place(`side:${it.kind}/${it.ns ?? ""}/${it.name}`, it.x, it.y));

  // ---- relationships for highlighting
  const selPod = selection?.kind === "pod" ? pods.find((p) => p.metadata.name === selection.name && p.metadata.namespace === (selection.ns ?? "default")) : undefined;
  const findTop = (kind: TopKind, name: string, ns?: string) => topCards.find((t) => t.kind === kind && t.obj.metadata.name === name && t.obj.metadata.namespace === (ns ?? "default"));
  const selChildUid =
    selection?.kind === "replicaset" || (selection?.kind === "job" && !findTop("job", selection.name, selection.ns))
      ? [...childBox.values()].find((b) => b.obj.metadata.name === selection.name && b.obj.metadata.namespace === (selection.ns ?? "default"))?.obj.metadata.uid
      : selPod
        ? ownerOf(selPod)?.uid
        : undefined;
  const selTop: TopCard | undefined =
    selection && ["deployment", "statefulset", "daemonset", "cronjob", "job"].includes(selection.kind)
      ? findTop(selection.kind as TopKind, selection.name, selection.ns)
      : undefined;
  const topOfChild = (uid?: string) => (uid ? topCards.find((t) => t.children.some((ch) => ch.obj.metadata.uid === uid) || t.obj.metadata.uid === uid || folded.get(uid) === t.obj.metadata.uid) : undefined);
  const hotTop = selTop ?? topOfChild(selChildUid);
  const selSvc = selection?.kind === "service" ? services.find((s) => s.metadata.name === selection.name && s.metadata.namespace === (selection.ns ?? "default")) : undefined;
  const selIng = selection?.kind === "ingress" ? ingresses.find((s) => s.metadata.name === selection.name && s.metadata.namespace === (selection.ns ?? "default")) : undefined;
  const selSide = selection ? sideByKey.get(`${selection.kind}:${selection.ns ?? "default"}/${selection.name}`) : undefined;

  const isSel = (kind: string, name: string, ns?: string) => selection?.kind === kind && selection.name === name && (selection.ns ?? "default") === (ns ?? "default");
  const click = (s: Selection) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (drag?.justDropped() || performance.now() - movedAt.current < 300) return;
    onSelect(s);
  };

  const podTop = (uid: string): Pt | undefined => {
    const p = podPos.get(uid);
    return p ? { x: p.x + CHIP_W / 2, y: p.y } : undefined;
  };
  const podBottom = (uid: string): Pt | undefined => {
    const p = podPos.get(uid);
    return p ? { x: p.x + CHIP_W / 2, y: p.y + CHIP_H } : undefined;
  };
  const podRight = (uid: string): Pt | undefined => {
    const p = podPos.get(uid);
    return p ? { x: p.x + CHIP_W, y: p.y + CHIP_H / 2 } : undefined;
  };

  // service edge geometry, reused for packets
  const svcEdges = new Map<string, { a: Pt; b: Pt; c1: Pt; c2: Pt; d: string; ready: boolean; svcUid: string; podUid: string }>();
  for (const { s, x, y } of svcBoxes) {
    const ep = c.raw("Endpoints", s.metadata.namespace, s.metadata.name) as unknown as Endpoints | undefined;
    const addrs = (ep?.subsets ?? []).flatMap((sub) => [...(sub.addresses ?? []).map((a) => ({ a, ready: true })), ...(sub.notReadyAddresses ?? []).map((a) => ({ a, ready: false }))]);
    for (const { a, ready } of addrs) {
      const uid = a.targetRef?.uid ?? "";
      const b = podBottom(uid);
      if (!b) continue;
      const from = { x: x + SVC_W / 2, y };
      const cv = curve(from, b);
      svcEdges.set(`${s.metadata.uid}/${uid}`, { a: from, b, ...cv, ready, svcUid: s.metadata.uid, podUid: uid });
    }
  }
  // ingress → service edges
  const ingEdges = new Map<string, { a: Pt; b: Pt; c1: Pt; c2: Pt; d: string; ingUid: string; svcUid: string }>();
  for (const { ing, x, y } of ingBoxes) {
    const backends = new Set<string>();
    for (const r of ing.spec?.rules ?? []) for (const p of r.http?.paths ?? []) if (p.backend.service) backends.add(p.backend.service.name);
    if (ing.spec?.defaultBackend?.service) backends.add(ing.spec.defaultBackend.service.name);
    for (const name of backends) {
      const sb = svcBox.get(`${ing.metadata.namespace}/${name}`);
      if (!sb) continue;
      const a = { x: x + ING_W / 2, y };
      const b = { x: sb.x + SVC_W / 2, y: sb.y + SVC_H };
      const cv = curve(a, b);
      ingEdges.set(`${ing.metadata.uid}/${sb.s.metadata.uid}`, { a, b, ...cv, ingUid: ing.metadata.uid, svcUid: sb.s.metadata.uid });
    }
  }
  // side-column edges: shown for the selected Pod, or for the selected side item's Pods
  const sideEdges: { d: string; key: string }[] = [];
  const refsOf = (p: Pod) => podRefs(p);
  const linkPod = (p: Pod, it: Side) => {
    const a = podRight(p.metadata.uid);
    if (!a) return;
    sideEdges.push({ d: hcurve(a, { x: it.x, y: it.y + SIDE_H / 2 }), key: `${p.metadata.uid}/${it.uid}` });
  };
  if (selPod) {
    const r = refsOf(selPod);
    for (const it of sideItems) {
      const hit = (it.kind === "configmap" && r.configmap.has(it.name)) || (it.kind === "secret" && r.secret.has(it.name)) || (it.kind === "pvc" && r.pvc.has(it.name)) || (it.kind === "networkpolicy" && (c.raw("NetworkPolicy", it.ns, it.name) ? isIsolated(c, selPod, "Ingress") || isIsolated(c, selPod, "Egress") : false) && policySelects(c, it.ns!, it.name, selPod));
      if (hit && it.ns === selPod.metadata.namespace) linkPod(selPod, it);
    }
  } else if (selSide) {
    for (const p of pods) {
      if (p.metadata.namespace !== selSide.ns) continue;
      const r = refsOf(p);
      const hit = (selSide.kind === "configmap" && r.configmap.has(selSide.name)) || (selSide.kind === "secret" && r.secret.has(selSide.name)) || (selSide.kind === "pvc" && r.pvc.has(selSide.name)) || (selSide.kind === "networkpolicy" && policySelects(c, selSide.ns!, selSide.name, p));
      if (hit) linkPod(p, selSide);
    }
  }

  // Every NetworkPolicy is always linked (faintly) to the Pods it selects: a policy floating on its own says nothing.
  const polEdges: { d: string; key: string }[] = [];
  for (const it of sideItems) {
    if (it.kind !== "networkpolicy" || selSide === it) continue;
    for (const p of pods) {
      if (!policySelects(c, it.ns!, it.name, p)) continue;
      const a = podRight(p.metadata.uid);
      if (a) polEdges.push({ d: hcurve(a, { x: it.x, y: it.y + SIDE_H / 2 }), key: `np${p.metadata.uid}/${it.uid}` });
    }
  }

  const hotChild = (uid: string) => !!selection && (selChildUid === uid || (!!hotTop && hotTop.children.some((ch) => ch.obj.metadata.uid === uid)));
  const hotCard = (uid: string) => !!hotTop && hotTop.obj.metadata.uid === uid;

  // Everything on the canvas, wherever it was put.
  const boxes: [x: number, y: number, w: number, h: number][] = [
    ...topCards.map((t): [number, number, number, number] => [t.x, t.y, t.w, DEP_H]),
    ...[...childBox.values()].map((b): [number, number, number, number] => [b.x, b.y, RS_W, RS_H]),
    ...nodeBoxes.map((n): [number, number, number, number] => [n.x, n.y, n.w, n.h]),
    ...svcBoxes.map((b): [number, number, number, number] => [b.x, b.y, SVC_W, SVC_H]),
    ...ingBoxes.map((b): [number, number, number, number] => [b.x, b.y, ING_W, ING_H]),
    ...sideItems.map((it): [number, number, number, number] => [it.x, it.y, SIDE_W, SIDE_H]),
  ];
  const minX = Math.min(pending.length ? qx : 0, ...boxes.map((b) => b[0])) - 40;
  const maxX = Math.max(nodesW, ...boxes.map((b) => b[0] + b[2])) + 40;
  const maxY = Math.max(lowest, pending.length ? yNodes + queueH : 0, ...boxes.map((b) => b[1] + b[3])) + 40;
  const top = Math.min(topCards.length || childBox.size ? Y_DEP : yNodes, ...boxes.map((b) => b[1])) - 40;
  const bounds: Bounds = { x: minX, y: top, w: maxX - minX, h: maxY - top };
  // Fit-to-screen always shows every Node (and the scheduler queue beside them), wherever they were moved.
  const nodesLeft = Math.min(pending.length ? qx : Infinity, ...nodeBoxes.map((n) => n.x));
  const nodesTop = Math.min(yNodes, ...nodeBoxes.map((n) => n.y));
  const nodesRight = Math.max(...nodeBoxes.map((n) => n.x + n.w), nodesLeft + 1);
  const nodesLow = Math.max(...nodeBoxes.map((n) => n.y + n.h), pending.length ? yNodes + queueH : 0);
  const nodesArea: Bounds = { x: nodesLeft, y: nodesTop - 24, w: nodesRight - nodesLeft, h: nodesLow - nodesTop + 24 };

  const hpaFor = (kind: string, name: string, ns?: string) => hpas.find((h) => h.spec?.scaleTargetRef.kind === kind && h.spec.scaleTargetRef.name === name && h.metadata.namespace === ns);
  const metrics = c.state.metrics;

  // Level of detail: zoomed out, objects simplify instead of shrinking their text.
  const detail = k >= 0.6 ? 2 : k >= 0.42 ? 1 : 0;
  // Zoomed out to fit, text grows a little (up to 25%) instead of shrinking with the boxes, so it stays readable.
  const T = Math.min(1.25, Math.max(1, 0.85 / k));
  const fz = (n: number) => n * T;
  // Live request rates, from the Pods' own request logs (what metrics-server and the HPA read too).
  const beat = Math.floor(c.now / RATE_BEAT) * RATE_BEAT;
  const series = new Map(pods.map((p) => [p.metadata.uid, servedSeries(c, p.metadata.uid, beat)]));
  const errSeries = new Map(pods.map((p) => [p.metadata.uid, servedSeries(c, p.metadata.uid, beat, "errs")]));
  const podRate = (uid: string) => rateOf(series.get(uid) ?? []);
  /** Share of a Pod's recent requests it answered with an error. */
  const podErr = (uid: string) => {
    const r = podRate(uid);
    return r ? rateOf(errSeries.get(uid) ?? []) / r : 0;
  };
  // A Service's traffic is what its Pods served, plus requests it had no ready Pod for (those all fail).
  const svcSeries = (svcUid: string, key: "reqs" | "errs" = "reqs") => {
    const out = bucket(c.state.svcErrs?.[svcUid] ?? [], beat);
    const lost = c.state.loadLost?.[svcUid];
    if (lost) lost.t.forEach((at, j) => addAt(out, at, beat, lost.n[j]));
    for (const e of svcEdges.values()) if (e.svcUid === svcUid) (key === "reqs" ? series : errSeries).get(e.podUid)?.forEach((n, i) => (out[i] += n));
    return out;
  };
  const svcRate = new Map(svcBoxes.map(({ s }) => [s.metadata.uid, rateOf(svcSeries(s.metadata.uid))]));
  const svcErr = new Map(svcBoxes.map(({ s }) => [s.metadata.uid, svcRate.get(s.metadata.uid) ? rateOf(svcSeries(s.metadata.uid, "errs")) / svcRate.get(s.metadata.uid)! : 0]));
  // A rate label on every wire carrying traffic, each at the first point along its wire that's clear of the others.
  const rateLabels: (Pt & { key: string; text: string; bad: boolean })[] = [];
  if (detail > 0) {
    const placed: { x: number; y: number; w: number }[] = [];
    const wires = [
      ...[...svcEdges.values()].filter((e) => e.ready).map((e) => ({ key: `s${e.svcUid}/${e.podUid}`, e, r: podRate(e.podUid), err: podErr(e.podUid) })),
      ...[...ingEdges.values()].map((e) => ({ key: `i${e.ingUid}/${e.svcUid}`, e, r: svcRate.get(e.svcUid) ?? 0, err: svcErr.get(e.svcUid) ?? 0 })),
    ];
    // A label never sits on a Pod: the wire may cross other Pods on its way, and the Pod shows its own rate anyway.
    const chips = [...podPos.values()];
    const onPod = (q: Pt, w: number) => chips.some((c) => q.x + w / 2 > c.x - 4 && q.x - w / 2 < c.x + CHIP_W + 4 && q.y + 11 * T > c.y - 4 && q.y - 11 * T < c.y + CHIP_H + 4);
    for (const { key, e, r, err } of wires) {
      if (!r) continue;
      const text = fmtTraffic(r, err);
      const w = rateWidth(text, T);
      const spots = [0.5, 0.62, 0.38, 0.72, 0.28, 0.82, 0.18, 0.9].map((t) => onCubic(e.a, e.c1, e.c2, e.b, t)).filter((q) => !onPod(q, w));
      const at = spots.find((q) => placed.every((o) => Math.abs(o.x - q.x) > (o.w + w) / 2 + 18 || Math.abs(o.y - q.y) > 21 * T)) ?? spots[0];
      if (!at) continue;
      placed.push({ ...at, w });
      rateLabels.push({ ...at, key, text, bad: err >= 0.01 });
    }
  }
  // Service → Pod edges carrying requests right now, for the flow animation.
  const flowing = new Set(packets.filter((p) => p.serviceUid && !p.blocked).map((p) => `${p.serviceUid}/${p.podUid}`));
  const parentOf = new Map(topCards.flatMap((t) => t.children.map((ch) => [ch.obj.metadata.uid, t.obj.metadata.uid] as const)));
  const lane = new Map([...cardByUid.keys(), ...childBox.keys()].map((uid, i) => [uid, i % 5]));
  const cls = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

  // Owner → Pod wires.
  const podWires = pods.flatMap((p) => {
    const own = ownerOf(p);
    const t = own && podTop(p.metadata.uid);
    if (!own || !t) return [];
    const child = childBox.get(own.uid);
    // A folded ReplicaSet's Pods hang straight off their Deployment's card.
    const card = child ? undefined : cardByUid.get(folded.get(own.uid) ?? own.uid);
    if (!child && !card) return [];
    const from = child ? { x: child.x + RS_W / 2, y: child.y + RS_H } : { x: card!.x + card!.w / 2, y: card!.y + DEP_H };
    const h = (child ? hotChild(own.uid) : hotCard(card!.obj.metadata.uid)) || selPod?.metadata.uid === p.metadata.uid;
    const hue = hueFor(child ? child.obj.metadata.name : own.kind === "ReplicaSet" ? own.name : card!.obj.metadata.name);
    // Pending Pods sit in the scheduler queue on the left: a curve reads better than a right-angle route there.
    // Each owner turns on its own lane so different workloads' wires don't merge into one line.
    const turnY = yNodes - 14 - (lane.get(folded.get(own.uid) ?? own.uid) ?? 0) * 7;
    const sched = !!p.spec?.nodeName;
    // A card moved out of the band above the Nodes gets a curve: a right-angle route only reads from above.
    const routed = sched && from.y < turnY - 4 && t.y > turnY + 4;
    const d = routed ? ortho(from, t, turnY) : curve(from, t).d;
    const len = routed ? orthoLen(from, t, turnY) : Math.hypot(t.x - from.x, t.y - from.y) * 1.25;
    const root = child ? (parentOf.get(own.uid) ?? own.uid) : card!.obj.metadata.uid;
    return [{ p, own, child, d, len, hue, h, cat: podCategory(p), sched, root }];
  });
  // An owner's comets all travel its longest wire's distance, so they move at one speed and stay
  // together down the shared trunk before splitting off to each Pod.
  const spanOf = new Map<string, number>();
  for (const w of podWires) spanOf.set(w.own.uid, Math.max(spanOf.get(w.own.uid) ?? 0, w.len));

  return (
    <PanZoom bounds={bounds} mustFit={nodesArea} captureWheel={captureWheel} fitKey={`${tidied}:${refit}:${perRow}:${wrap}:${yNodes}:${ordered.length}:${topCards.length}:${services.length}:${ingresses.length}:${sideItems.length > 0}`} onBackgroundClick={() => onSelect(null)} inset={inset} onZoom={setK} onFull={setFullShape} controls={custom ? <TidyButton onClick={tidy} /> : undefined}>
      {/* section labels */}
      {detail > 0 && !custom && (
        <g className="cv-label">
          {topCards.length > 0 && <text x={minX + 40} y={Y_DEP - 14}>WORKLOADS</text>}
          <text x={minX + 40} y={yNodes - 14}>NODES</text>
          {services.length > 0 && <text x={minX + 40} y={svcY - 14}>SERVICES</text>}
          {ingresses.length > 0 && <text x={minX + 40} y={ingY - 14}>INGRESS</text>}
          {sideLabels.map((l) => (
            <text key={l.label} x={sideX} y={l.y}>
              {l.label}
            </text>
          ))}
        </g>
      )}

      {/* ------------ edges (behind cards) */}
      <g pointerEvents="none">
        {topCards.flatMap(({ obj, x, y, w, children }) =>
          children.map((b) => {
            const h = hotCard(obj.metadata.uid);
            const tip = { x: b.x + RS_W / 2, y: b.y };
            const from = { x: x + w / 2, y: y + DEP_H };
            const turn = (y + DEP_H + b.y) / 2;
            const end = { x: tip.x, y: tip.y - ARROW };
            const d = end.y > from.y + 8 ? ortho(from, end, turn) : curve(from, end).d;
            const len = end.y > from.y + 8 ? orthoLen(from, end, turn) : Math.hypot(end.x - from.x, end.y - from.y) * 1.25;
            const rs = b.kind === "replicaset" ? (b.obj as ReplicaSet) : undefined;
            const want = rs ? (rs.spec?.replicas ?? 0) : 1;
            const settled = !rs || (rs.status?.readyReplicas ?? 0) >= want;
            return (
              <g key={`d${b.obj.metadata.uid}`}>
                <path d={d} className={cls("cv-wire", h && "is-hot")} />
                <path d={arrowDown(tip)} className={cls("cv-arrow", h && "is-hot")} />
                {/* A ReplicaSet scaled to zero (an old revision) has nothing to say. */}
                {detail > 0 && want > 0 && (
                  <>
                    <Comet d={d} span={len} hop="toChild" root={obj.metadata.uid} color="var(--cv-flow)" />
                    <Comet d={d} span={len} hop="fromChild" root={obj.metadata.uid} color={settled ? CAT.ok.dot : CAT.starting.dot} up />
                  </>
                )}
              </g>
            );
          }),
        )}
        {podWires.map(({ p, own, child, d, len, hue, h, cat, sched, root }) => {
          const span = spanOf.get(own.uid) ?? len;
          return (
            <g key={`r${p.metadata.uid}`} className="cv-edge">
              <path d={d} fill="none" style={{ stroke: `hsl(${hue} 55% var(${h ? "--cv-owner-hot-l" : "--cv-owner-l"}))` }} strokeOpacity={h ? 0.95 : 0.7} strokeWidth={h ? 1.6 : 1.2} />
              {detail > 0 && cat !== "gone" && (
                <>
                  <Comet d={d} span={span} hop={child ? "toPod" : "direct"} root={root} color="var(--cv-flow)" />
                  {/* Only a Pod that has landed on a Node has a kubelet to report its status back. */}
                  {sched && <Comet d={d} span={span} hop="fromPod" root={root} color={CAT[cat].dot} up />}
                </>
              )}
            </g>
          );
        })}
        {[...svcEdges.values()].map((e) => {
          const h = selSvc?.metadata.uid === e.svcUid || selPod?.metadata.uid === e.podUid;
          const key = `${e.svcUid}/${e.podUid}`;
          const r = podRate(e.podUid);
          return (
            <g key={`s${key}`} className="cv-edge">
              <path d={e.d} className={cls("cv-svc-wire", h && "is-hot", !e.ready && "is-notready", e.ready && (flowing.has(key) || r > 0) && "is-live", e.ready && podErr(e.podUid) >= 0.01 && "is-failing")} />
            </g>
          );
        })}
        {[...ingEdges.values()].map((e) => {
          const h = selIng?.metadata.uid === e.ingUid || selSvc?.metadata.uid === e.svcUid;
          const r = svcRate.get(e.svcUid) ?? 0;
          return (
            <g key={`i${e.ingUid}${e.svcUid}`} className="cv-edge">
              <path d={e.d} className={cls("cv-svc-wire", h && "is-hot", r > 0 && "is-live", (svcErr.get(e.svcUid) ?? 0) >= 0.01 && "is-failing")} />
            </g>
          );
        })}
        {sideEdges.map((e) => (
          <path key={e.key} d={e.d} fill="none" stroke="var(--cv-line-3)" strokeOpacity={0.7} strokeWidth={1.3} strokeDasharray="5 4" />
        ))}
      </g>

      {/* ------------ controllers: a kind label over the name, the image on the right of the label, readiness beside the name */}
      {topCards.map(({ kind, obj, x, y: ty, w, children }) => {
        const ns = obj.metadata.namespace;
        const name = obj.metadata.name;
        const sel = isSel(kind, name, ns);
        const card = cardSummary(c, kind, obj);
        const hpa = kind === "deployment" ? hpaFor("Deployment", name, ns) : kind === "statefulset" ? hpaFor("StatefulSet", name, ns) : undefined;
        const dropKey = kind === "deployment" ? `deployment:${ns}/${name}` : undefined;
        const dragItem = item(kind, ns, name, `${cardSummary(c, kind, obj).kindLabel} ${name}`);
        // The colour bar matches the Pods' revision colour: the newest ReplicaSet's, folded or not.
        const newest = kind === "deployment" ? [...children.map((ch) => ch.obj), ...rsAll.filter((r) => folded.get(r.metadata.uid) === obj.metadata.uid)].sort((p, q) => q.metadata.creationTimestamp - p.metadata.creationTimestamp)[0] : undefined;
        const hue = hueFor(newest?.metadata.name ?? name);
        const state = card.status.replace(/ ready$/, "");
        const stateW = textWidth(state, fz(12.5), { mono: true, weight: 600 }) + fz(14);
        const kindW = textWidth(card.kindLabel.toUpperCase(), fz(10), { weight: 600 }) * 1.1 + 10;
        return (
          <g
            key={obj.metadata.uid}
            data-kind={kind}
            className={cls("cv-obj cv-fade cursor-pointer", card.tone === "bad" && "is-bad", card.tone === "warn" && "is-warn", hotCard(obj.metadata.uid) && !sel && "is-hot")}
            {...(dropKey ? { "data-drop": dropKey } : {})}
            {...mover(moveKey.get(obj.metadata.uid)!, dragItem)}
            onClick={click({ kind, ns, name })}
            {...act({ kind, ns, name }, `${card.kindLabel} ${name}, ${card.status}`)}
          >
            <title>{`${card.kindLabel} ${nsPrefix(ns) + name} · ${card.sub}`}</title>
            <rect className="cv-body" x={x} y={ty} width={w} height={DEP_H} rx={R} />
            {sel && <rect className="cv-ring" x={x - 3.5} y={ty - 3.5} width={w + 7} height={DEP_H + 7} rx={R + 3} />}
            {dropKey && hl(dropKey) && <rect x={x - 3} y={ty - 3} width={w + 6} height={DEP_H + 6} rx={R} fill="var(--cv-accent)" fillOpacity={0.06} stroke="var(--cv-accent)" strokeWidth={2} strokeDasharray="6 4" />}
            <rect x={x} y={ty + 14} width={3} height={DEP_H - 28} rx={1.5} fill={`hsl(${hue} 65% 55%)`} />
            {detail > 0 && (
              <>
                <text x={x + 16} y={ty + 22} className="cv-kind" style={{ fontSize: fz(10) }}>
                  {card.kindLabel.toUpperCase()}
                </text>
                <text x={x + w - 14} y={ty + 22} textAnchor="end" className="cv-sub cv-mono" style={{ fontSize: fz(10.5) }}>
                  {fit(card.sub, w - 30 - kindW, fz(10.5), { mono: true })}
                </text>
              </>
            )}
            <text x={x + 16} y={detail ? ty + 43 : ty + 35} className="cv-title" style={{ fontSize: fz(15) }}>
              {fit(nsPrefix(ns) + name, w - 30 - (detail ? stateW : 0), fz(15), { weight: 600 })}
            </text>
            {detail > 0 && (
              <>
                <Mark cat={card.tone} x={x + w - 14 - stateW + fz(4)} y={ty + 38.5} r={3.5} />
                <text x={x + w - 14} y={ty + 43} textAnchor="end" className="cv-mono" fill={TONE_TEXT[card.tone]} style={{ fontSize: fz(12.5), fontWeight: 600 }}>
                  {state}
                </text>
              </>
            )}
            {hpa && detail > 1 && <Tag s={T} x={x + w / 2} y={ty + DEP_H + 7} anchor="middle" cat="hpa" text={`HPA ${hpa.spec?.minReplicas ?? 1}–${hpa.spec?.maxReplicas} · ${hpaTarget(hpa)}`} />}
            {/* Replicas, set from the card: shown on hover, or while the card is selected (touch). An HPA owns the count when there is one. */}
            {onScale && !hpa && detail > 0 && (kind === "deployment" || kind === "statefulset") && (
              <Stepper
                x={x + w}
                y={ty + DEP_H}
                on={sel}
                label={name}
                value={(obj as Deployment | StatefulSet).spec?.replicas ?? 1}
                onChange={(n) => onScale(kind, ns ?? "default", name, n)}
              />
            )}
          </g>
        );
      })}
      {[...childBox.values()].map(({ kind, obj, x, y }) => {
        const hue = hueFor(obj.metadata.name);
        const isRs = kind === "replicaset";
        const rs = obj as ReplicaSet;
        const job = obj as Job;
        const want = isRs ? (rs.spec?.replicas ?? 0) : (job.spec?.completions ?? 1) ?? 1;
        const retired = isRs ? want === 0 : jobDone(job);
        const rev = isRs ? rs.metadata.annotations?.["deployment.kubernetes.io/revision"] : undefined;
        const sel = isSel(kind, obj.metadata.name, obj.metadata.namespace);
        const failed = !isRs && jobFailedFlag(job);
        const right = isRs ? `${rs.status?.readyReplicas ?? 0}/${want}` : failed ? "failed" : `${job.status?.succeeded ?? 0}/${want}`;
        const label = isRs ? `ReplicaSet ${obj.metadata.name}, ${rs.status?.readyReplicas ?? 0} of ${want} ready` : `Job ${obj.metadata.name}, ${job.status?.succeeded ?? 0} of ${want} succeeded`;
        const rightW = textWidth(right, fz(12), { mono: true, weight: 600 });
        return (
          <g key={obj.metadata.uid} data-kind={kind} className={cls("cv-obj cv-fade cursor-pointer", failed && "is-bad", hotChild(obj.metadata.uid) && !sel && "is-hot")} opacity={retired ? 0.55 : 1} style={{ transform: `translate(${x}px, ${y}px)`, transition: moving ? "none" : "transform .6s cubic-bezier(.22,1,.36,1)" }} {...mover(moveKey.get(obj.metadata.uid)!, item(kind, obj.metadata.namespace, obj.metadata.name, `ReplicaSet ${obj.metadata.name}`))} onClick={click({ kind, ns: obj.metadata.namespace, name: obj.metadata.name })} {...act({ kind, ns: obj.metadata.namespace, name: obj.metadata.name }, label)}>
            <rect className="cv-body" width={RS_W} height={RS_H} rx={R} />
            {sel && <rect className="cv-ring" x={-3.5} y={-3.5} width={RS_W + 7} height={RS_H + 7} rx={R + 3} />}
            <rect x={0} y={12} width={3} height={RS_H - 24} rx={1.5} fill={`hsl(${hue} 65% 55%)`} />
            {detail > 0 && (
              <text x={14} y={19} className="cv-kind" style={{ fontSize: fz(9.5) }}>
                {isRs ? `REPLICASET${rev ? ` · REV ${rev}` : ""}` : `JOB · ${jobDone(job) ? "COMPLETE" : failed ? "FAILED" : "RUNNING"}`}
              </text>
            )}
            <text x={14} y={detail ? 37 : 30} className="cv-title cv-mono" style={{ fontSize: fz(12) }}>
              {fit(obj.metadata.name, RS_W - 14 - rightW - 20, fz(12), { mono: true, weight: 600, keepEnd: true })}
              <title>{obj.metadata.name}</title>
            </text>
            <text x={RS_W - 12} y={37} textAnchor="end" className="cv-mono" fill={failed ? "var(--cv-danger-text)" : "var(--cv-text)"} style={{ fontSize: fz(12.5), fontWeight: 600 }}>
              {right}
            </text>
          </g>
        );
      })}

      {/* ------------ scheduler queue (only while Pods wait for a Node) */}
      {pending.length > 0 && (
        <g className="cv-fade">
          <rect x={qx} y={yNodes} width={QUEUE_W} height={queueH} rx={R} fill="var(--cv-warn-soft)" stroke="var(--cv-warn-line)" strokeDasharray="5 4" />
          <text x={qx + QUEUE_W / 2} y={yNodes + 24} textAnchor="middle" className="cv-title" style={{ fontSize: fz(12) }}>
            Scheduler
          </text>
          <text x={qx + QUEUE_W / 2} y={yNodes + 40} textAnchor="middle" className="cv-sub" style={{ fontSize: fz(10.5) }}>
            {pending.length} waiting for a node
          </text>
        </g>
      )}

      {/* ------------ nodes */}
      {nodeBoxes.map(({ node, x, y, h, w: NW, collapsed }) => {
        const name = node.metadata.name;
        const rt = c.state.nodes[name];
        const ready = node.status?.conditions.find((q) => q.type === "Ready")?.status === "True";
        const down = !!rt && !rt.up;
        const isCp = node === cp;
        const cordoned = !!node.spec?.unschedulable;
        const userTaints = (node.spec?.taints ?? []).filter((t) => !t.key.startsWith("node.kubernetes.io/") && !t.key.startsWith("node-role.kubernetes.io/"));
        const status = down && ready ? "no heartbeat" : ready ? (cordoned ? "cordoned" : "Ready") : "NotReady";
        const tone: Tone = down ? "bad" : !ready || cordoned ? "warn" : "ok";
        const sel = isSel("node", name);
        const onNode = nodePods.get(name) ?? [];
        const used = onNode.filter((p) => !p.metadata.deletionTimestamp).length;
        // Requested resources (what the scheduler counts) and live usage from metrics-server.
        const alloc = nodeAllocatable(node);
        const allOnNode = c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === name && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
        const req = allOnNode.reduce((a, p) => { const r = podRequests(p.spec); return { cpu: a.cpu + r.cpu, memory: a.memory + r.memory }; }, { cpu: 0, memory: 0 });
        const use = metrics.nodes[name];
        const showBars = req.cpu > 0 || !!use;
        // Requested CPU and memory: two thin bars on the right half of the header.
        const barX = x + NW / 2;
        const barW = NW / 2 - 16;
        const statusW = textWidth(status, fz(12.5), { weight: 500 }) + fz(14);
        const kube = health?.kubelets[name];
        /** The component chips of the control plane, as the engine says they are (or quiet green ones when the screen passes no health). */
        const comps = isCp ? (health?.components.length ? health.components : undefined) : undefined;
        return (
          <g key={node.metadata.uid} data-kind={isCp ? "cp" : "node"} className={cls("cv-obj cv-fade cursor-pointer", down && "is-down", !down && tone === "warn" && "is-warn")} {...dnd(`node:${name}`)} {...mover(objKey("Node", undefined, name), isCp ? undefined : item("node", undefined, name, `Node ${name}`))} onClick={click({ kind: "node", name })} {...act({ kind: "node", name }, `Node ${name}, ${status}, ${used} pods${showBars ? `, CPU requested ${Math.round((req.cpu / alloc.cpu) * 100)}%` : ""}`)}>
            <title>{[`${name} · ${node.status?.addresses[0].address}`, ...(isCp ? (health?.components ?? []).filter((x) => x.cause).map((x) => `${x.name}: ${x.cause}`) : []), ...(kube?.cause ? [`kubelet: ${kube.cause}`] : [])].join("\n")}</title>
            <rect className="cv-body" x={x} y={y} width={NW} height={h} rx={R} />
            {sel && <rect className="cv-ring" x={x - 3.5} y={y - 3.5} width={NW + 7} height={h + 7} rx={R} />}
            {cordoned && <rect x={x} y={y} width={NW} height={h} rx={R} fill="url(#cv-hatch)" pointerEvents="none" />}
            {hl(`node:${name}`) && <rect x={x - 4} y={y - 4} width={NW + 8} height={h + 8} rx={R} fill="var(--cv-accent)" fillOpacity={0.06} stroke="var(--cv-accent)" strokeWidth={2} strokeDasharray="7 5" pointerEvents="none" />}
            <line className="cv-hair" x1={x + 1} x2={x + NW - 1} y1={y + HEAD} y2={y + HEAD} />
            <text x={x + 18} y={y + 29} className="cv-title" style={{ fontSize: fz(15.5) }}>
              {fit(name, NW - 36 - statusW, fz(15.5), { weight: 600 })}
            </text>
            <Mark cat={tone} x={x + NW - 16 - statusW + fz(4)} y={y + 24.5} r={3.5} />
            <text x={x + NW - 16} y={y + 29} textAnchor="end" fill={tone === "ok" ? "var(--cv-ok-text)" : TONE_TEXT[tone]} style={{ fontSize: fz(12.5), fontWeight: 500 }}>
              {status}
            </text>
            {detail > 0 && (
              <text x={x + 18} y={y + 47} className="cv-sub" style={{ fontSize: fz(12) }}>
                {fit(`${isCp ? "control plane" : "worker"}${collapsed ? "" : ` · ${used} pod${used === 1 ? "" : "s"}`}${userTaints.length ? ` · tainted ${userTaints.map((t) => t.key).join(",")}` : ""}`, showBars && detail > 1 && !collapsed ? NW / 2 - 24 : NW - 36, fz(12))}
              </text>
            )}
            {showBars && detail > 1 && !collapsed && (
              <g pointerEvents="none">
                <title>{`Requested: CPU ${req.cpu}m of ${alloc.cpu}m, memory ${Math.round(req.memory / 2 ** 20)}Mi of ${Math.round(alloc.memory / 2 ** 20)}Mi${use ? `\nUsing now: CPU ${use.cpu}m, memory ${Math.round(use.memory / 2 ** 20)}Mi` : ""}`}</title>
                <Bar x={barX} y={y + 40} w={barW} frac={req.cpu / alloc.cpu} usage={use ? use.cpu / alloc.cpu : undefined} label="cpu" />
                <Bar x={barX} y={y + 50} w={barW} frac={req.memory / alloc.memory} usage={use ? use.memory / alloc.memory : undefined} label="mem" />
              </g>
            )}
            {!collapsed && used === 0 && !isCp && detail > 0 && (
              <text x={x + NW / 2} y={y + HEAD + PAD + CHIP_H / 2 + 4} textAnchor="middle" className="cv-sub" style={{ fontSize: fz(11), opacity: 0.7 }} pointerEvents="none">
                no pods
              </text>
            )}
            {collapsed && (
              <g pointerEvents="none">
                <title>kube-apiserver, etcd, kube-scheduler and kube-controller-manager run here. Turn on System pods to see them.</title>
                <rect x={x + PAD} y={y + HEAD + 8} width={NW - PAD * 2} height={CP_BODY - 16} rx={R} className="cv-tint" />
                {comps ? (
                  <>
                    {comps.map((q, j) => (
                      <Mark key={q.name} cat={q.tone} x={x + PAD + 13 + j * 12} y={y + HEAD + CP_BODY / 2} r={3.2} />
                    ))}
                    {(() => {
                      // Every Pod Running: the quiet label. Otherwise the first one kubectl would not show as Running, with its STATUS word.
                      const off = comps.filter((q) => q.tone !== "ok" && q.word);
                      const text = off.length ? `${off[0].short} ${off[0].word}${off.length > 1 ? ` +${off.length - 1}` : ""}` : "4 system components";
                      return (
                        <text x={x + PAD + 13 + comps.length * 12 + 6} y={y + HEAD + CP_BODY / 2 + 4} className={off.length ? undefined : "cv-ink"} fill={off.length ? TONE_TEXT[off[0].tone] : undefined} style={{ fontSize: fz(11), fontWeight: 500 }}>
                          {fit(text, NW - PAD * 2 - 13 - comps.length * 12 - 6 - 8, fz(11), { weight: 500 })}
                        </text>
                      );
                    })()}
                  </>
                ) : (
                  <>
                    <Mark cat={down ? "stale" : "ok"} x={x + PAD + 13} y={y + HEAD + CP_BODY / 2} />
                    <text x={x + PAD + 24} y={y + HEAD + CP_BODY / 2 + 4} className="cv-ink" style={{ fontSize: fz(11), fontWeight: 500 }}>
                      4 system components
                    </text>
                  </>
                )}
              </g>
            )}
            {isCp && !showSystem && !collapsed && (
              <g pointerEvents="none">
                {(comps ?? [{ name: "kube-apiserver", short: "kube-apiserver", word: "", tone: down ? "muted" : "ok" }, { name: "etcd", short: "etcd", word: "", tone: down ? "muted" : "ok" }, { name: "kube-scheduler", short: "scheduler", word: "", tone: down ? "muted" : "ok" }, { name: "kube-controller-manager", short: "controller-mgr", word: "", tone: down ? "muted" : "ok" }]).map((q, j) => {
                  const cw = (NW - PAD * 2 - CHIP_GAP) / 2;
                  const px = x + PAD + (j % 2) * (cw + CHIP_GAP);
                  const py = y + HEAD + PAD + Math.floor(j / 2) * (CHIP_H + CHIP_GAP);
                  return (
                    <g key={q.name}>
                      <rect x={px} y={py} width={cw} height={CHIP_H} rx={R} className="cv-tint" />
                      <Mark cat={q.tone === "muted" && down ? "stale" : q.tone} x={px + 14} y={py + (q.word || comps ? CHIP_H / 2 - 7 : CHIP_H / 2)} />
                      <text x={px + 26} y={py + (q.word || comps ? CHIP_H / 2 - 3 : CHIP_H / 2 + 4)} className="cv-ink cv-mono" style={{ fontSize: fz(11.5), fontWeight: 600 }}>
                        {fit(q.short, cw - 32, fz(11.5), { mono: true, weight: 600 })}
                      </text>
                      {comps && q.word && (
                        <text x={px + 26} y={py + CHIP_H / 2 + 13} fill={TONE_TEXT[q.tone]} style={{ fontSize: fz(10.5), fontWeight: 500 }}>
                          {fit(q.word, cw - 32, fz(10.5), { weight: 500 })}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            )}
            {down && detail > 0 && (
              <text x={x + NW / 2} y={y + h - 10 - (health ? KUBELET_ROW : 0)} textAnchor="middle" className="fill-red-500" style={{ fontSize: fz(10.5), fontWeight: 500 }}>
                powered off · kubelet not reporting
              </text>
            )}
            {kube && (
              <g pointerEvents="none" data-kubelet={name}>
                <line className="cv-hair" x1={x + 1} x2={x + NW - 1} y1={y + h - KUBELET_ROW} y2={y + h - KUBELET_ROW} />
                <Mark cat={kube.tone} x={x + PAD + 4} y={y + h - KUBELET_ROW / 2} r={3.2} />
                <text x={x + PAD + 16} y={y + h - KUBELET_ROW / 2 + 4} className="cv-sub cv-mono" style={{ fontSize: fz(10.5) }}>
                  kubelet
                </text>
                <text x={x + NW - PAD} y={y + h - KUBELET_ROW / 2 + 4} textAnchor="end" fill={TONE_TEXT[kube.tone]} style={{ fontSize: fz(10.5), fontWeight: 500 }}>
                  {fit(kube.word, NW / 2 - PAD, fz(10.5), { weight: 500 })}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* ------------ policy → selected Pods, above the Node cards so neighbours don't hide them */}
      <g fill="none" pointerEvents="none">
        {polEdges.map((e) => (
          <path key={e.key} d={e.d} stroke="#e11d48" strokeOpacity={0.45} strokeWidth={1.2} strokeDasharray="4 4" />
        ))}
      </g>

      {/* ------------ traffic: over the Node cards, under the Pods, so a request crossing a Node never draws over a Pod */}
      <g pointerEvents="none">
        {packets.map((p) => {
          const t0 = Math.min(1, (now - p.born) / PACKET_MS);
          const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - (-2 * t0 + 2) ** 2 / 2;
          const stop = p.ok ? 1 : 0.82;
          let pt: Pt | undefined;
          const se = p.serviceUid ? svcEdges.get(`${p.serviceUid}/${p.podUid}`) : undefined;
          const ie = p.ingressUid && p.serviceUid ? ingEdges.get(`${p.ingressUid}/${p.serviceUid}`) : undefined;
          if (ie && se) {
            // Ingress → Service, then Service → Pod.
            pt = t < 0.5 ? onCubic(ie.a, ie.c1, ie.c2, ie.b, t * 2) : onCubic(se.a, se.c1, se.c2, se.b, Math.min((t - 0.5) * 2, stop));
          } else if (se) pt = onCubic(se.a, se.c1, se.c2, se.b, Math.min(t, stop));
          else if (p.fromUid && podPos.has(p.fromUid) && podPos.has(p.podUid) && p.fromUid !== p.podUid) {
            const a = podTop(p.fromUid)!;
            const b = podTop(p.podUid)!;
            const mid = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 50 };
            const q = Math.min(t, stop);
            pt = lerp(lerp(a, mid, q), lerp(mid, b, q), q);
          } else {
            const b = podBottom(p.podUid);
            if (b) pt = { x: b.x, y: b.y + 60 * (1 - Math.min(t, stop)) };
          }
          if (!pt) return null;
          const fade = t0 > 0.85 ? (1 - t0) / 0.15 : 1;
          return (
            <g key={p.id} opacity={fade} className="cv-packet" aria-hidden="true">
              <circle cx={pt.x} cy={pt.y} r={3.5} fill={p.ok ? "var(--cv-flow)" : "var(--cv-danger)"} stroke="var(--cv-surface)" strokeWidth={1.5} />
              {p.blocked && t0 > 0.5 && <path d={`M${pt.x - 4},${pt.y - 12} l8,8 M${pt.x + 4},${pt.y - 12} l-8,8`} stroke="var(--cv-danger)" strokeWidth={1.8} strokeLinecap="round" />}
            </g>
          );
        })}
      </g>

      {/* ------------ pods */}
      {[...podPos.values()].map(({ x, y, pod }) => {
        const nodeName = pod.spec?.nodeName;
        const stale = !!nodeName && c.state.nodes[nodeName]?.up === false;
        const cat: PodCategory = stale && !pod.metadata.deletionTimestamp ? "stale" : podCategory(pod);
        const own = ownerOf(pod);
        const hue = hueFor(own?.name ?? pod.metadata.name);
        const base = own?.kind === "ReplicaSet" ? own.name : own?.kind === "StatefulSet" ? undefined : own?.name;
        const short = base && pod.metadata.name.startsWith(base) ? pod.metadata.name.slice(base.length + 1) || pod.metadata.name : pod.metadata.name;
        const sel = isSel("pod", pod.metadata.name, pod.metadata.namespace);
        const st = podStatus(pod);
        const ready = pod.status?.conditions?.find((q) => q.type === "Ready")?.status === "True";
        const status = CAT[cat].label ?? (st === "Running" && !ready ? "not ready" : st);
        const r = restarts(pod);
        const isolated = isIsolated(c, pod, "Ingress") || isIsolated(c, pod, "Egress");
        const hasVol = (pod.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim);
        const m = metrics.pods[pod.metadata.uid];
        const icons = (isolated ? 13 : 0) + (hasVol ? 13 : 0);
        const healthy = cat === "ok" && status === "Running";
        // The workload a Pod belongs to: its ReplicaSet's Deployment (the ReplicaSet name minus its hash), or its owner.
        const workload = own?.kind === "ReplicaSet" ? own.name.replace(/-[a-z0-9]{6,10}$/, "") : (own?.name ?? "standalone Pod");
        const rps = cat === "gone" ? 0 : podRate(pod.metadata.uid);
        return (
          <g
            key={pod.metadata.uid}
            data-kind="pod"
            className={cls("cv-obj cv-pod cursor-pointer", cat === "gone" && "cv-gone", cat === "bad" && "is-bad", cat === "starting" && "is-warn")}
            style={{ transform: `translate(${x}px, ${y}px)`, ...(moving ? { transition: "none" } : {}) }}
            opacity={dragged("pod", pod.metadata.namespace, pod.metadata.name) ? 0.35 : undefined}
            {...dnd(`pod:${pod.metadata.namespace}/${pod.metadata.name}`, { kind: "object", type: "pod", ns: pod.metadata.namespace ?? "default", name: pod.metadata.name, label: `Pod ${short}` })}
            onClick={click({ kind: "pod", ns: pod.metadata.namespace, name: pod.metadata.name })}
            {...act({ kind: "pod", ns: pod.metadata.namespace, name: pod.metadata.name }, `Pod ${pod.metadata.name}, ${status}${nodeName ? `, on ${nodeName}` : ", not scheduled"}${r ? `, ${r} restarts` : ""}${isolated ? ", isolated by a NetworkPolicy" : ""}`)}
          >
            <title>{`${pod.metadata.name}\n${st}${pod.status?.podIP ? ` · ${pod.status.podIP}` : ""}${m ? `\nCPU ${m.cpu}m · memory ${Math.round(m.memory / 2 ** 20)}Mi` : ""}${isolated ? "\nIsolated by a NetworkPolicy" : ""}`}</title>
            {hl(`pod:${pod.metadata.namespace}/${pod.metadata.name}`) && <rect x={-3} y={-3} width={CHIP_W + 6} height={CHIP_H + 6} rx={R} fill="var(--cv-danger)" fillOpacity={0.08} stroke="var(--cv-danger)" strokeWidth={2} strokeDasharray="5 3" />}
            {/* A new Pod lands with a ripple and a little pop. */}
            {cat !== "gone" && <rect className="cv-ripple" width={CHIP_W} height={CHIP_H} rx={R - 2} />}
            <g className="cv-pop">
            <rect className="cv-body cv-shadow" width={CHIP_W} height={CHIP_H} rx={R - 2} />
            {sel && <rect className="cv-ring" x={-3.5} y={-3.5} width={CHIP_W + 7} height={CHIP_H + 7} rx={R + 1} />}
            {/* Revision colour: Pods from the same ReplicaSet share it, so a rolling update shows old and new side by side. */}
            <rect x={0} y={12} width={3} height={CHIP_H - 24} rx={1.5} fill={cat === "stale" || cat === "gone" ? "var(--cv-muted)" : `hsl(${hue} 65% 55%)`} />
            {detail < 2 ? (
              detail > 0 && (
                <text x={14} y={CHIP_H / 2 + 5} className="cv-title cv-mono" style={{ fontSize: fz(13) }}>
                  {fit(short, CHIP_W - 24, fz(13), { mono: true, weight: 600 })}
                </text>
              )
            ) : (
              <>
                {/* Line 1: the Pod's own name and, while it serves, its request rate. */}
                <text x={14} y={21} className="cv-title cv-mono" style={{ fontSize: fz(13) }}>
                  {fit(short, CHIP_W - 24 - (rps ? textWidth(fmtRate(rps), fz(11.5), { mono: true, weight: 600 }) + 6 : 0), fz(13), { mono: true, weight: 600 })}
                </text>
                {rps > 0 && (
                  <text x={CHIP_W - 10} y={21} textAnchor="end" className="cv-mono" fill={podErr(pod.metadata.uid) >= 0.01 ? ERR : "var(--cv-flow)"} style={{ fontSize: fz(11.5), fontWeight: 600 }}>
                    {fmtRate(rps)}
                  </text>
                )}
                {/* Line 2: who owns it while all is well; what's wrong when it isn't. */}
                <Mark cat={cat} x={17.5} y={35} r={3} />
                <text x={26} y={39} fill={healthy ? "var(--cv-faint)" : CAT[cat].text} style={{ fontSize: fz(11.5), fontWeight: healthy ? 400 : 500 }}>
                  {fit(healthy ? workload : status, CHIP_W - 34 - icons - (r > 0 ? 30 : 0), fz(11.5), { weight: healthy ? 400 : 500 })}
                </text>
                {r > 0 && (
                  <text x={CHIP_W - 10 - icons} y={39} textAnchor="end" className="cv-mono" fill="var(--cv-danger-text)" style={{ fontSize: fz(11), fontWeight: 600 }}>
                    <title>{`${r} restart${r === 1 ? "" : "s"}`}</title>↻{r}
                  </text>
                )}
                {m && m.cpu > 0 && <rect x={10} y={CHIP_H - 4} width={Math.max(2, Math.min(1, m.cpu / Math.max(1, podRequests(pod.spec).cpu || 1000)) * (CHIP_W - 20))} height={2} rx={1} fill="var(--cv-k8s)" opacity={0.4} />}
                {isolated && <Shield x={CHIP_W - 20} y={30} />}
                {hasVol && <Cylinder x={CHIP_W - (isolated ? 33 : 20)} y={30} />}
              </>
            )}
            </g>
          </g>
        );
      })}

      {/* ------------ services */}
      {svcBoxes.map(({ s, x, y }) => {
        const ep = c.raw("Endpoints", s.metadata.namespace, s.metadata.name) as unknown as Endpoints | undefined;
        const ready = (ep?.subsets ?? []).reduce((a, sub) => a + (sub.addresses?.length ?? 0), 0);
        const sel = isSel("service", s.metadata.name, s.metadata.namespace);
        const hot = [...ingEdges.values()].some((e) => e.svcUid === s.metadata.uid && selIng?.metadata.uid === e.ingUid);
        const port = s.spec?.ports?.[0];
        const headless = s.spec?.clusterIP === "None";
        const lbIp = s.status?.loadBalancer?.ingress?.[0]?.ip;
        const sub = headless ? `headless · DNS → Pod IPs` : `${s.spec?.clusterIP}:${port?.port}${port?.nodePort ? ` · node :${port.nodePort}` : ""}${s.spec?.type === "LoadBalancer" ? ` · ${lbIp ?? "<pending>"}` : ""}`;
        const kindLine = headless ? "HEADLESS" : s.spec?.type === "NodePort" ? `NODEPORT${port?.nodePort ? ` :${port.nodePort}` : ""}` : s.spec?.type === "LoadBalancer" ? "LOADBALANCER" : "SERVICE";
        const rate = svcRate.get(s.metadata.uid) ?? 0;
        const err = svcErr.get(s.metadata.uid) ?? 0;
        // On the card, a failing Service shows just its error share (the rate rides on its wires).
        const traffic = err >= 0.01 ? `${Math.round(err * 100)}% err` : fmtRate(rate);
        return (
          <g key={s.metadata.uid} data-kind="service" className={cls("cv-obj cv-fade cursor-pointer", !ready && "is-warn", hot && "is-hot")} data-drop={`service:${s.metadata.namespace}/${s.metadata.name}`} {...mover(objKey("Service", s.metadata.namespace, s.metadata.name), { kind: "object", type: "service", ns: s.metadata.namespace ?? "default", name: s.metadata.name, label: `Service ${s.metadata.name}` })} onClick={click({ kind: "service", ns: s.metadata.namespace, name: s.metadata.name })} {...act({ kind: "service", ns: s.metadata.namespace, name: s.metadata.name }, `Service ${s.metadata.name}, ${headless ? "headless, " : ""}${ready} endpoints`)}>
            <title>{`Service ${s.metadata.name} · ${sub}`}</title>
            <rect className="cv-body" x={x} y={y} width={SVC_W} height={SVC_H} rx={R} />
            {sel && <rect className="cv-ring" x={x - 3.5} y={y - 3.5} width={SVC_W + 7} height={SVC_H + 7} rx={R + 3} />}
            {detail > 0 && (
              <>
                <text x={x + 16} y={y + 22} className="cv-kind" style={{ fontSize: fz(10) }}>
                  {kindLine}
                </text>
                <text x={x + SVC_W - 14} y={y + 22} textAnchor="end" fill={ready ? "var(--cv-faint)" : "var(--cv-danger-text)"} style={{ fontSize: fz(11.5), fontWeight: 500 }}>
                  {ready} endpoint{ready === 1 ? "" : "s"}
                </text>
              </>
            )}
            <text x={x + 16} y={detail ? y + 43 : y + 37} className="cv-title" style={{ fontSize: fz(15) }}>
              {fit(nsPrefix(s.metadata.namespace) + s.metadata.name, SVC_W - 30 - (detail && rate ? textWidth(traffic, fz(12), { mono: true, weight: 600 }) + 10 : 0), fz(15), { weight: 600 })}
            </text>
            {detail > 0 && rate > 0 && (
              <>
                <text x={x + SVC_W - 14} y={y + 43} textAnchor="end" className="cv-mono" fill={err >= 0.01 ? ERR : "var(--cv-flow)"} style={{ fontSize: fz(12), fontWeight: 600 }}>
                  {traffic}
                </text>
                <Spark x={x + R} y={y + SVC_H - 12} w={SVC_W - 2 * R} h={10} data={svcSeries(s.metadata.uid)} errs={svcSeries(s.metadata.uid, "errs")} />
              </>
            )}
          </g>
        );
      })}

      {/* ------------ ingresses */}
      {ingBoxes.map(({ ing, x, y }) => {
        const sel = isSel("ingress", ing.metadata.name, ing.metadata.namespace);
        const rules = (ing.spec?.rules ?? []).flatMap((r) => (r.http?.paths ?? []).map((p) => `${r.host ?? "*"}${p.path ?? "/"} → ${p.backend.service?.name ?? "?"}`));
        const addr = ing.status?.loadBalancer?.ingress?.[0]?.hostname ?? ing.status?.loadBalancer?.ingress?.[0]?.ip;
        const tag = addr ?? "no address";
        return (
          <g key={ing.metadata.uid} data-kind="ingress" className={cls("cv-obj cv-fade cursor-pointer", !addr && "is-warn")} {...mover(objKey("Ingress", ing.metadata.namespace, ing.metadata.name), item("ingress", ing.metadata.namespace, ing.metadata.name, `Ingress ${ing.metadata.name}`))} onClick={click({ kind: "ingress", ns: ing.metadata.namespace, name: ing.metadata.name })} {...act({ kind: "ingress", ns: ing.metadata.namespace, name: ing.metadata.name }, `Ingress ${ing.metadata.name}, ${rules.length} rules${addr ? `, address ${addr}` : ", no address yet"}`)}>
            <rect className="cv-body" x={x} y={y} width={ING_W} height={ING_H} rx={R} />
            {sel && <rect className="cv-ring" x={x - 3.5} y={y - 3.5} width={ING_W + 7} height={ING_H + 7} rx={R + 3} />}
            {detail > 0 && (
              <>
                <text x={x + 16} y={y + 22} className="cv-kind" style={{ fontSize: fz(10) }}>
                  INGRESS
                </text>
                <text x={x + ING_W - 14} y={y + 22} textAnchor="end" className="cv-mono" fill={addr ? "var(--cv-faint)" : "var(--cv-warn-text)"} style={{ fontSize: fz(11) }}>
                  {fit(tag, ING_W - 110, fz(11), { mono: true })}
                </text>
              </>
            )}
            <text x={x + 16} y={detail ? y + 43 : y + 37} className="cv-title" style={{ fontSize: fz(15) }}>
              {fit(nsPrefix(ing.metadata.namespace) + ing.metadata.name, 90, fz(15), { weight: 600 })}
            </text>
            {detail > 0 && (
              <text x={x + ING_W - 14} y={y + 43} textAnchor="end" className="cv-sub cv-mono" style={{ fontSize: fz(11) }}>
                {fit(rules[0] ? `${rules[0]}${rules.length > 1 ? ` +${rules.length - 1}` : ""}` : "default backend", ING_W - 130, fz(11), { mono: true })}
              </text>
            )}
          </g>
        );
      })}

      {/* ------------ config, storage, policies, access */}
      {sideItems.map((it) => {
        const sel = isSel(it.kind, it.name, it.ns);
        return (
          <g key={it.uid} data-kind={it.kind} className={cls("cv-obj cv-fade cursor-pointer", it.warn && "is-warn")} {...mover(`side:${it.kind}/${it.ns ?? ""}/${it.name}`, item(it.kind, it.ns, it.name, `${it.sub.split(" · ")[0]} ${it.name}`))} onClick={click({ kind: it.kind, ns: it.ns, name: it.name })} {...act({ kind: it.kind, ns: it.ns, name: it.name }, `${it.sub.split(" · ")[0]} ${it.name}, ${it.sub}`)}>
            <rect className="cv-body" x={it.x} y={it.y} width={SIDE_W} height={SIDE_H} rx={R} />
            {sel && <rect className="cv-ring" x={it.x - 3.5} y={it.y - 3.5} width={SIDE_W + 7} height={SIDE_H + 7} rx={R} />}
            <KindGlyph kind={it.kind} x={it.x + 12} y={it.y + 14} size={16} />
            <text x={it.x + 38} y={detail ? it.y + 19 : it.y + 27} className="cv-title" style={{ fontSize: fz(13) }}>
              {fit(it.title, SIDE_W - 48, fz(13), { weight: 600 })}
            </text>
            {detail > 0 && (
              <text x={it.x + 38} y={it.y + 35} className="cv-sub" style={{ fontSize: fz(11) }}>
                {fit(it.sub, SIDE_W - 48, fz(11))}
              </text>
            )}
          </g>
        );
      })}

      {/* ------------ live rates, above the packets so the numbers stay readable */}
      {rateLabels.map((l) => (
        <Rate s={T} key={l.key} x={l.x} y={l.y} text={l.text} bad={l.bad} />
      ))}

      <defs>
        <pattern id="cv-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="8" fill="#f59e0b" opacity="0.12" />
        </pattern>
      </defs>
    </PanZoom>
  );
}

function policySelects(c: Cluster, ns: string, name: string, p: Pod): boolean {
  const np = c.raw("NetworkPolicy", ns, name) as unknown as NetworkPolicy | undefined;
  if (!np || p.metadata.namespace !== ns) return false;
  const want = np.spec?.podSelector?.matchLabels ?? {};
  return Object.entries(want).every(([a, b]) => p.metadata.labels?.[a] === b);
}

const jobDone = (j: Job) => (j.status?.conditions ?? []).some((q) => q.type === "Complete" && q.status === "True");
const jobFailedFlag = (j: Job) => (j.status?.conditions ?? []).some((q) => q.type === "Failed" && q.status === "True");

function hpaTarget(h: HorizontalPodAutoscaler): string {
  const cur = h.status?.currentMetrics?.[0]?.resource?.current?.averageUtilization;
  const tgt = h.spec?.metrics?.[0]?.resource?.target.averageUtilization ?? 80;
  return `cpu ${cur !== undefined ? `${cur}%` : "?"}/${tgt}%`;
}

function cardSummary(c: Cluster, kind: TopKind, obj: TopCard["obj"]): { kindLabel: string; sub: string; status: string; tone: Tone } {
  switch (kind) {
    case "deployment": {
      const d = obj as Deployment;
      const want = d.spec?.replicas ?? 1;
      const ready = d.status?.readyReplicas ?? 0;
      const rolling = isRollingOut(c, d);
      return { kindLabel: "Deployment", sub: (d.spec?.template?.spec?.containers?.[0]?.image ?? ""), status: rolling ? `rolling out · ${ready}/${want}` : `${ready}/${want} ready`, tone: ready === want && !rolling ? "ok" : "warn" };
    }
    case "statefulset": {
      const s = obj as StatefulSet;
      const want = s.spec?.replicas ?? 1;
      const ready = s.status?.readyReplicas ?? 0;
      return { kindLabel: "StatefulSet", sub: `${(s.spec?.template?.spec?.containers?.[0]?.image ?? "")}${s.spec?.serviceName ? ` · svc ${s.spec.serviceName}` : ""}`, status: `${ready}/${want} ready`, tone: ready === want ? "ok" : "warn" };
    }
    case "daemonset": {
      const d = obj as DaemonSet;
      const want = d.status?.desiredNumberScheduled ?? 0;
      const ready = d.status?.numberReady ?? 0;
      return { kindLabel: "DaemonSet", sub: `${(d.spec?.template?.spec?.containers?.[0]?.image ?? "")} · one per node`, status: `${ready}/${want} nodes`, tone: ready === want ? "ok" : "warn" };
    }
    case "cronjob": {
      const cj = obj as CronJob;
      const active = cj.status?.active?.length ?? 0;
      return { kindLabel: "CronJob", sub: cj.spec!.schedule, status: cj.spec?.suspend ? "suspended" : active ? `${active} running` : "waiting", tone: cj.spec?.suspend ? "muted" : active ? "warn" : "ok" };
    }
    case "job": {
      const j = obj as Job;
      const want = j.spec?.completions ?? 1;
      const done = j.status?.succeeded ?? 0;
      return { kindLabel: "Job", sub: (j.spec?.template?.spec?.containers?.[0]?.image ?? ""), status: jobFailedFlag(j) ? "failed" : jobDone(j) ? `complete · ${done}/${want}` : `running · ${done}/${want}`, tone: jobFailedFlag(j) ? "bad" : jobDone(j) ? "ok" : "warn" };
    }
  }
}

function Bar({ x, y, w, frac, usage, label }: { x: number; y: number; w: number; frac: number; usage?: number; label: string }) {
  const lw = 24;
  const f = Math.min(1, frac);
  return (
    <g>
      <text x={x} y={y + 4} className="cv-sub" style={{ fontSize: 9 }}>
        {label}
      </text>
      <rect x={x + lw} y={y} width={w - lw} height={4} fill="var(--cv-hair)" />
      <rect x={x + lw} y={y} width={(w - lw) * f} height={4} fill={frac > 0.9 ? "var(--cv-warn)" : "var(--cv-line-2)"} />
      {usage !== undefined && <rect x={x + lw + (w - lw) * Math.min(1, usage) - 1} y={y - 1.5} width={2} height={7} fill="var(--cv-text)" />}
    </g>
  );
}

function Shield({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M5 0.5l4.5 1.6v3.3c0 2.8-2 4.6-4.5 5.6C2.5 10 0.5 8.2 0.5 5.4V2.1z" fill="#ffe4e6" stroke="#e11d48" strokeWidth={1} />
    </g>
  );
}

function Cylinder({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} fill="#dcfce7" stroke="#16a34a" strokeWidth={1}>
      <path d="M0.5 2v7c0 1 2 1.6 4.5 1.6S9.5 10 9.5 9V2" />
      <ellipse cx={5} cy={2} rx={4.5} ry={1.5} />
    </g>
  );
}

type Tone = "ok" | "warn" | "bad" | "muted";
type TagCat = Tone | "info" | "hpa" | "ingress";
const TAG_FS = 10.5;
const rateWidth = (text: string, s = 1) => textWidth(text, 10 * s, { mono: true, weight: 600 }) + 8 * s;
/** A live rate riding on a traffic wire. */
function Rate({ x, y, text, bad, s = 1 }: { x: number; y: number; text: string; bad?: boolean; s?: number }) {
  const w = rateWidth(text, s);
  return (
    <g pointerEvents="none">
      <rect x={x - w / 2} y={y - 8 * s} width={w} height={16 * s} rx={4} fill="var(--cv-bg)" />
      <text x={x} y={y + 3.5 * s} textAnchor="middle" className="cv-mono" fill={bad ? ERR : "var(--cv-flow)"} style={{ fontSize: 10 * s, fontWeight: 600 }}>
        {text}
      </text>
    </g>
  );
}

/** Recent requests as a faint area along the bottom of a card, newest on the right; the failed share in red on top. */
function Spark({ x, y, w, h, data, errs }: { x: number; y: number; w: number; h: number; data: number[]; errs?: number[] }) {
  const max = Math.max(1, ...data);
  const at = (v: number, i: number) => `${(x + (i / (data.length - 1)) * w).toFixed(1)},${(y + h - (v / max) * h * 0.9).toFixed(1)}`;
  const pts = data.map(at);
  const bad = errs?.some((v) => v > 0) ? errs.map((v, i) => at(Math.min(v, data[i]), i)) : undefined;
  return (
    <g pointerEvents="none">
      <polygon points={`${x},${y + h} ${pts.join(" ")} ${x + w},${y + h}`} fill="var(--cv-flow)" fillOpacity={0.08} />
      <polyline points={pts.join(" ")} fill="none" stroke="var(--cv-flow)" strokeOpacity={0.45} strokeWidth={1} strokeLinejoin="round" />
      {bad && <polygon points={`${x},${y + h} ${bad.join(" ")} ${x + w},${y + h}`} fill={ERR} fillOpacity={0.18} />}
    </g>
  );
}

/** `s` scales a tag with the Cluster View's text (see `fz`). */
const tagWidth = (text: string, s = 1) => textWidth(text, TAG_FS * s, { weight: 500 }) + 24 * s;

/** Health mark: colour AND shape, so it reads without colour vision. Disc ok, ring starting, square failing. */
function Mark({ cat, x, y, r = 3.5 }: { cat: PodCategory | TagCat; x: number; y: number; r?: number }) {
  if (cat === "bad") return <rect x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8} rx={0.8} className="cv-mark-bad cv-blink" />;
  if (cat === "starting" || cat === "warn") return <circle cx={x} cy={y} r={r - 0.6} className={`cv-mark-starting ${cat === "starting" ? "cv-pulse" : ""}`} />;
  if (cat === "gone" || cat === "stale") return <circle cx={x} cy={y} r={r - 0.6} className={`cv-mark-${cat}`} />;
  const fill = cat === "info" ? "var(--cv-text)" : cat === "hpa" || cat === "ingress" ? "var(--cv-text)" : cat === "done" || cat === "muted" ? "var(--cv-muted)" : "var(--cv-ok)";
  return <circle cx={x} cy={y} r={r} fill={fill} />;
}

/** Status tag: a quiet pill with a health mark. Width is measured, so text never spills. */
/** − n + under a workload card's right edge. Hangs off the card (a transparent bridge keeps the hover when the pointer crosses the gap). */
function Stepper({ x, y, value, on, label, onChange }: { x: number; y: number; value: number; on: boolean; label: string; onChange: (n: number) => void }) {
  const W = 92;
  const H = 26;
  const left = x - W;
  const top = y + 6;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const btn = (dx: number, delta: number, d: string, name: string) => (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${name} ${label}`}
      className="cv-step-btn"
      onPointerDown={stop}
      onClick={(e) => {
        stop(e);
        if (value + delta >= 0) onChange(value + delta);
      }}
      onKeyDown={(e) => {
        stop(e); // not the card's keys: Delete here mustn't delete the workload
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (value + delta >= 0) onChange(value + delta);
      }}
    >
      <rect x={left + dx} y={top} width={H} height={H} rx={8} fill="transparent" />
      <path d={d} transform={`translate(${left + dx + H / 2} ${top + H / 2})`} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" fill="none" opacity={delta < 0 && value === 0 ? 0.3 : 1} />
    </g>
  );
  return (
    <g className="cv-step" data-on={on || undefined}>
      <rect x={left} y={y} width={W} height={6} fill="transparent" />
      <rect x={left} y={top} width={W} height={H} rx={9} className="cv-step-body" />
      {btn(0, -1, "M-4.5 0h9", "Scale down")}
      <text x={left + W / 2} y={top + H / 2 + 4.5} textAnchor="middle" className="cv-mono" style={{ fontSize: 13, fontWeight: 600, fill: "var(--cv-text)" }}>
        {value}
      </text>
      {btn(W - H, 1, "M-4.5 0h9M0 -4.5v9", "Scale up")}
    </g>
  );
}

function Tag({ x, y, text, cat, anchor = "start", s = 1 }: { x: number; y: number; text: string; cat: TagCat; anchor?: "start" | "end" | "middle"; s?: number }) {
  const w = tagWidth(text, s);
  const h = 19 * s;
  const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
  return (
    <g pointerEvents="none">
      <rect x={x0} y={y} width={w} height={h} rx={h / 2} fill="var(--cv-surface)" stroke="var(--cv-hair)" />
      <Mark cat={cat} x={x0 + 10 * s} y={y + h / 2} r={3 * s} />
      <text x={x0 + 17 * s} y={y + h / 2 + 3.6 * s} className="cv-dim" style={{ fontSize: TAG_FS * s, fontWeight: 500 }}>
        {text}
      </text>
    </g>
  );
}

const GLYPH: Record<string, LucideIcon> = {
  deployment: Layers,
  statefulset: Database,
  daemonset: Server,
  cronjob: CalendarClock,
  job: Play,
  node: Server,
  cp: Hexagon,
  service: Network,
  ingress: Globe,
  configmap: FileText,
  secret: KeyRound,
  pvc: HardDrive,
  networkpolicy: ShieldCheck,
  rolebinding: UserCheck,
};

/** A lucide icon drawn straight into the diagram, in the object's kind colour. */
function KindGlyph({ kind, x, y, size = 16 }: { kind: string; x: number; y: number; size?: number }) {
  const G = GLYPH[kind] ?? Layers;
  return (
    <g className="cv-ink" pointerEvents="none">
      <G x={x} y={y} width={size} height={size} strokeWidth={1.75} aria-hidden />
    </g>
  );
}

/** Puts every moved card back in the automatic layout. */
function TidyButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="Tidy up: put every card back in the automatic layout" className="h-8 border-r border-ink/15 px-2.5 text-[12px] font-medium text-ink hover:bg-ink/[0.05]">
      Tidy up
    </button>
  );
}

"use client";

// Step-through Concept Illustration. A scene is a set of boxes and edges; each
// step highlights some of them, animates packets along "flow" edges, and shows
// a caption. Boxes can be nested regions (cluster, Node, namespace), Pod cards
// with a status, small component chips, or actors outside the cluster. A step
// can also introduce boxes (`add`) so the picture builds up. Contributors add a
// scene in ./scenes.ts and register it; nothing here needs to change.

import { useEffect, useId, useRef, useState } from "react";
import { crossing, edgePath, insideRect, type Pt, type Rect, type Side } from "./geometry";
import { ICON_DIR, LEGEND_H, statusTone, type StatusTone } from "./shared";

export type Tone = "slate" | "violet" | "blue" | "green" | "amber" | "red";

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  tone?: Tone;
  /** A container drawn behind other boxes (e.g. a Node). */
  group?: boolean;
  /** A tinted region with a header strip: the cluster, a Node, a namespace. Regions nested inside others are drawn darker. */
  region?: "cluster" | "node" | "namespace" | "pod";
  /** Id of the region this box sits in. Checked by the scene tests; drawing uses x/y/w/h only. */
  parent?: string;
  /** How to draw a box that is not a region: a Pod card (status bar and badge) or a small component chip. */
  kind?: "pod" | "chip";
  /** An actor outside the cluster (you with kubectl, a load balancer, a registry). Must lie outside the cluster region. */
  outside?: boolean;
  /** Name of an official Kubernetes icon in public/icons/k8s/, without `.svg`. Optional. */
  icon?: string;
  /** Status word shown on a Pod: Running and Ready are green, Pending and ContainerCreating amber, failures red. */
  status?: string;
  /** A Pod the scheduler has not yet placed. It must be drawn outside every Node region (the scene tests check). */
  unbound?: boolean;
  /** A Pod's containers, shown as chips inside the card in steps that list the Pod under `open`. */
  containers?: { name: string; sub?: string }[];
  /** Height of the Pod card when it is open. `h` is the closed height. */
  openH?: number;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Bend the line by this many px (perpendicular). */
  bend?: number;
  /** "traffic" (default): a solid line. "owns": a dashed line for logical ownership (Deployment owns ReplicaSet owns Pods). "blocked": red, dashed, with a cross: traffic that is refused. */
  kind?: "traffic" | "owns" | "blocked";
  /** Id of a region this edge enters or leaves: a marker is drawn where it crosses the region's boundary. */
  cross?: string;
  /** Leave the `from` box / enter the `to` box at the middle of this side, instead of along the line between their centres. */
  fromSide?: Side;
  toSide?: Side;
  /** Route with right angles (needs both sides): several edges from one box then share a bus line, like an org chart. */
  elbow?: boolean;
  /** Where the elbow's middle run sits (a y for down-across-down), so edges from one box share it. */
  bus?: number;
}

export interface Step {
  title: string;
  text: string;
  /** Box and edge ids to highlight. Everything else is dimmed. */
  on: string[];
  /** Edge ids that carry an animated packet this step. */
  flow?: string[];
  /** Boxes shown with an ✕ (e.g. a not-ready Pod). */
  off?: string[];
  /** Boxes and edges that appear from this step on. Anything no step adds is always drawn. */
  add?: string[];
  /** Set a box's status from this step on, e.g. { "web-2": "Running" }. */
  status?: Record<string, string>;
  /** Edges that are blocked (drawn red with a cross) from this step on, e.g. traffic a NetworkPolicy refuses. */
  block?: string[];
  /** Pods drawn open (showing their containers) in this step only. */
  open?: string[];
}

export interface Scene {
  id: string;
  title: string;
  width: number;
  height: number;
  boxes: Box[];
  edges: Edge[];
  steps: Step[];
  /** Draw a small key (solid = traffic, dashed = owns, ring = crosses the cluster boundary) along the bottom, listing only what is on screen. Leave 28px free there. */
  legend?: boolean;
}

// Drawn like a blueprint: ink lines on paper. Kinds are told apart by a faint
// ink fill; colour is kept for health only (green running, amber starting, red failing).
const INK = "var(--color-ink)";
const PAPER = "var(--color-paper)";
const SOFT = "var(--color-ink-soft)";
const LINE = "var(--ill-line)";
const TONES: Record<Tone, { fill: string; stroke: string; text: string; sub: string; on: string }> = {
  slate: { fill: PAPER, stroke: LINE, text: INK, sub: SOFT, on: INK },
  violet: { fill: "var(--ill-fill-6)", stroke: LINE, text: INK, sub: SOFT, on: INK },
  blue: { fill: "var(--ill-fill-4)", stroke: LINE, text: INK, sub: SOFT, on: INK },
  green: { fill: PAPER, stroke: "var(--ill-green-line)", text: INK, sub: "var(--color-green-700)", on: "var(--color-green-700)" },
  amber: { fill: PAPER, stroke: "var(--ill-amber-line)", text: INK, sub: "var(--color-amber-700)", on: "var(--color-amber-700)" },
  red: { fill: PAPER, stroke: "var(--ill-red-line)", text: INK, sub: "var(--color-red-700)", on: "var(--color-red-700)" },
};
const NS = "var(--ill-ns-line)";
const STATUS: Record<StatusTone, { bar: string; soft: string; text: string }> = {
  ok: { bar: "var(--ill-ok)", soft: "var(--ill-ok-soft)", text: "var(--ill-ok-text)" },
  warn: { bar: "var(--ill-warn)", soft: "var(--ill-warn-soft)", text: "var(--ill-warn-text)" },
  bad: { bar: "var(--ill-bad)", soft: "var(--ill-bad-soft)", text: "var(--ill-bad-text)" },
  idle: { bar: LINE, soft: "var(--ill-fill-6)", text: SOFT },
};
const STRIP = 26;
const MONO = "var(--font-geist-mono)";

/** The icon, if the box names one. */
function Icon({ name, x, y, size }: { name?: string; x: number; y: number; size: number }) {
  if (!name) return null;
  return <image href={`${ICON_DIR}${name}.svg`} x={x} y={y} width={size} height={size} aria-hidden />;
}

/** Closed or open, a Pod card is as tall as the step says. */
function drawn(b: Box, open: boolean): Rect {
  return { x: b.x, y: b.y, w: b.w, h: open && b.openH ? b.openH : b.h };
}

/** The scene's drawing for one step. */
function SceneSvg({ scene, i, className }: { scene: Scene; i: number; className?: string }) {
  const step = scene.steps[i];
  const on = new Set(step.on);
  const off = new Set(step.off ?? []);
  const flow = new Set(step.flow ?? []);
  const open = new Set(step.open ?? []);
  // A scene may build up: ids a step lists under `add` appear from that step on. Anything no step adds is always there.
  const addedAt = new Map<string, number>();
  scene.steps.forEach((s, k) => s.add?.forEach((id) => addedAt.has(id) || addedAt.set(id, k)));
  const shown = (id: string) => (addedAt.get(id) ?? 0) <= i;
  const isNew = (id: string) => addedAt.get(id) === i;
  const status = new Map<string, string>();
  scene.boxes.forEach((b) => b.status && status.set(b.id, b.status));
  scene.steps.slice(0, i + 1).forEach((s) => Object.entries(s.status ?? {}).forEach(([id, v]) => status.set(id, v)));
  const blocked = new Set<string>();
  scene.steps.slice(0, i + 1).forEach((s) => s.block?.forEach((id) => blocked.add(id)));
  const kindOf = (e: Edge) => (blocked.has(e.id) ? "blocked" : (e.kind ?? "traffic"));
  const byId = new Map(scene.boxes.map((b) => [b.id, b]));
  // A region is drawn only as tall as what is on screen in it (plus the padding it was drawn with), so early steps show no empty frame.
  const effCache = new Map<string, Rect>();
  const rectOf = (b: Box): Rect => (b.region ? effOf(b) : drawn(b, open.has(b.id)));
  function effOf(b: Box): Rect {
    const hit = effCache.get(b.id);
    if (hit) return hit;
    const kids = scene.boxes.filter((c) => c.parent === b.id);
    const full = (c: Box) => c.y + Math.max(c.h, c.openH ?? 0);
    const fullBottom = kids.length ? Math.max(...kids.map(full)) : b.y + STRIP;
    const pad = Math.max(6, b.y + b.h - fullBottom);
    const vis = kids.filter((c) => shown(c.id));
    const visBottom = vis.length ? Math.max(...vis.map((c) => (c.region ? effOf(c).y + effOf(c).h : full(c)))) : b.y + STRIP;
    const r = { x: b.x, y: b.y, w: b.w, h: Math.min(b.h, visBottom + pad - b.y) };
    effCache.set(b.id, r);
    return r;
  }
  const lit = (id: string) => on.size === 0 || on.has(id) || isNew(id);
  // Sizes are authored for a drawing that fills the 848px Concepts column; a narrower viewBox keeps its original 10px labels.
  const unit = scene.width / 848;
  const fs = unit >= 1 ? 12 * unit : 10;
  // Scenes drawn for the full column keep their dimmed parts readable (text stays legible at 12px).
  const dim = unit >= 1 ? 0.55 : 0.35;
  // The same scene can be drawn twice (inline and enlarged): keep marker/path ids unique.
  const pre = `${scene.id}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const regions = scene.boxes.filter((b) => b.region && shown(b.id)).sort((a, b) => b.w * b.h - a.w * a.h);
  const depth = (b: Box) => regions.filter((r) => r !== b && insideRect(r, { x: b.x + 1, y: b.y + 1 }) && b.x + b.w <= r.x + r.w + 0.5 && b.y + b.h <= r.y + r.h + 0.5).length;
  const visEdges = scene.edges.filter((e) => shown(e.id) && shown(e.from) && shown(e.to));
  const legend = scene.legend
    ? [
        visEdges.some((e) => kindOf(e) === "traffic") && { k: "traffic", text: "traffic" },
        visEdges.some((e) => kindOf(e) === "owns") && { k: "owns", text: "owns or refers to" },
        visEdges.some((e) => kindOf(e) === "blocked") && { k: "blocked", text: "blocked" },
        visEdges.some((e) => e.cross) && { k: "cross", text: "crosses the cluster boundary" },
      ].filter((x): x is { k: string; text: string } => !!x)
    : [];
  // A scene that builds up shows only what is on screen: crop to it (full width, so labels never move sideways).
  const modern = scene.boxes.some((b) => b.region || b.kind || b.outside);
  const vis = scene.boxes.filter((b) => shown(b.id) && (b.region || b.kind || b.outside || b.group));
  const top = modern && vis.length ? Math.max(0, Math.min(...vis.map((b) => b.y)) - 8) : 0;
  const bottom = modern && vis.length ? Math.min(scene.height, Math.max(...vis.map((b) => rectOf(b).y + rectOf(b).h)) + 8) : scene.height;
  const legendY = bottom + (legend.length ? 4 : 0);
  const viewH = legend.length ? legendY + LEGEND_H - top : bottom - top;
  return (
    <svg viewBox={`0 ${top} ${scene.width} ${viewH}`} className={className ?? "block w-full"} role="img" aria-label={`${scene.title}: ${step.title}. ${step.text}`}>
          <defs>
            <marker id={`arr-${pre}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" fill="context-stroke" />
            </marker>
          </defs>

          {scene.boxes
            .filter((b) => b.group && shown(b.id))
            .map((b) => {
              const t = TONES[b.tone ?? "slate"];
              return (
                <g key={b.id} className="ill-t" opacity={lit(b.id) ? 1 : 0.4}>
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.tone && b.tone !== "slate" ? t.fill : "var(--ill-wash)"} stroke={on.has(b.id) ? t.on : t.stroke} strokeDasharray="5 4" />
                  <text x={b.x + 12} y={b.y + 18} fill={t.sub} style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em" }}>
                    {b.label.toUpperCase()}
                  </text>
                </g>
              );
            })}

          {regions.map((b) => {
            const ns = b.region === "namespace";
            const d = depth(b);
            const r = b.region === "cluster" ? 14 : 10;
            const active = on.has(b.id);
            const eb = rectOf(b);
            return (
              <g key={b.id} className={isNew(b.id) ? "ill-t ill-add" : "ill-t"}>
                <rect x={eb.x} y={eb.y} width={eb.w} height={eb.h} rx={r} fill={ns ? "var(--ill-ns-fill)" : `rgb(var(--ink-rgb) / ${0.035 + 0.05 * d})`} stroke={active ? INK : ns ? NS : LINE} strokeWidth={active ? 1.8 : ns ? 1.5 : 1.2} strokeDasharray={ns ? "7 4" : undefined} />
                {!ns && <path d={`M${b.x},${b.y + STRIP} V${b.y + r} a${r},${r} 0 0 1 ${r},${-r} H${b.x + b.w - r} a${r},${r} 0 0 1 ${r},${r} V${b.y + STRIP} z`} fill={`rgb(var(--ink-rgb) / ${0.05 + 0.05 * d})`} />}
              </g>
            );
          })}

          {visEdges.map((e) => {
              const a = byId.get(e.from)!;
              const b = byId.get(e.to)!;
              const g = edgePath(rectOf(a), rectOf(b), e.bend, { fromSide: e.fromSide, toSide: e.toSide, elbow: e.elbow, bus: e.bus });
              const { d } = g;
              const ek = kindOf(e);
              const owns = ek === "owns";
              const bad = ek === "blocked";
              const edgeRegion = e.cross ? byId.get(e.cross) : undefined;
              const cross = edgeRegion ? crossing(g, edgeRegion) : null;
              // A line that enters the cluster carries its label outside, between the actor and the boundary.
              const far = edgeRegion && insideRect(edgeRegion, g.p) ? g.q : g.p;
              const mid: Pt = cross ? { x: (far.x + cross.pt.x) / 2, y: (far.y + cross.pt.y) / 2 } : g.mid;
              const active = on.has(e.id);
              const stroke = bad ? "var(--ill-bad)" : owns ? (active ? "var(--ill-ns-on)" : NS) : active ? INK : LINE;
              const lw = e.label ? e.label.length * fs * 0.6 + 12 : 0;
              return (
                <g key={e.id} className={isNew(e.id) ? "ill-t ill-add" : "ill-t"} opacity={lit(e.id) ? 1 : dim - 0.05}>
                  <path id={`${pre}-${e.id}`} d={d} fill="none" stroke={stroke} strokeWidth={active ? 1.8 : owns || bad ? 1.5 : 1.2} strokeDasharray={owns ? "5 4" : bad ? "4 3" : undefined} markerEnd={`url(#arr-${pre})`} />
                  {bad && (
                    <g stroke="var(--ill-bad)" strokeWidth={2} strokeLinecap="round">
                      <circle cx={g.mid.x} cy={g.mid.y} r={9} fill={PAPER} />
                      <path d={`M${g.mid.x - 4},${g.mid.y - 4} l8,8 M${g.mid.x + 4},${g.mid.y - 4} l-8,8`} />
                    </g>
                  )}
                  {cross && <circle cx={cross.pt.x} cy={cross.pt.y} r={5} fill={PAPER} stroke={active ? INK : SOFT} strokeWidth={2} />}
                  {e.label && (
                    <g>
                      <rect x={mid.x - lw / 2} y={mid.y - (fs + 8) / 2} width={lw} height={fs + 8} fill={PAPER} stroke={owns ? NS : active ? INK : LINE} />
                      <text x={mid.x} y={mid.y + fs * 0.35} textAnchor="middle" fill={active ? INK : SOFT} style={{ fontSize: fs, fontFamily: MONO }}>
                        {e.label}
                      </text>
                    </g>
                  )}
                  {flow.has(e.id) && (
                    <circle key={`${i}-${e.id}`} className="ill-packet" r={4.5} fill={INK} stroke={PAPER} strokeWidth={1.5}>
                      <animateMotion dur="1.6s" repeatCount="indefinite" rotate="auto">
                        <mpath href={`#${pre}-${e.id}`} />
                      </animateMotion>
                    </circle>
                  )}
                </g>
              );
            })}

          {/* Region titles sit above the edges, with a paper halo, so a line that crosses a header never runs through its words. */}
          {regions.map((b) => (
            <g key={b.id} className={isNew(b.id) ? "ill-t ill-add" : "ill-t"}>
              <Icon name={b.icon} x={b.x + 10} y={b.y + 4} size={18} />
              <text x={b.x + 10 + (b.icon ? 24 : 0)} y={b.y + 18} fill={b.region === "namespace" ? "var(--ill-ns-text)" : INK} stroke={PAPER} strokeWidth={4} strokeLinejoin="round" paintOrder="stroke" style={{ fontSize: 12, fontWeight: 600 }}>
                {b.label}
              </text>
              {b.sub && (
                <text x={b.x + b.w - 10} y={b.y + 18} textAnchor="end" fill={SOFT} stroke={PAPER} strokeWidth={4} strokeLinejoin="round" paintOrder="stroke" style={{ fontSize: 12, fontFamily: MONO }}>
                  {b.sub}
                </text>
              )}
            </g>
          ))}

          {scene.boxes
            .filter((b) => !b.group && !b.region && shown(b.id))
            .map((b) => {
              const t = TONES[b.tone ?? "slate"];
              const active = on.has(b.id);
              const isOff = off.has(b.id);
              const cls = isNew(b.id) ? "ill-t ill-add" : "ill-t";
              const op = lit(b.id) ? 1 : dim;
              const textFill = isOff ? "var(--ill-off)" : INK;

              if (b.kind === "pod") {
                const isOpen = open.has(b.id) && !!b.containers;
                const r = rectOf(b);
                const s = STATUS[statusTone(status.get(b.id))];
                const st = status.get(b.id);
                const bw = st ? st.length * 6.6 + 16 : 0;
                const pending = statusTone(st) === "warn";
                return (
                  <g key={b.id} className={cls} opacity={op}>
                    <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={8} fill={PAPER} stroke={active ? INK : LINE} strokeWidth={active ? 1.8 : 1} strokeDasharray={pending ? "5 3" : undefined} />
                    <rect x={r.x + 5} y={r.y + 8} width={4} height={r.h - 16} rx={2} fill={s.bar} />
                    <Icon name={b.icon ?? "pod"} x={r.x + 16} y={r.y + 7} size={18} />
                    <text x={r.x + 40} y={r.y + 21} fill={textFill} style={{ fontSize: 12, fontWeight: 600 }}>
                      {b.label}
                    </text>
                    {st && (
                      <g>
                        <rect x={r.x + 16} y={r.y + 31} width={bw} height={20} rx={10} fill={s.soft} stroke={s.bar} strokeWidth={1} />
                        <text x={r.x + 16 + bw / 2} y={r.y + 45} textAnchor="middle" fill={s.text} style={{ fontSize: 12, fontWeight: 600 }}>
                          {st}
                        </text>
                      </g>
                    )}
                    {b.sub && (
                      <text x={r.x + 16} y={r.y + 68} fill={SOFT} style={{ fontSize: 12, fontFamily: MONO }}>
                        {b.sub}
                      </text>
                    )}
                    {isOff && <path d={`M${r.x + r.w - 18},${r.y + 8} l8,8 M${r.x + r.w - 10},${r.y + 8} l-8,8`} stroke="var(--color-red-700)" strokeWidth={1.6} strokeLinecap="round" />}
                    {isOpen &&
                      b.containers!.map((c, k) => (
                        <g key={c.name}>
                          <rect x={r.x + 14} y={r.y + b.h + 2 + k * 30} width={r.w - 28} height={26} rx={6} fill={PAPER} stroke={s.bar} strokeWidth={1.2} />
                          <text x={r.x + 22} y={r.y + b.h + 19 + k * 30} fill={INK} style={{ fontSize: 12, fontWeight: 600 }}>
                            {c.name}
                            {c.sub && <tspan fill={SOFT} style={{ fontWeight: 400, fontFamily: MONO }}>{`  ${c.sub}`}</tspan>}
                          </text>
                        </g>
                      ))}
                  </g>
                );
              }

              if (b.kind === "chip" && b.icon && !b.sub && b.h >= 40 && !b.outside) {
                // A tall chip stacks its icon over its name.
                return (
                  <g key={b.id} className={cls} opacity={op}>
                    <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6} fill={PAPER} stroke={active ? INK : b.tone && b.tone !== "slate" ? t.stroke : LINE} strokeWidth={active ? 1.8 : 1} />
                    {isOff && <path d={`M${b.x + b.w - 16},${b.y + 6} l8,8 M${b.x + b.w - 8},${b.y + 6} l-8,8`} stroke="var(--color-red-700)" strokeWidth={1.6} strokeLinecap="round" />}
                    <Icon name={b.icon} x={b.x + b.w / 2 - 9} y={b.y + 6} size={18} />
                    <text x={b.x + b.w / 2} y={b.y + b.h - 8} textAnchor="middle" fill={textFill} style={{ fontSize: 12, fontWeight: 600 }}>
                      {b.label}
                    </text>
                  </g>
                );
              }

              if (b.kind === "chip" || b.outside) {
                const actor = !!b.outside;
                const size = actor ? 22 : 16;
                const textX = b.x + (b.icon ? (actor ? 38 : 26) : actor ? 12 : b.w / 2);
                const anchor = b.icon || actor ? "start" : "middle";
                const lineY = b.sub ? b.y + (actor ? 22 : b.h / 2 - 1) : b.y + b.h / 2 + 4;
                return (
                  <g key={b.id} className={cls} opacity={op}>
                    <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={actor ? 8 : 6} fill={PAPER} stroke={active ? INK : b.tone && b.tone !== "slate" ? t.stroke : actor ? SOFT : LINE} strokeWidth={active ? 1.8 : actor ? 1.5 : 1} />
                    {isOff && <path d={`M${b.x + b.w - 16},${b.y + 6} l8,8 M${b.x + b.w - 8},${b.y + 6} l-8,8`} stroke="var(--color-red-700)" strokeWidth={1.6} strokeLinecap="round" />}
                    <Icon name={b.icon} x={b.x + (actor ? 8 : 6)} y={b.y + (actor && b.sub ? 8 : (b.h - size) / 2)} size={size} />
                    <text x={textX} y={lineY} textAnchor={anchor} fill={textFill} style={{ fontSize: 12, fontWeight: 600 }}>
                      {b.label}
                    </text>
                    {b.sub && (
                      <text x={b.x + (b.icon || !actor ? textX - b.x : 12)} y={b.y + (actor ? 42 : b.h / 2 + 13)} textAnchor={anchor} fill={SOFT} style={{ fontSize: 12, fontFamily: MONO }}>
                        {b.sub}
                      </text>
                    )}
                  </g>
                );
              }

              const tx = b.x + b.w / 2 + (b.icon ? 11 : 0);
              return (
                <g key={b.id} className={cls} opacity={op}>
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={isOff ? PAPER : t.fill} stroke={active ? t.on : t.stroke} strokeWidth={active ? 1.8 : 1} />
                  <Icon name={b.icon} x={b.x + 8} y={b.y + b.h / 2 - 10} size={20} />
                  <text x={tx} y={b.y + (b.sub ? b.h / 2 - 2 : b.h / 2 + 4)} textAnchor="middle" fill={isOff ? "var(--ill-off)" : t.text} style={{ fontSize: 12, fontWeight: 600 }}>
                    {b.label}
                  </text>
                  {b.sub && (
                    <text x={tx} y={b.y + b.h / 2 + 13} textAnchor="middle" fill={isOff ? "var(--ill-off)" : t.sub} style={{ fontSize: 10 }}>
                      {b.sub}
                    </text>
                  )}
                  {isOff && <path d={`M${b.x + b.w - 16},${b.y + 8} l8,8 M${b.x + b.w - 8},${b.y + 8} l-8,8`} stroke="var(--color-red-700)" strokeWidth={1.6} strokeLinecap="round" />}
                </g>
              );
            })}
          {legend.length > 0 && (
            <g transform={`translate(6 ${legendY + 4})`} aria-hidden>
              {legend.reduce<{ x: number; els: React.ReactNode[] }>(
                (acc, it) => {
                  const w = 30 + it.text.length * 7.2;
                  acc.els.push(
                    <g key={it.k} transform={`translate(${acc.x} 0)`}>
                      {it.k === "cross" ? <circle cx={10} cy={8} r={5} fill={PAPER} stroke={SOFT} strokeWidth={2} /> : <path d="M0,8 H20" stroke={it.k === "owns" ? NS : it.k === "blocked" ? "var(--ill-bad)" : INK} strokeWidth={1.5} strokeDasharray={it.k === "owns" ? "5 4" : it.k === "blocked" ? "4 3" : undefined} />}
                      <text x={26} y={12} fill={SOFT} style={{ fontSize: 12 }}>
                        {it.text}
                      </text>
                    </g>,
                  );
                  acc.x += w + 16;
                  return acc;
                },
                { x: 0, els: [] },
              ).els}
            </g>
          )}
        </svg>
  );
}

/** Faint ink dot grid on paper behind the drawing. */
const DOTS: React.CSSProperties = { backgroundImage: "radial-gradient(circle, var(--ill-dots) 1px, transparent 1.2px)", backgroundSize: "18px 18px" };

/** A Concept Illustration inside a lesson step: collapsed to one ruled row until the learner asks for it. */
export function Illustration({ scene, defaultOpen = false }: { scene: Scene; /** Start expanded (e.g. on a page that is all diagrams). */ defaultOpen?: boolean }) {
  const [shown, setShown] = useState(defaultOpen);
  const [i, setI] = useState(0);
  const [big, setBig] = useState(false);
  const step = scene.steps[i];
  const n = scene.steps.length;
  const bodyId = `${useId()}-diagram`;
  const controls = (
    <div className="ml-auto flex shrink-0 gap-1.5">
      <button onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0} className="h-7 rounded-md border border-ink/15 bg-paper px-2.5 text-[12.5px] text-ink transition-colors hover:border-ink/40 disabled:opacity-40 disabled:hover:border-ink/30">
        ← Prev
      </button>
      <button onClick={() => setI(i === n - 1 ? 0 : i + 1)} className="h-7 border border-ink bg-ink px-2.5 text-[12.5px] text-paper transition-colors hover:bg-ink/90">
        {i === n - 1 ? "Replay" : "Next →"}
      </button>
    </div>
  );
  const caption = (
    <div key={i} className="cv-fade min-w-[240px] flex-1">
      <div className="text-[13.5px] font-medium text-ink">{step.title}</div>
      <p className="mt-0.5 text-[13px] leading-relaxed text-ink/85">{step.text}</p>
    </div>
  );

  return (
    <figure className="border-y border-ink/10 text-ink" aria-label={`Diagram: ${scene.title}`}>
      <div className="flex items-center">
        <button type="button" onClick={() => setShown(!shown)} aria-expanded={shown} aria-controls={bodyId} className="flex min-w-0 flex-1 items-baseline gap-2 px-1 py-2 text-left transition-colors hover:bg-ink/[0.04]">
          <span className="min-w-0 flex-1 text-[13.5px]">
            <span className="text-ink-soft">Diagram:</span> <span className="font-medium">{scene.title}</span> <span className="text-ink-soft">· {n} slides</span>
          </span>
          <span className="shrink-0 text-[12.5px] text-ink underline underline-offset-4">{shown ? "Hide" : "Show"}</span>
        </button>
        {shown && (
          <>
            <span className="ml-3 font-mono text-[11px] tabular-nums text-ink-soft">
              {i + 1}/{n}
            </span>
            <button onClick={() => setBig(true)} className="ml-2 min-h-6 rounded-md border border-ink/15 bg-paper px-1.5 py-0.5 text-[11.5px] text-ink transition-colors hover:border-ink/40" aria-label={`Enlarge the ${scene.title} illustration`} title="Enlarge">
              ⤢ Enlarge
            </button>
          </>
        )}
      </div>
      {shown && (
        <div id={bodyId} className="border-t border-ink/15">
          {/* Tapping the drawing opens it large: in a narrow column its labels are too small to read. */}
          <button type="button" onClick={() => setBig(true)} className="block w-full cursor-zoom-in bg-paper" style={DOTS} aria-label={`Enlarge the ${scene.title} illustration`}>
            <SceneSvg scene={scene} i={i} />
          </button>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-ink/15 px-1 py-3">
            {caption}
            {controls}
          </div>
        </div>
      )}
      {big && (
        <Lightbox title={`Concept · ${scene.title}`} onClose={() => setBig(false)}>
          <div className="min-h-0 flex-1 overflow-auto bg-paper" style={DOTS}>
            <SceneSvg scene={scene} i={i} className="mx-auto block h-full max-h-[70vh] w-full" />
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-ink/15 px-5 py-4">
            {caption}
            {controls}
          </div>
        </Lightbox>
      )}
    </figure>
  );
}

/** A modal over the page (native <dialog>: focus stays inside, Esc closes). */
function Lightbox({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label={title}
      className="font-sheet m-auto flex h-[min(92vh,900px)] w-[min(96vw,1200px)] max-w-none flex-col overflow-hidden rounded-xl border border-ink/10 bg-paper p-0 text-ink backdrop:bg-ink/40 [&:not([open])]:hidden"
    >
      <div className="flex items-center justify-between border-b border-ink/10 px-5 py-3">
        <div className="text-[14px] font-medium">{title}</div>
        <button onClick={onClose} className="rounded-md border border-ink/15 bg-paper px-2 py-0.5 text-[13px] text-ink transition-colors hover:border-ink/40" autoFocus>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}

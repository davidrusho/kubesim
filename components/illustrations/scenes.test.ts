import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { containsRect, crossing, curveHitsRect, edgePath, labelAt, rectsOverlap, type Rect } from "./geometry";
import { SceneSvg, type Box, type Scene } from "./Illustration";
import { resolve, type Resolved } from "./layout";
import { SCENES } from "./scenes";
import { statusTone } from "./shared";

const PUBLIC = join(import.meta.dir, "../../public");

/** A Pod is as tall as its open height, because the scene has to leave room for it. */
const full = (b: Box): Rect => ({ x: b.x, y: b.y, w: b.w, h: Math.max(b.h, b.openH ?? 0) });
const isNew = (s: Scene) => s.boxes.some((b) => b.region || b.kind || b.outside);
const leaf = (b: Box) => !b.region && !b.group;

/** The scene as it is in every step: positions after moves, what is shown, the rectangles drawn. */
function steps(scene: Scene): { i: number; R: Resolved }[] {
  return scene.steps.map((_, i) => ({ i, R: resolve(scene, i) }));
}
const edgeGeometry = (R: Resolved, e: Scene["edges"][number]) => edgePath(R.rectOf(R.byId.get(e.from)!), R.rectOf(R.byId.get(e.to)!), e.bend, e);
/** The rectangle of an edge label, placed as the drawing places it (12px mono, 7.2px a character). */
function labelRect(R: Resolved, e: Scene["edges"][number]): Rect {
  const region = e.cross ? R.rectOf(R.byId.get(e.cross)!) : undefined;
  const { mid } = labelAt(edgeGeometry(R, e), region);
  const w = e.label!.length * 7.2 + 12;
  return { x: mid.x - w / 2, y: mid.y - 10, w, h: 20 };
}
const visibleEdges = (scene: Scene, R: Resolved) => scene.edges.filter((e) => R.shown(e.id) && R.shown(e.from) && R.shown(e.to));

describe.each(Object.values(SCENES))("scene $id", (scene) => {
  const boxes = new Map(scene.boxes.map((b) => [b.id, b]));
  const edges = new Map(scene.edges.map((e) => [e.id, e]));
  const either = (id: string) => boxes.has(id) || edges.has(id);

  test("is registered under its own id", () => {
    expect(SCENES[scene.id]).toBe(scene);
  });

  test("ids are unique across boxes and edges", () => {
    const ids = [...scene.boxes.map((b) => b.id), ...scene.edges.map((e) => e.id)];
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test("edges point at existing boxes", () => {
    for (const e of scene.edges) {
      expect(boxes.has(e.from), `${e.id}.from ${e.from}`).toBe(true);
      expect(boxes.has(e.to), `${e.id}.to ${e.to}`).toBe(true);
    }
  });

  test("steps only name boxes and edges that exist", () => {
    for (const [k, s] of scene.steps.entries()) {
      const at = `step ${k + 1}`;
      for (const id of s.on) expect(either(id), `${at} on ${id}`).toBe(true);
      for (const id of s.add ?? []) expect(either(id), `${at} add ${id}`).toBe(true);
      for (const id of s.flow ?? []) expect(edges.has(id), `${at} flow ${id}`).toBe(true);
      for (const id of s.off ?? []) expect(boxes.has(id), `${at} off ${id}`).toBe(true);
      for (const id of s.block ?? []) expect(edges.has(id), `${at} block ${id}`).toBe(true);
      for (const id of Object.keys(s.status ?? {})) expect(boxes.get(id)?.kind, `${at} status ${id}`).toBe("pod");
      for (const id of Object.keys(s.sub ?? {})) expect(boxes.get(id)?.kind, `${at} sub ${id}`).toBe("chip");
      for (const [id, m] of Object.entries(s.move ?? {})) {
        expect(boxes.has(id), `${at} move ${id}`).toBe(true);
        if (m.parent) expect(boxes.get(m.parent)?.region, `${at} move ${id} into ${m.parent}`).toBeDefined();
      }
      for (const id of s.open ?? []) expect(boxes.get(id)?.containers?.length, `${at} open ${id}`).toBeGreaterThan(0);
    }
  });

  test("a step only uses what an earlier or the same step has added", () => {
    const addedAt = new Map<string, number>();
    scene.steps.forEach((s, k) => s.add?.forEach((id) => addedAt.has(id) || addedAt.set(id, k)));
    for (const [k, s] of scene.steps.entries()) {
      const used = [...s.on, ...(s.flow ?? []), ...(s.off ?? []), ...(s.open ?? []), ...Object.keys(s.status ?? {}), ...Object.keys(s.move ?? {}), ...Object.keys(s.sub ?? {})];
      for (const id of used) expect(addedAt.get(id) ?? 0, `step ${k + 1} uses ${id} before a step adds it`).toBeLessThanOrEqual(k);
    }
    for (const e of scene.edges) {
      if (!addedAt.has(e.id)) continue;
      expect(addedAt.get(e.from) ?? 0, `${e.id} before ${e.from}`).toBeLessThanOrEqual(addedAt.get(e.id)!);
      expect(addedAt.get(e.to) ?? 0, `${e.id} before ${e.to}`).toBeLessThanOrEqual(addedAt.get(e.id)!);
    }
  });

  test("in every step, every box lies in its parent region and every parent is on screen", () => {
    for (const { i, R } of steps(scene)) {
      for (const b of R.boxes.filter((x) => R.shown(x.id))) {
        if (!b.parent) continue;
        const parent = boxes.get(b.parent);
        expect(parent, `${b.id}.parent ${b.parent}`).toBeDefined();
        expect(!!(parent!.region || parent!.group), `${b.parent} is not a region`).toBe(true);
        expect(R.shown(b.parent), `step ${i + 1}: ${b.id} is on screen but its parent ${b.parent} is not`).toBe(true);
        expect(containsRect(parent!, full(b)), `step ${i + 1}: ${b.id} sticks out of ${b.parent}`).toBe(true);
        if (parent!.region && parent!.region !== "namespace") expect(b.y, `step ${i + 1}: ${b.id} overlaps ${parent!.id}'s header`).toBeGreaterThanOrEqual(parent!.y + 26);
      }
    }
  });

  test("actors marked outside lie outside the cluster", () => {
    const cluster = scene.boxes.find((b) => b.region === "cluster");
    for (const b of scene.boxes.filter((x) => x.outside)) {
      expect(cluster, `${scene.id} has outside actors but no cluster region`).toBeDefined();
      expect(rectsOverlap(cluster!, full(b)), `${b.id} overlaps the cluster`).toBe(false);
      expect(b.parent, `${b.id} is outside, so it has no parent`).toBeUndefined();
    }
  });

  test("an edge that crosses a region really crosses its boundary, and the region exists", () => {
    const last = resolve(scene, scene.steps.length - 1);
    for (const e of scene.edges.filter((x) => x.cross)) {
      const region = boxes.get(e.cross!);
      expect(region?.region, `${e.id}.cross ${e.cross} is not a region`).toBeDefined();
      expect(crossing(edgeGeometry(last, e), last.rectOf(last.byId.get(e.cross!)!)), `${e.id} never crosses ${e.cross}`).not.toBeNull();
    }
  });

  test("an edge between an outside actor and the cluster declares where it crosses", () => {
    for (const e of scene.edges) {
      const a = boxes.get(e.from)!;
      const b = boxes.get(e.to)!;
      if (!!a.outside !== !!b.outside && !(a.outside && b.outside)) expect(e.cross, `${e.id} enters the cluster without a marker`).toBeDefined();
    }
  });

  test("icons exist as files", () => {
    for (const b of scene.boxes) {
      if (b.icon) expect(existsSync(join(PUBLIC, "icons/k8s", `${b.icon}.svg`)), `public/icons/k8s/${b.icon}.svg`).toBe(true);
    }
  });

  test("Pod statuses are words the drawing colours", () => {
    const words = [...scene.boxes.map((b) => b.status), ...scene.steps.flatMap((s) => Object.values(s.status ?? {}))];
    for (const w of words) if (w && !/^v\d/.test(w)) expect(statusTone(w), `status "${w}"`).not.toBe("idle");
  });

  test("opened Pods have room for their containers", () => {
    for (const b of scene.boxes.filter((x) => x.containers)) {
      expect(b.openH, `${b.id} lists containers but has no openH`).toBeDefined();
      expect(b.h + 2 + b.containers!.length * 30, `${b.id}: containers do not fit in openH`).toBeLessThanOrEqual(b.openH!);
    }
  });

  // The rendered drawing: what the Learner actually sees in every step.
  test("the rendered frame is the same in every step and holds everything shown", () => {
    const frames = new Set<string>();
    for (const { i, R } of steps(scene)) {
      const html = renderToStaticMarkup(createElement(SceneSvg, { scene, i }));
      const vb = /viewBox="([^"]+)"/.exec(html)?.[1];
      expect(vb, `step ${i + 1} has a viewBox`).toBeDefined();
      frames.add(vb!);
      const [x, y, w, h] = vb!.split(" ").map(Number);
      const frame = { x, y, w, h };
      for (const b of R.boxes.filter((bb) => R.shown(bb.id))) expect(containsRect(frame, R.rectOf(b)), `step ${i + 1}: ${b.id} is outside the frame`).toBe(true);
      for (const e of visibleEdges(scene, R).filter((ee) => ee.label)) expect(containsRect(frame, labelRect(R, e), 1), `step ${i + 1}: label of ${e.id} is outside the frame`).toBe(true);
    }
    expect([...frames], `${scene.id} changes its frame between steps`).toHaveLength(1);
  });

  test("a legend appears when the step shows a kind of line that needs a key", () => {
    for (const { i, R } of steps(scene)) {
      const html = renderToStaticMarkup(createElement(SceneSvg, { scene, i }));
      const blocked = new Set(scene.steps.slice(0, i + 1).flatMap((s) => s.block ?? []));
      const kinds = new Set(visibleEdges(scene, R).map((e) => (blocked.has(e.id) ? "blocked" : (e.kind ?? "traffic"))));
      const needs: [string, boolean][] = [
        ["owns or refers to", kinds.has("owns")],
        ["blocked", kinds.has("blocked")],
        ["watches", kinds.has("watch")],
        ["crosses the cluster boundary", visibleEdges(scene, R).some((e) => e.cross)],
      ];
      for (const [text, wanted] of needs) {
        if (!wanted) continue;
        expect(scene.legend, `${scene.id} draws "${text}" lines but has no legend`).toBe(true);
        expect(html.includes(text), `step ${i + 1} shows ${text} without its legend entry`).toBe(true);
      }
    }
  });

  // The new drawing styles are held to a layout standard the original boxes-and-arrows scenes were never written to.
  if (isNew(scene)) {
    test("text fits inside its box (12px sans is about 6.6px a character, mono 7.2px)", () => {
      const sans = (t?: string) => (t ? t.length * 6.6 : 0);
      const mono = (t?: string) => (t ? t.length * 7.2 : 0);
      for (const b of scene.boxes) {
        if (b.group) continue;
        const statuses = [b.status, ...scene.steps.map((st) => st.status?.[b.id])].filter(Boolean) as string[];
        const subs = [b.sub, ...scene.steps.map((st) => st.sub?.[b.id])].filter(Boolean) as string[];
        const subW = Math.max(0, ...subs.map(mono));
        let need: number;
        if (b.region) need = 10 + (b.icon ? 24 : 0) + sans(b.label) + (b.sub ? mono(b.sub) + 20 : 0) + 10;
        else if (b.kind === "pod") need = Math.max(40 + b.label.length * 7.2 + 8, 16 + subW + 8, ...statuses.map((x) => 32 + sans(x)), ...(b.containers ?? []).map((c) => 28 + 8 + sans(c.name) + 8));
        else if (b.kind === "chip" && b.icon && !b.sub && b.h >= 40) need = sans(b.label) + 12;
        else if (b.kind === "chip" || b.outside) {
          const x0 = b.icon ? (b.outside ? 38 : 26) : b.outside ? 12 : 0;
          need = b.icon || b.outside ? x0 + Math.max(sans(b.label), subW) + 8 : Math.max(sans(b.label), subW) + 16;
        } else continue;
        expect(b.w, `${b.id} (${b.label}) needs about ${Math.round(need)}px`).toBeGreaterThanOrEqual(need);
      }
    });

    test("in every step, boxes do not overlap and no edge runs through a box it does not connect", () => {
      for (const { i, R } of steps(scene)) {
        const leaves = R.boxes.filter((b) => R.shown(b.id) && leaf(b));
        for (let a = 0; a < leaves.length; a++) {
          for (let c = a + 1; c < leaves.length; c++) expect(rectsOverlap(R.rectOf(leaves[a]), R.rectOf(leaves[c])), `step ${i + 1}: ${leaves[a].id} overlaps ${leaves[c].id}`).toBe(false);
        }
        for (const e of visibleEdges(scene, R)) {
          const g = edgeGeometry(R, e);
          for (const b of leaves) if (b.id !== e.from && b.id !== e.to) expect(curveHitsRect(g, R.rectOf(b)), `step ${i + 1}: ${e.id} runs through ${b.id}`).toBe(false);
        }
      }
    });

    test("an edge leaves room for its label, and the label covers no box that is not one of its ends", () => {
      for (const { i, R } of steps(scene)) {
        for (const e of visibleEdges(scene, R).filter((x) => x.label)) {
          const g = edgeGeometry(R, e);
          const len = Math.hypot(g.q.x - g.p.x, g.q.y - g.p.y);
          const horizontal = Math.abs(g.q.x - g.p.x) > Math.abs(g.q.y - g.p.y);
          const need = e.cross ? 0 : horizontal ? e.label!.length * 7.2 + 12 + 4 : 28;
          expect(len, `${e.id} is too short for "${e.label}"`).toBeGreaterThanOrEqual(need);
          const lr = labelRect(R, e);
          for (const b of R.boxes.filter((x) => R.shown(x.id) && leaf(x) && x.id !== e.from && x.id !== e.to)) {
            expect(rectsOverlap(lr, R.rectOf(b)), `step ${i + 1}: the label "${e.label}" of ${e.id} covers ${b.id}`).toBe(false);
          }
        }
      }
    });

    test("a Pod that a step moves onto a Node, or that is Pending outside one, is marked unbound; an unbound Pod stays off every Node until it is moved", () => {
      const nodes = scene.boxes.filter((b) => b.region === "node");
      const isNode = (id?: string) => !!id && nodes.some((n) => n.id === id);
      const movedOnto = new Set(scene.steps.flatMap((st) => Object.entries(st.move ?? {}).filter(([, m]) => isNode(m.parent)).map(([id]) => id)));
      for (const p of scene.boxes.filter((b) => b.kind === "pod")) {
        const pending = steps(scene).some(({ R }) => R.shown(p.id) && /^pending/i.test(R.byId.get(p.id)!.status ?? "") && !nodes.some((n) => containsRect(n, full(R.byId.get(p.id)!))));
        if (movedOnto.has(p.id) || pending) expect(p.unbound, `${p.id} is ${movedOnto.has(p.id) ? "moved onto a Node" : "Pending outside every Node"}, so it needs unbound: true`).toBe(true);
        if (!p.unbound) continue;
        let placed = false;
        for (const { i, R } of steps(scene)) {
          if (!R.shown(p.id)) continue;
          const now = R.byId.get(p.id)!;
          if (isNode(now.parent)) placed = true;
          if (!placed) expect(nodes.some((n) => rectsOverlap(n, full(now))), `step ${i + 1}: ${p.id} is unbound but overlaps a Node`).toBe(false);
          if (placed) expect(nodes.some((n) => containsRect(n, full(now))), `step ${i + 1}: ${p.id} is placed on a Node but is not inside it`).toBe(true);
          // A Pod whose containers are starting or running has been scheduled.
          if (/^(containercreating|running)/i.test(now.status ?? "")) expect(placed, `step ${i + 1}: ${p.id} is ${now.status} but not on a Node`).toBe(true);
        }
      }
    });

    test("no Pod straddles a Node's edge", () => {
      const nodes = scene.boxes.filter((b) => b.region === "node");
      for (const { i, R } of steps(scene)) {
        for (const p of R.boxes.filter((b) => R.shown(b.id) && b.kind === "pod")) {
          for (const n of nodes) if (rectsOverlap(n, full(p))) expect(containsRect(n, full(p)), `step ${i + 1}: ${p.id} straddles ${n.id}`).toBe(true);
        }
      }
    });
  }
});

describe("the converted scenes use the new capabilities", () => {
  test("architecture and service nest Pods inside Nodes inside the cluster, with actors outside", () => {
    for (const id of ["architecture", "service"]) {
      const s = SCENES[id];
      expect(s.boxes.some((b) => b.region === "cluster")).toBe(true);
      expect(s.boxes.some((b) => b.region === "node")).toBe(true);
      expect(s.boxes.some((b) => b.kind === "pod" && b.parent)).toBe(true);
      expect(s.boxes.some((b) => b.outside)).toBe(true);
      expect(s.edges.some((e) => e.cross)).toBe(true);
    }
    expect(SCENES.service.edges.some((e) => e.kind === "owns")).toBe(true);
  });

  test("apply, scheduling and pv-pvc each move a Pod onto a Node, and flag it unbound", () => {
    for (const id of ["apply", "scheduling", "pv-pvc"]) {
      const sc = SCENES[id];
      const nodeIds = new Set(sc.boxes.filter((b) => b.region === "node").map((b) => b.id));
      const moved = sc.steps.flatMap((st) => Object.entries(st.move ?? {}).filter(([, m]) => m.parent && nodeIds.has(m.parent)).map(([pid]) => pid));
      expect(moved.length, `${id} moves no Pod onto a Node`).toBeGreaterThan(0);
      for (const pid of moved) expect(sc.boxes.find((b) => b.id === pid)?.unbound, `${id}: ${pid}`).toBe(true);
    }
  });

  test("the Kubernetes icon licence and attribution ship with the icons", () => {
    expect(existsSync(join(PUBLIC, "icons/k8s/ATTRIBUTION.md"))).toBe(true);
    expect(existsSync(join(PUBLIC, "../NOTICE.md"))).toBe(true);
  });
});

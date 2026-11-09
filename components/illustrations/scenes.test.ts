import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { containsRect, crossing, curveHitsRect, edgePath, rectsOverlap, type Rect } from "./geometry";
import type { Box, Scene } from "./Illustration";
import { SCENES } from "./scenes";
import { statusTone } from "./shared";

const PUBLIC = join(import.meta.dir, "../../public");

/** A Pod is as tall as its open height, because the scene has to leave room for it. */
const full = (b: Box): Rect => ({ x: b.x, y: b.y, w: b.w, h: Math.max(b.h, b.openH ?? 0) });
const closed = (b: Box): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });
const isNew = (s: Scene) => s.boxes.some((b) => b.region || b.kind || b.outside);

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
      for (const id of s.open ?? []) expect(boxes.get(id)?.containers?.length, `${at} open ${id}`).toBeGreaterThan(0);
    }
  });

  test("a step that animates or highlights something shows it", () => {
    // Everything a step names must already be drawn in that step: added by it or an earlier one, or never added at all.
    const addedAt = new Map<string, number>();
    scene.steps.forEach((s, k) => s.add?.forEach((id) => addedAt.has(id) || addedAt.set(id, k)));
    for (const [k, s] of scene.steps.entries()) {
      for (const id of [...s.on, ...(s.flow ?? []), ...(s.off ?? []), ...(s.open ?? []), ...Object.keys(s.status ?? {})]) {
        expect(addedAt.get(id) ?? 0, `step ${k + 1} uses ${id} before a step adds it`).toBeLessThanOrEqual(k);
      }
      // An edge cannot appear before both of its ends.
      for (const e of scene.edges) {
        if (addedAt.has(e.id)) {
          expect(addedAt.get(e.from) ?? 0, `${e.id} before ${e.from}`).toBeLessThanOrEqual(addedAt.get(e.id)!);
          expect(addedAt.get(e.to) ?? 0, `${e.id} before ${e.to}`).toBeLessThanOrEqual(addedAt.get(e.id)!);
        }
      }
    }
  });

  test("every box lies inside the viewBox", () => {
    for (const b of scene.boxes) expect(containsRect({ x: 0, y: 0, w: scene.width, h: scene.height }, full(b)), `${b.id} leaves the drawing`).toBe(true);
  });

  test("child boxes lie inside their parent region", () => {
    for (const b of scene.boxes) {
      if (!b.parent) continue;
      const parent = boxes.get(b.parent);
      expect(parent, `${b.id}.parent ${b.parent}`).toBeDefined();
      expect(!!(parent!.region || parent!.group), `${b.parent} is not a region`).toBe(true);
      expect(containsRect(parent!, full(b)), `${b.id} sticks out of ${b.parent}`).toBe(true);
    }
  });

  test("a region's children do not run into its header strip", () => {
    for (const b of scene.boxes) {
      const parent = b.parent ? boxes.get(b.parent) : undefined;
      if (parent?.region && parent.region !== "namespace") expect(b.y, `${b.id} overlaps ${parent.id}'s header`).toBeGreaterThanOrEqual(parent.y + 26);
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
    for (const e of scene.edges.filter((x) => x.cross)) {
      const region = boxes.get(e.cross!);
      expect(region?.region, `${e.id}.cross ${e.cross} is not a region`).toBeDefined();
      const g = edgePath(closed(boxes.get(e.from)!), closed(boxes.get(e.to)!), e.bend, e);
      expect(crossing(g, region!), `${e.id} never crosses ${e.cross}`).not.toBeNull();
    }
  });

  test("an edge from an outside actor into the cluster declares where it crosses", () => {
    for (const e of scene.edges) {
      const a = boxes.get(e.from)!;
      const b = boxes.get(e.to)!;
      if (a.outside !== b.outside && (a.outside || b.outside) && !(a.outside && b.outside)) expect(e.cross, `${e.id} enters the cluster without a marker`).toBeDefined();
    }
  });

  test("a scene with a legend leaves 28px free at the bottom", () => {
    if (!scene.legend) return;
    const bottom = Math.max(...scene.boxes.map((b) => full(b).y + full(b).h));
    expect(scene.height - bottom, `${scene.id} has no room for its legend`).toBeGreaterThanOrEqual(28);
  });

  test("icons exist as files", () => {
    for (const b of scene.boxes) {
      if (b.icon) expect(existsSync(join(PUBLIC, "icons/k8s", `${b.icon}.svg`)), `public/icons/k8s/${b.icon}.svg`).toBe(true);
    }
  });

  test("Pod statuses are words the drawing colours", () => {
    const words = [...scene.boxes.map((b) => b.status), ...scene.steps.flatMap((s) => Object.values(s.status ?? {}))];
    // A version number ("v1.36") is a status too, drawn grey.
    for (const w of words) if (w && !/^v\d/.test(w)) expect(statusTone(w), `status "${w}"`).not.toBe("idle");
  });

  // The new drawing styles are held to a layout standard the original boxes-and-arrows scenes were never written to.
  if (isNew(scene)) {
    test("sibling boxes do not overlap", () => {
      const leaves = scene.boxes.filter((b) => !b.region && !b.group);
      for (let i = 0; i < leaves.length; i++) {
        for (let j = i + 1; j < leaves.length; j++) {
          expect(rectsOverlap(full(leaves[i]), full(leaves[j])), `${leaves[i].id} overlaps ${leaves[j].id}`).toBe(false);
        }
      }
    });

    test("no edge runs through a box it does not connect", () => {
      const leaves = scene.boxes.filter((b) => !b.region && !b.group);
      for (const e of scene.edges) {
        const g = edgePath(closed(boxes.get(e.from)!), closed(boxes.get(e.to)!), e.bend, e);
        for (const b of leaves) {
          if (b.id === e.from || b.id === e.to) continue;
          expect(curveHitsRect(g, closed(b)), `${e.id} runs through ${b.id}`).toBe(false);
        }
      }
    });

    test("text fits inside its box (12px sans is about 6.6px a character, mono 7.2px)", () => {
      const sans = (t?: string) => (t ? t.length * 6.6 : 0);
      const mono = (t?: string) => (t ? t.length * 7.2 : 0);
      for (const b of scene.boxes) {
        if (b.group) continue;
        const statuses = [b.status, ...scene.steps.map((st) => st.status?.[b.id])].filter(Boolean) as string[];
        let need: number;
        if (b.region) need = 10 + (b.icon ? 24 : 0) + sans(b.label) + (b.sub ? mono(b.sub) + 20 : 0) + 10;
        else if (b.kind === "pod") need = Math.max(40 + sans(b.label) + 8, 16 + mono(b.sub) + 8, ...statuses.map((x) => 32 + sans(x)), ...(b.containers ?? []).map((c) => 28 + 8 + sans(c.name) + 8));
        else if (b.kind === "chip" && b.icon && !b.sub && b.h >= 40) need = sans(b.label) + 12;
        else if (b.kind === "chip" || b.outside) {
          const x0 = b.icon ? (b.outside ? 38 : 26) : b.outside ? 12 : 0;
          need = b.icon || b.outside ? x0 + Math.max(sans(b.label), mono(b.sub)) + 8 : Math.max(sans(b.label), mono(b.sub)) + 16;
        } else continue;
        expect(b.w, `${b.id} (${b.label}) needs about ${Math.round(need)}px`).toBeGreaterThanOrEqual(need);
      }
    });

    test("labelled edges leave room for their label", () => {
      for (const e of scene.edges.filter((x) => x.label)) {
        const g = edgePath(closed(boxes.get(e.from)!), closed(boxes.get(e.to)!), e.bend, e);
        const len = Math.hypot(g.q.x - g.p.x, g.q.y - g.p.y);
        // A label is about 7px a character at 12px, plus the line has to be at least as long as the label.
        const horizontal = Math.abs(g.q.x - g.p.x) > Math.abs(g.q.y - g.p.y);
        const need = e.cross ? 0 : horizontal ? e.label!.length * 7.2 + 12 + 4 : 28;
        expect(len, `${e.id} is too short for "${e.label}"`).toBeGreaterThanOrEqual(need);
      }
    });
  }
});

describe("an unscheduled Pod is not on a Node", () => {
  test("in scheduling, a Pending Pod sits outside every Node region", () => {
    const s = SCENES.scheduling;
    const nodes = s.boxes.filter((b) => b.region === "node");
    const pending = s.boxes.filter((b) => b.kind === "pod" && b.status === "Pending");
    expect(pending.length).toBeGreaterThan(0);
    for (const p of pending) for (const n of nodes) expect(containsRect(n, full(p)), `${p.id} is Pending but drawn inside ${n.id}`).toBe(false);
  });
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

  test("the Kubernetes icon licence and attribution ship with the icons", () => {
    expect(existsSync(join(PUBLIC, "icons/k8s/ATTRIBUTION.md"))).toBe(true);
    expect(existsSync(join(PUBLIC, "../NOTICE.md"))).toBe(true);
  });
});

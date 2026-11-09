// Where everything is in one step of a scene: which boxes are on screen, where
// moved boxes sit, what each Pod's status and each chip's subtitle say, and how
// tall a region is (only as tall as what is in it). Pure, so the scene tests can
// check the same layout the drawing uses. The drawing's frame is constant: the
// union of every step's content, so the figure never changes height between steps.

import type { Rect } from "./geometry";
import type { Box, Scene } from "./Illustration";

export const STRIP = 26;
export const LEGEND_H = 24;

export interface Resolved {
  /** Every box as it is in this step: moved ones at their new place, with this step's status and subtitle. */
  boxes: Box[];
  byId: Map<string, Box>;
  shown: (id: string) => boolean;
  isNew: (id: string) => boolean;
  open: Set<string>;
  blocked: Set<string>;
  rectOf: (b: Box) => Rect;
  /** The frame every step of the scene is drawn in. */
  view: { top: number; bottom: number };
}

const fullH = (b: Box) => Math.max(b.h, b.openH ?? 0);

/** Can this scene's content be cropped and its regions shrunk? (Scenes drawn the original way are drawn whole.) */
export function isModern(scene: Scene): boolean {
  return scene.boxes.some((b) => b.region || b.kind || b.outside);
}

function resolveStep(scene: Scene, i: number): Omit<Resolved, "view"> {
  const step = scene.steps[i];
  const addedAt = new Map<string, number>();
  scene.steps.forEach((s, k) => s.add?.forEach((id) => addedAt.has(id) || addedAt.set(id, k)));
  const shown = (id: string) => (addedAt.get(id) ?? 0) <= i;
  const isNew = (id: string) => addedAt.get(id) === i;
  const open = new Set(step.open ?? []);
  const blocked = new Set<string>();
  const status = new Map<string, string>();
  const sub = new Map<string, string>();
  const place = new Map<string, { x: number; y: number; parent?: string }>();
  scene.boxes.forEach((b) => {
    if (b.status) status.set(b.id, b.status);
  });
  scene.steps.slice(0, i + 1).forEach((s) => {
    s.block?.forEach((id) => blocked.add(id));
    Object.entries(s.status ?? {}).forEach(([id, v]) => status.set(id, v));
    Object.entries(s.sub ?? {}).forEach(([id, v]) => sub.set(id, v));
    Object.entries(s.move ?? {}).forEach(([id, m]) => place.set(id, m));
  });
  const boxes = scene.boxes.map((b) => {
    const m = place.get(b.id);
    return { ...b, x: m?.x ?? b.x, y: m?.y ?? b.y, parent: m ? m.parent : b.parent, status: status.get(b.id) ?? b.status, sub: sub.get(b.id) ?? b.sub };
  });
  const byId = new Map(boxes.map((b) => [b.id, b]));
  // Every place a box ever sits, so a region keeps the room for what will move into it.
  const everywhere = new Map<string, { parent?: string; y: number; h: number }[]>();
  scene.boxes.forEach((b) => everywhere.set(b.id, [{ parent: b.parent, y: b.y, h: fullH(b) }]));
  scene.steps.forEach((s) => Object.entries(s.move ?? {}).forEach(([id, m]) => everywhere.get(id)?.push({ parent: m.parent, y: m.y, h: fullH(scene.boxes.find((b) => b.id === id)!) })));
  const cache = new Map<string, Rect>();
  const rectOf = (b: Box): Rect => (b.region ? effOf(b) : { x: b.x, y: b.y, w: b.w, h: open.has(b.id) && b.openH ? b.openH : b.h });
  function effOf(b: Box): Rect {
    const hit = cache.get(b.id);
    if (hit) return hit;
    const slots = [...everywhere.values()].flat().filter((p) => p.parent === b.id);
    const fullBottom = slots.length ? Math.max(...slots.map((p) => p.y + p.h)) : b.y + STRIP;
    const pad = Math.max(6, b.y + b.h - fullBottom);
    const kids = boxes.filter((c) => c.parent === b.id && shown(c.id));
    const visBottom = kids.length ? Math.max(...kids.map((c) => (c.region ? effOf(c).y + effOf(c).h : c.y + fullH(c)))) : b.y + STRIP;
    const r = { x: b.x, y: b.y, w: b.w, h: Math.min(b.h, visBottom + pad - b.y) };
    cache.set(b.id, r);
    return r;
  }
  return { boxes, byId, shown, isNew, open, blocked, rectOf };
}

const views = new WeakMap<Scene, { top: number; bottom: number }>();

export function sceneView(scene: Scene): { top: number; bottom: number } {
  const hit = views.get(scene);
  if (hit) return hit;
  let v = { top: 0, bottom: scene.height };
  if (isModern(scene)) {
    let top = Infinity;
    let bottom = -Infinity;
    scene.steps.forEach((_, i) => {
      const r = resolveStep(scene, i);
      r.boxes.filter((b) => r.shown(b.id) && (b.region || b.kind || b.outside || b.group)).forEach((b) => {
        top = Math.min(top, b.y);
        bottom = Math.max(bottom, r.rectOf(b).y + r.rectOf(b).h);
      });
    });
    v = { top: Math.max(0, top - 8), bottom: bottom + 8 + (scene.legend ? 4 + LEGEND_H : 0) };
  }
  views.set(scene, v);
  return v;
}

export function resolve(scene: Scene, i: number): Resolved {
  return { ...resolveStep(scene, i), view: sceneView(scene) };
}

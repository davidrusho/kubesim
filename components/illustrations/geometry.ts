// Pure geometry for Concept Illustrations: where an edge leaves a box, where it
// crosses a region's boundary, and whether one rectangle lies inside another.
// Kept apart from the React component so the scene tests can use it too.

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Point where the ray from a box's centre towards `to` leaves the box. */
export function exit(b: Rect, to: Pt): Pt {
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export type Side = "top" | "bottom" | "left" | "right";

export interface EdgeOptions {
  /** Leave / enter at the middle of this side instead of along the line between the centres. */
  fromSide?: Side;
  toSide?: Side;
  /** Route with right angles (down, across, down) instead of a straight or bent line. Needs both sides. */
  elbow?: boolean;
  /** Where an elbow's middle run sits: a y for down-across-down routes, an x for across-down-across ones. Defaults to halfway. */
  bus?: number;
}

export interface EdgeGeometry {
  d: string;
  mid: Pt;
  /** Start and end of the drawn line. */
  p: Pt;
  q: Pt;
  /** Quadratic control point (straight and bent edges). */
  c?: Pt;
  /** Corner points (elbow edges). */
  poly?: Pt[];
}

function sidePt(r: Rect, s: Side): Pt {
  if (s === "top") return { x: r.x + r.w / 2, y: r.y };
  if (s === "bottom") return { x: r.x + r.w / 2, y: r.y + r.h };
  if (s === "left") return { x: r.x, y: r.y + r.h / 2 };
  return { x: r.x + r.w, y: r.y + r.h / 2 };
}

export function edgePath(a: Rect, b: Rect, bend = 0, opt: EdgeOptions = {}): EdgeGeometry {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const p = opt.fromSide ? sidePt(a, opt.fromSide) : exit(a, cb);
  const q = opt.toSide ? sidePt(b, opt.toSide) : exit(b, ca);
  if (opt.elbow && opt.fromSide && opt.toSide) {
    const vertical = opt.fromSide === "top" || opt.fromSide === "bottom";
    const bus = opt.bus ?? (vertical ? (p.y + q.y) / 2 : (p.x + q.x) / 2);
    const k = vertical ? { x: p.x, y: bus } : { x: bus, y: p.y };
    const l = vertical ? { x: q.x, y: k.y } : { x: k.x, y: q.y };
    // Pull the end back a little so the arrowhead sits outside the box.
    const end = vertical ? { x: q.x, y: q.y - Math.sign(q.y - l.y) * 4 } : { x: q.x - Math.sign(q.x - l.x) * 4, y: q.y };
    return { d: `M${p.x},${p.y} L${k.x},${k.y} L${l.x},${l.y} L${end.x},${end.y}`, mid: { x: (k.x + l.x) / 2, y: (k.y + l.y) / 2 }, p, q: end, poly: [p, k, l, end] };
  }
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const nx = -(q.y - p.y) / len;
  const ny = (q.x - p.x) / len;
  const m = { x: (p.x + q.x) / 2 + nx * bend, y: (p.y + q.y) / 2 + ny * bend };
  // Pull the end back a little so the arrowhead sits outside the box.
  const back = 4;
  const ex = q.x - ((q.x - m.x) / (Math.hypot(q.x - m.x, q.y - m.y) || 1)) * back;
  const ey = q.y - ((q.y - m.y) / (Math.hypot(q.x - m.x, q.y - m.y) || 1)) * back;
  return { d: `M${p.x},${p.y} Q${m.x},${m.y} ${ex},${ey}`, mid: { x: (p.x + 2 * m.x + q.x) / 4, y: (p.y + 2 * m.y + q.y) / 4 }, p, c: m, q: { x: ex, y: ey } };
}

/** A point on the edge's line, t from 0 (start) to 1 (end). */
export function pointAt(g: EdgeGeometry, t: number): Pt {
  if (g.poly) {
    const lens = g.poly.slice(1).map((pt, i) => Math.hypot(pt.x - g.poly![i].x, pt.y - g.poly![i].y));
    let left = t * lens.reduce((x, y) => x + y, 0);
    for (let i = 0; i < lens.length; i++) {
      if (left <= lens[i] || i === lens.length - 1) {
        const f = lens[i] === 0 ? 0 : Math.min(1, left / lens[i]);
        return { x: g.poly[i].x + (g.poly[i + 1].x - g.poly[i].x) * f, y: g.poly[i].y + (g.poly[i + 1].y - g.poly[i].y) * f };
      }
      left -= lens[i];
    }
  }
  const c = g.c!;
  const u = 1 - t;
  return { x: u * u * g.p.x + 2 * u * t * c.x + t * t * g.q.x, y: u * u * g.p.y + 2 * u * t * c.y + t * t * g.q.y };
}

export function insideRect(r: Rect, pt: Pt): boolean {
  return pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;
}

/** Where the edge first crosses the boundary of `region`, or null if it never does. */
export function crossing(g: EdgeGeometry, region: Rect): { pt: Pt; t: number } | null {
  const start = insideRect(region, g.p);
  const N = 400;
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const pt = pointAt(g, t);
    if (insideRect(region, pt) !== start) return { pt, t };
  }
  return null;
}

/** True when `inner` lies wholly inside `outer` (a pixel of slack for rounding). */
export function containsRect(outer: Rect, inner: Rect, slack = 0.5): boolean {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when the curve passes through the interior of `r` (ends are sampled away from the endpoints' own boxes by the caller). */
export function curveHitsRect(g: EdgeGeometry, r: Rect): boolean {
  const N = 200;
  for (let i = 3; i <= N - 3; i++) if (insideRect(r, pointAt(g, i / N))) return true;
  return false;
}

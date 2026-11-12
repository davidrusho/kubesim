// The arithmetic and storage behind the draggable splitters in the Split layout. Pure and
// injectable, so the clamp and the persistence are unit-tested without a browser.

/** Where a splitter sits, as the second pane's share (0..1) of the container. */
export interface SplitSpec {
  /** Storage key. */
  key: string;
  /** Share of the container the second pane takes by default. */
  fallback: number;
  /** Smallest size, in px, of the first and second pane. */
  min1: number;
  min2: number;
}

/** The Cluster View | side column splitter: the side column starts at half the width. */
export const SIDE_SPLIT: SplitSpec = { key: "kubesim.split.side.v1", fallback: 0.5, min1: 320, min2: 420 };
/** The panel | terminal splitter inside the side column: the terminal starts at 60% of the height. */
export const DOCK_SPLIT: SplitSpec = { key: "kubesim.split.dock.v1", fallback: 0.6, min1: 160, min2: 220 };

/** Keeps the second pane's share inside what both panes' minimum sizes allow; if they can't both fit, the first pane's minimum wins nothing and the split is even. */
export function clampShare(share: number, total: number, min1: number, min2: number): number {
  if (!Number.isFinite(share) || total <= 0) return share;
  if (min1 + min2 >= total) return 0.5;
  const lo = min2 / total;
  const hi = 1 - min1 / total;
  return Math.min(hi, Math.max(lo, share));
}

/** A share, parsed defensively from whatever is in storage. */
export function parseShare(raw: string | null | undefined, fallback: number): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0.05 && n < 0.95 ? n : fallback;
}

type Store = Pick<Storage, "getItem" | "setItem">;
const browserStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadShare(spec: SplitSpec, store: Store | null = browserStore()): number {
  try {
    return parseShare(store?.getItem(spec.key), spec.fallback);
  } catch {
    return spec.fallback;
  }
}

export function saveShare(spec: SplitSpec, share: number, store: Store | null = browserStore()) {
  try {
    store?.setItem(spec.key, String(Math.round(share * 1000) / 1000));
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

/** The terminal's text size in px: one step per click, kept between these bounds. */
export const FONT_MIN = 11;
export const FONT_MAX = 16;
export const FONT_DEFAULT = 12;
export const FONT_KEY = "kubesim.terminal.font.v1";

export const clampFont = (n: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));

/** The stored text size, parsed defensively. */
export function parseFont(raw: string | null | undefined): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? Math.round(n) : FONT_DEFAULT;
}

export function loadFont(store: Store | null = browserStore()): number {
  try {
    return parseFont(store?.getItem(FONT_KEY));
  } catch {
    return FONT_DEFAULT;
  }
}

export function saveFont(px: number, store: Store | null = browserStore()) {
  try {
    store?.setItem(FONT_KEY, String(clampFont(px)));
  } catch {
    // Storage unavailable.
  }
}

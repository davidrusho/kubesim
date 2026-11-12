"use client";

// How much help a Challenge needed: hints revealed per goal and goals whose fix was shown, kept in
// localStorage next to the rest of progress. Best-effort, like everything in progress.ts.

import { getItem, setItem } from "./progress";

const KEY = "kubesim.challenge-usage.v1";

export interface Usage {
  /** Rungs revealed per goal index (the first is "Where to start"). */
  hints: Record<number, number>;
  /** Goals whose fix was shown. */
  fixes: number[];
}

const empty = (): Usage => ({ hints: {}, fixes: [] });

function loadAll(): Record<string, Usage> {
  try {
    const v: unknown = JSON.parse(getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, Usage> = {};
    for (const [slug, u] of Object.entries(v as Record<string, unknown>)) {
      if (!u || typeof u !== "object") continue;
      const { hints, fixes } = u as { hints?: unknown; fixes?: unknown };
      const h: Record<number, number> = {};
      if (hints && typeof hints === "object") for (const [k, n] of Object.entries(hints)) if (Number.isInteger(+k) && Number.isInteger(n) && (n as number) > 0) h[+k] = n as number;
      out[slug] = { hints: h, fixes: Array.isArray(fixes) ? fixes.filter((n) => Number.isInteger(n)) : [] };
    }
    return out;
  } catch {
    return {};
  }
}

export const loadUsage = (slug: string): Usage => loadAll()[slug] ?? empty();

export function saveUsage(slug: string, u: Usage) {
  const all = loadAll();
  all[slug] = u;
  setItem(KEY, JSON.stringify(all));
}

export const hintTotal = (u: Usage) => Object.values(u.hints).reduce((a, n) => a + n, 0);

/** "with no hints", "with 3 hints", "after peeking at the fix". */
export function usageSummary(u: Usage): string {
  if (u.fixes.length) return "after peeking at the fix";
  const n = hintTotal(u);
  return n ? `with ${n} hint${n > 1 ? "s" : ""}` : "with no hints";
}

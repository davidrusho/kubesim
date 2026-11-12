"use client";

// A string kept in localStorage that components can read during render without a hydration mismatch
// (the static page and the first client render both see `null`). Defensive like the other stores:
// without storage the value lasts for this page view.

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function useStored(key: string): [string | null, (v: string | null) => void] {
  const raw = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => read(key),
    () => null,
  );
  const set = (v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(key);
      else localStorage.setItem(key, v);
      memory.delete(key);
    } catch {
      if (v === null) memory.delete(key);
      else memory.set(key, v);
    }
    listeners.forEach((l) => l());
  };
  return [raw, set];
}

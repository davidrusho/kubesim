"use client";

// The hints a Learner has asked for so far. Until the first press of Hint this renders nothing, so
// no command (not even "where to start") is on screen before it is asked for.

import { useEffect, useRef } from "react";
import type { Rung } from "@/lib/lessons/hints";
import { Prose } from "./Prose";

export function HintLadder({ rungs, shown, onRun }: { rungs: Rung[]; shown: number; onRun?: (cmd: string) => void }) {
  const last = useRef<HTMLDivElement>(null);
  // A newly revealed hint scrolls into view, since the side panel is short.
  useEffect(() => {
    if (shown > 0) last.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);
  return (
    <>
      {rungs.slice(0, shown).map((r, i) => (
        <div key={i} ref={i === shown - 1 ? last : undefined} className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13.5px] text-amber-950">
          <div className="mb-0.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-amber-800">{r.label}</div>
          <Prose text={r.text} onRun={onRun} />
        </div>
      ))}
    </>
  );
}

/** Brings what it wraps into view when it first appears (a revealed fix, in a short side panel). */
export function ScrollOnMount({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div ref={ref} className="mt-3">
      {children}
    </div>
  );
}

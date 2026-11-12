"use client";

// A draggable, keyboard-operable separator between two panes of the Split layout.

import { useRef } from "react";

const STEP = 24;
const BIG_STEP = 96;

export function Splitter({
  orientation,
  label,
  /** The second pane's share of the container (0..1), and the container's size in px along the drag axis. */
  share,
  total,
  onChange,
  onCommit,
  onReset,
}: {
  /** "vertical": a vertical bar between a left and a right pane. "horizontal": a horizontal bar between a top and a bottom pane. */
  orientation: "vertical" | "horizontal";
  label: string;
  share: number;
  total: number;
  /** Called continuously while dragging or pressing keys, with the new share. */
  onChange: (share: number) => void;
  /** Called once the drag or key press is over. */
  onCommit: (share: number) => void;
  onReset: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const horizontal = orientation === "horizontal";
  const drag = useRef<{ start: number; share: number } | null>(null);

  const move = (delta: number) => {
    if (total <= 0) return;
    // Dragging right (or down) shrinks the second pane.
    const next = (drag.current?.share ?? share) - delta / total;
    onChange(next);
    return next;
  };

  return (
    <div
      ref={bar}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      aria-valuetext={`${Math.round(share * 100)}% for the ${horizontal ? "bottom" : "right"} pane`}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className={`group relative shrink-0 touch-none select-none outline-none ${horizontal ? "-my-3 h-3 cursor-row-resize" : "-mx-3 w-3 cursor-col-resize"}`}
      onPointerDown={(e) => {
        drag.current = { start: horizontal ? e.clientY : e.clientX, share };
        bar.current?.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current) move((horizontal ? e.clientY : e.clientX) - drag.current.start);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        const next = move((horizontal ? e.clientY : e.clientX) - drag.current.start);
        drag.current = null;
        bar.current?.releasePointerCapture(e.pointerId);
        if (next !== undefined) onCommit(next);
      }}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const prev = horizontal ? "ArrowUp" : "ArrowLeft";
        const nextKey = horizontal ? "ArrowDown" : "ArrowRight";
        if (e.key !== prev && e.key !== nextKey) return;
        e.preventDefault();
        const next = move((e.key === prev ? -1 : 1) * (e.shiftKey ? BIG_STEP : STEP));
        if (next !== undefined) onCommit(next);
      }}
    >
      <span aria-hidden className={`absolute rounded-full bg-ink/15 transition-colors group-hover:bg-signal/60 group-focus-visible:bg-signal group-active:bg-signal ${horizontal ? "inset-x-1/3 top-1/2 h-[3px] -translate-y-1/2" : "inset-y-1/3 left-1/2 w-[3px] -translate-x-1/2"}`} />
    </div>
  );
}

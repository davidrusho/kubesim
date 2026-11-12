"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { complete } from "@/lib/kubectl/kubectl";
import { needsMore } from "@/lib/kubectl/shell";
import type { SimStore } from "@/lib/sim/useSimulation";
import { FONT_KEY, FONT_MAX, FONT_MIN, clampFont, parseFont } from "./split";
import { useStored } from "./useStored";

/** How close to the bottom (px) still counts as "following" the output. */
const STICK_PX = 24;

/** A kubectl terminal: history (↑/↓), Tab completion, Ctrl+L to clear, Ctrl+C to stop streaming. */
export function Terminal({ sim, autoFocus, quiet = false }: { sim: SimStore; autoFocus?: boolean; /** Practice mode: no example command in the greeting or the prompt, and no namespace in the prompt (the exam prompt does not show it). */ quiet?: boolean }) {
  const [line, setLine] = useState("");
  const [hi, setHi] = useState(-1);
  // A command that is not finished (an open quote, a here-document) carries on on the next line, behind a "> " prompt.
  const [pending, setPending] = useState<string[]>([]);
  const pendingRef = useRef<string[]>([]);
  const feed = (raw: string) => {
    const lines = [...pendingRef.current, raw];
    if (needsMore(lines.join("\n"))) {
      pendingRef.current = lines;
      setPending(lines);
      return;
    }
    pendingRef.current = [];
    setPending([]);
    sim.exec(lines.join("\n"));
  };
  const [hint, setHint] = useState<string[]>([]);
  // The text size, kept between visits.
  const [fontRaw, setFontRaw] = useStored(FONT_KEY);
  const font = parseFont(fontRaw);
  const resize = (delta: number) => setFontRaw(String(clampFont(font + delta)));
  const input = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  /** Whether the Learner is at the bottom; if they scrolled up to read, new output doesn't yank them down. */
  const follow = useRef(true);
  const last = sim.term[sim.term.length - 1];
  const tail = `${sim.term.length}:${last?.id ?? 0}:${last?.out.length ?? 0}:${hint.length}:${pending.length}`;

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [tail]);
  // A command the Learner just ran always brings the prompt back into view.
  const lastCmdId = [...sim.term].reverse().find((t) => t.cmd !== undefined)?.id;
  useLayoutEffect(() => {
    follow.current = true;
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastCmdId]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  // Leaving nano or vi brings the Learner back to the prompt: the Terminal tab mounts again, so this runs on mount as well as on a change.
  useEffect(() => {
    if (sim.takeFocusRequest()) input.current?.focus();
  }, [sim, sim.focusSeq]);

  // Screen readers hear each finished command's output once, not every streaming refresh.
  const announce = last && !last.live ? `${last.cmd ? `${last.cmd}: ` : ""}${last.out.slice(0, 400)}` : "";

  const history = sim.history;
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      feed(line);
      setLine("");
      setHi(-1);
      setHint([]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = hi < 0 ? history.length - 1 : Math.max(0, hi - 1);
      if (history[i] !== undefined) {
        setHi(i);
        setLine(history[i].replace(/\n/g, " "));
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hi < 0) return;
      const i = hi + 1;
      if (i >= history.length) {
        setHi(-1);
        setLine("");
      } else {
        setHi(i);
        setLine(history[i].replace(/\n/g, " "));
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const ctx = { cluster: sim.cluster!, namespace: sim.namespace, files: sim.files };
      const opts = complete(ctx, line);
      if (opts.length === 1) {
        setLine(line.replace(/\S*$/, opts[0]) + " ");
        setHint([]);
      } else if (opts.length > 1) {
        const pre = opts.reduce((a, b) => {
          let i = 0;
          while (i < a.length && a[i] === b[i]) i++;
          return a.slice(0, i);
        });
        setLine(line.replace(/\S*$/, pre));
        setHint(opts.slice(0, 12));
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      sim.exec("clear");
    } else if (e.key === "c" && e.ctrlKey && !e.metaKey) {
      // With text selected, Ctrl+C copies as usual.
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd || !window.getSelection()?.isCollapsed) return;
      e.preventDefault();
      // Ctrl+C cancels a command that is still waiting for its other lines.
      if (pendingRef.current.length) {
        pendingRef.current = [];
        setPending([]);
        setLine("");
        setHint([]);
      } else if (!sim.stopWatch()) {
        setLine("");
        setHint([]);
      }
    }
  };

  return (
    <div className="flex h-full flex-col font-mono leading-relaxed" style={{ fontSize: font }} onClick={() => window.getSelection()?.isCollapsed && input.current?.focus()}>
      <div
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
        className="min-h-0 flex-1 overflow-auto px-4 py-2"
        role="log"
        aria-label="Terminal output"
        aria-live="off"
        tabIndex={0}
      >
        {sim.term.length === 0 && (
          <div className="text-ink-soft">
            {quiet ? "Type a command and press Enter. Tab completes, ↑ recalls history. Nothing here can break: Start over rebuilds the cluster." : <>Type a command and press Enter. Try <span className="text-ink">kubectl get pods</span> or <span className="text-ink">help</span>. Tab completes, ↑ recalls history. Nothing here can break: Start over rebuilds the cluster.</>}
          </div>
        )}
        {sim.term.map((t) => (
          <div key={t.id} className="mb-1.5">
            {t.cmd !== undefined && (
              <div>
                <span className="whitespace-pre text-ink-soft">{t.prompt ?? `${quiet || !t.ns || t.ns === "default" ? "" : `(${t.ns}) `}$`}</span> <span className="whitespace-pre text-ink">{t.cmd.split("\n").map((l, i) => (i ? `\n> ${l}` : l)).join("")}</span>
              </div>
            )}
            {t.out && <pre className={`w-max min-w-full whitespace-pre ${t.ok ? "text-ink-soft" : "text-red-700"}`}>{t.out}</pre>}
            {t.live && (
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-soft">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
                streaming… press Ctrl+C or
                <button onClick={() => sim.stopWatch()} className="rounded-md border border-ink/15 bg-paper px-1.5 text-ink hover:border-ink/40">
                  stop
                </button>
              </div>
            )}
          </div>
        ))}
        {pending.length > 0 && (
          <div className="mb-1.5 whitespace-pre text-ink" data-pending>
            <span className="text-ink-soft">{sim.prompt ?? "$"}</span> {pending[0]}
            {pending.slice(1).map((l) => `\n> ${l}`).join("")}
          </div>
        )}
        {hint.length > 0 && <div className="text-ink-soft">{hint.join("   ")}</div>}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      {/* The prompt row never shrinks: the output above scrolls instead, so the input stays fully on screen. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-ink/15 bg-ink/[0.03] px-4 py-2.5 focus-within:bg-paper focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-signal/50">
        <span className="text-ink-soft" aria-hidden="true">
          {pending.length ? ">" : (sim.prompt ?? `${quiet || sim.namespace === "default" ? "" : `(${sim.namespace}) `}$`)}
        </span>
        <input
          ref={input}
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text").replace(/\r\n?/g, "\n");
            if (!text.includes("\n")) return;
            // A pasted block is fed in line by line, each read after the one before has run, like a real terminal.
            e.preventDefault();
            const parts = text.split("\n");
            const el = e.currentTarget;
            const before = line.slice(0, el.selectionStart ?? line.length);
            const after = line.slice(el.selectionEnd ?? line.length);
            parts.slice(0, -1).forEach((p, i) => feed(i === 0 ? before + p : p));
            setLine(parts[parts.length - 1] + after);
            setHi(-1);
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-soft/70"
          placeholder={quiet || pending.length ? "" : "kubectl get pods"}
          aria-label="Terminal input"
        />
        <div className="flex shrink-0 items-center gap-0.5 text-ink-soft" role="group" aria-label="Terminal text size">
          <button type="button" onClick={() => resize(-1)} disabled={font <= FONT_MIN} className="h-6 rounded px-1.5 text-[11px] hover:bg-ink/[0.06] hover:text-ink disabled:opacity-30" aria-label="Smaller text" title="Smaller text">
            A−
          </button>
          <button type="button" onClick={() => resize(1)} disabled={font >= FONT_MAX} className="h-6 rounded px-1.5 text-[13px] hover:bg-ink/[0.06] hover:text-ink disabled:opacity-30" aria-label="Larger text" title="Larger text">
            A+
          </button>
        </div>
      </div>
    </div>
  );
}

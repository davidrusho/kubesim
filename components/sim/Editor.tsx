"use client";

import { useEffect, useRef, useState } from "react";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { Vim, vim } from "@replit/codemirror-vim";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { tags as t } from "@lezer/highlight";
import type { SimStore } from "@/lib/sim/useSimulation";
import { Btn } from "../ui";
import { capture } from "@/lib/posthog-client";
import { posthogLogger } from "@/lib/posthog-logger";

const highlight = HighlightStyle.define([
  // Ink on paper: keys in full ink, values a step softer, punctuation and comments faint.
  { tag: t.propertyName, color: "var(--color-ink)", fontWeight: "500" },
  { tag: [t.string, t.content], color: "var(--color-ink-soft)" },
  { tag: [t.number, t.bool, t.null], color: "var(--color-ink-soft)" },
  { tag: t.comment, color: "rgb(var(--ink-rgb) / 0.45)", fontStyle: "italic" },
  { tag: [t.punctuation, t.separator], color: "rgb(var(--ink-rgb) / 0.4)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--color-paper)", color: "var(--color-ink)" },
  ".cm-scroller": { fontFamily: "var(--font-geist-mono), ui-monospace, monospace", lineHeight: "1.65" },
  ".cm-gutters": { backgroundColor: "var(--color-paper)", border: "none", color: "rgb(var(--ink-rgb) / 0.3)" },
  ".cm-activeLine": { backgroundColor: "rgb(var(--ink-rgb) / 0.03)" },
  ".cm-activeLineGutter": { backgroundColor: "rgb(var(--ink-rgb) / 0.03)", color: "var(--color-ink-soft)" },
  "&.cm-focused": { outline: "2px solid rgba(217,72,15,.5)", outlineOffset: "-2px" },
  ".cm-cursor": { borderLeftColor: "var(--color-ink)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgb(var(--ink-rgb) / 0.14)" },
});

/** What each vi/vim editor on the page answers to `:w`, `:q` and the rest. `Vim.defineEx` is global to the module, so the commands look their editor up by view. */
interface ViHost {
  write: (as?: string) => string;
  quit: (force: boolean) => string | null;
  writeQuit: () => void;
}
const viHosts = new WeakMap<EditorView, ViHost>();
let viDefined = false;

/** Vim's own `write` is built in and calls the global `CodeMirror.commands.save`; `quit`, `wq` and `xit` do not exist at all. Defining all four through `Vim.defineEx` (the documented way, see the package README) replaces them for every editor, so each one routes to its own view's host. */
function defineViCommands() {
  if (viDefined) return;
  viDefined = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Cm = any;
  const host = (cm: Cm) => viHosts.get(cm.cm6);
  const say = (cm: Cm, text: string) => {
    const el = document.createElement("div");
    el.className = "cm-vim-message";
    el.style.whiteSpace = "pre";
    el.textContent = text;
    cm.openNotification(el, { bottom: true, duration: 15000 });
  };
  // `:w!` forces the write: the `!` is not part of a file name.
  const writeTo = (cm: Cm, params: { argString?: string }) => {
    const h = host(cm);
    if (h) say(cm, h.write(params.argString?.trim().replace(/^!\s*/, "") || undefined));
  };
  const quit = (cm: Cm, params: { argString?: string }) => {
    const refusal = host(cm)?.quit(params.argString?.trim().startsWith("!") ?? false);
    if (refusal) say(cm, refusal);
  };
  const writeQuit = (cm: Cm) => host(cm)?.writeQuit();
  Vim.defineEx("write", "w", writeTo);
  Vim.defineEx("wall", "wa", writeTo);
  Vim.defineEx("quit", "q", quit);
  Vim.defineEx("qall", "qa", quit);
  Vim.defineEx("wq", "wq", writeQuit);
  Vim.defineEx("xit", "x", writeQuit);
  Vim.defineEx("wqall", "wqa", writeQuit);
  Vim.defineEx("xall", "xa", writeQuit);
  // Normal mode: ZZ saves and exits, ZQ discards and exits.
  Vim.map("ZZ", ":wq<CR>", "normal");
  Vim.map("ZQ", ":q!<CR>", "normal");
}

/** nano's own words, from its source (files.c, nano.c). The write-out prompt is the wording the brief asked for. */
const NANO_SAVE_PROMPT = "Save modified buffer?";
const NANO_NAME_PROMPT = "File Name to Write:";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The YAML editor. Opened by nano or vi it is re-made as that tool (a fresh mount per mode); otherwise every keystroke writes through to the file. */
export function Editor({ sim }: { sim: SimStore }) {
  return <EditorBody key={sim.editorMode ?? "plain"} sim={sim} />;
}

/** A YAML editor over the Learner's virtual files, with Apply. */
function EditorBody({ sim }: { sim: SimStore }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const file = sim.editorFile;
  const seq = sim.editSeq;
  const mode = sim.editorMode;
  // nano: the status line and the prompt at the bottom.
  const [message, setMessage] = useState("");
  const [prompt, setPrompt] = useState<null | "save" | "name">(null);
  const promptRef = useRef<null | "save" | "name">(null);
  /** What the file name prompt does on Enter: write and stay (Ctrl+O) or write and leave (Ctrl+X, Y). */
  const [leave, setLeave] = useState(false);
  const [name, setName] = useState(file);
  // Typing does not touch the store's version, so a tick re-renders the Modified marker; its value is read from the store each render, so loading another file shows the right state too.
  const [, setTick] = useState(0);
  const dirty = sim.editorDirty;
  const ask = (p: null | "save" | "name") => {
    promptRef.current = p;
    setPrompt(p);
  };

  useEffect(() => {
    const apply = (ev: EditorView, trigger: string) => {
      capture("manifest_applied");
      posthogLogger.info("manifest apply requested", { trigger });
      // In nano or vi the file is only written by saving; Apply runs the buffer as it stands.
      sim.apply(ev.state.doc.toString(), undefined, mode === null);
    };
    const tool: Extension[] = [];
    if (mode === "vi") {
      defineViCommands();
      // vim() goes before every other keymap; basicSetup is not used, so the selection is drawn here.
      tool.push(vim({ status: true }), drawSelection());
    }
    // nano's cutbuffer: consecutive ^K add each line to it, a ^K after any other key replaces it (nano manual, "The cutbuffer").
    let cutbuffer = "";
    let lastWasCut = false;
    if (mode === "nano") {
      tool.push(
        Prec.highest(
          EditorView.domEventHandlers({
            keydown: (e) => {
              if (e.metaKey || e.altKey) return false;
              const key = e.key.toLowerCase();
              if (promptRef.current === "save") {
                e.preventDefault();
                if (key === "y") {
                  setLeave(true);
                  setName(sim.editorFile);
                  ask("name");
                }
                else if (key === "n") sim.exitEditor(false);
                else if ((e.ctrlKey && key === "c") || key === "escape") {
                  ask(null);
                  setMessage("Cancelled");
                }
                return true;
              }
              // A bare modifier press (the Ctrl of Ctrl+K) is not a keystroke of its own.
              if (["control", "shift", "alt", "meta"].includes(key)) return false;
              setMessage("");
              const wasCut = lastWasCut;
              lastWasCut = false;
              if (!e.ctrlKey) return false;
              if (key === "k" && !e.shiftKey) {
                e.preventDefault();
                const ev = view.current;
                if (!ev) return true;
                const line = ev.state.doc.lineAt(ev.state.selection.main.head);
                const to = Math.min(line.to + 1, ev.state.doc.length);
                if (line.from === to) return true;
                const text = ev.state.doc.sliceString(line.from, line.to) + "\n";
                cutbuffer = wasCut ? cutbuffer + text : text;
                lastWasCut = true;
                ev.dispatch({ changes: { from: line.from, to }, selection: { anchor: line.from } });
                return true;
              }
              if (key === "u") {
                e.preventDefault();
                const ev = view.current;
                if (ev && cutbuffer) ev.dispatch(ev.state.replaceSelection(cutbuffer), { scrollIntoView: true });
                return true;
              }
              if (key === "o") {
                e.preventDefault();
                setLeave(false);
                setName(sim.editorFile);
                ask("name");
                return true;
              }
              if (key === "x") {
                e.preventDefault();
                if (sim.editorDirty) ask("save");
                else sim.exitEditor(false);
                return true;
              }
              return false;
            },
          }),
        ),
      );
    }
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: (mode === null ? sim.files[sim.editorFile] : sim.buffer) ?? "",
        extensions: [
          ...tool,
          lineNumbers(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          yaml(),
          syntaxHighlighting(highlight),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Mod-Enter", run: (ev) => { apply(ev, "keyboard_shortcut"); return true; } }]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            if (mode === null) sim.files[sim.editorFile] = text;
            else {
              sim.setBuffer(text);
              setTick((n) => n + 1);
            }
          }),
          theme,
          EditorView.contentAttributes.of({ "aria-label": "YAML editor" }),
        ],
      }),
    });
    view.current = v;
    if (mode === "vi") {
      viHosts.set(v, {
        write: (as) => {
          const w = sim.saveBuffer(as);
          return `"${w.name}" ${w.lines}L, ${w.bytes}B written`;
        },
        quit: (force) => {
          if (!force && sim.editorDirty) return "E37: No write since last change (add ! to override)";
          sim.exitEditor(false);
          return null;
        },
        writeQuit: () => sim.exitEditor(true),
      });
    }
    // nano and vi take the keys at once, as the real tools do. Focus waits a tick: the Enter that ran the command is still being delivered, and would type a newline into the editor.
    const focus = mode !== null ? setTimeout(() => v.focus(), 0) : undefined;
    return () => {
      clearTimeout(focus);
      viHosts.delete(v);
      v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the file whenever another one is opened (or re-opened with new contents).
  useEffect(() => {
    const v = view.current;
    const text = (mode === null ? sim.files[file] : sim.buffer) ?? "";
    if (v && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, seq]);

  const last = [...sim.term].reverse().find((x) => x.cmd?.startsWith("kubectl apply -f"));
  const names = Object.keys(sim.files).sort();

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-ink/15 md:border-r">
        {mode === "nano" && (
          <div className="flex shrink-0 justify-between bg-ink px-3 py-0.5 font-mono text-[11.5px] text-paper" data-testid="nano-title">
            <span>GNU nano</span>
            <span>{file}</span>
            <span>{dirty ? "Modified" : ""}</span>
          </div>
        )}
        <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
        {mode === "nano" && (
          <div className="shrink-0 bg-ink/[0.04] font-mono text-[11.5px] text-ink" data-testid="nano-bar">
            <div className="flex min-h-6 items-center px-3 py-0.5" role="status">
              {prompt === "save" ? (
                <span data-testid="nano-prompt">
                  {NANO_SAVE_PROMPT} <span className="mx-1 bg-ink px-1 text-paper">Y</span>Yes <span className="mx-1 bg-ink px-1 text-paper">N</span>No <span className="mx-1 bg-ink px-1 text-paper">^C</span>Cancel
                </span>
              ) : prompt === "name" ? (
                <label className="flex flex-1 items-center gap-2" data-testid="nano-prompt">
                  {NANO_NAME_PROMPT}
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (!name.trim()) return;
                        if (leave) sim.exitEditor(true, name);
                        else {
                          const w = sim.saveBuffer(name);
                          ask(null);
                          setTick((n) => n + 1);
                          setMessage(`Wrote ${plural(w.lines, "line", "lines")}`);
                          view.current?.focus();
                        }
                      } else if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "c")) {
                        e.preventDefault();
                        ask(null);
                        setMessage("Cancelled");
                        view.current?.focus();
                      }
                    }}
                    spellCheck={false}
                    aria-label="File name to write"
                    className="min-w-0 flex-1 bg-transparent outline-none"
                  />
                </label>
              ) : message ? (
                <span className="mx-auto bg-ink/10 px-2" data-testid="nano-status">
                  [ {message} ]
                </span>
              ) : null}
            </div>
            <div className="flex gap-6 px-3 py-0.5 text-ink-soft">
              <span>
                <span className="bg-ink px-1 text-paper">^O</span> Write Out
              </span>
              <span>
                <span className="bg-ink px-1 text-paper">^X</span> Exit
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-ink/15 p-3 md:w-64 md:border-t-0">
        {mode === null && <select value={file} onChange={(e) => sim.openFile(e.target.value)} className="h-7 rounded-md border border-ink/15 bg-paper px-1.5 font-mono text-[11.5px] text-ink outline-none hover:border-ink/40 focus-visible:border-signal" aria-label="File">
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>}
        <Btn tone="primary" onClick={() => { if (!view.current) return; capture("manifest_applied"); posthogLogger.info("manifest apply requested", { trigger: "button" }); sim.apply(view.current.state.doc.toString(), undefined, mode === null); }}>
          kubectl apply -f {file}
        </Btn>
        <div className="hidden text-[11px] text-ink-soft md:block">{mode ? "Apply runs the text in the editor; saving writes the file. " : ""}⌘/Ctrl + Enter also applies. Files are shared with the terminal: try ls, cat, and kubectl get … -o yaml &gt; file.yaml</div>
        {last && <pre className={`mt-1 max-h-40 overflow-auto whitespace-pre-wrap border p-2 font-mono text-[11px] leading-snug ${last.ok ? "border-ink/15 bg-ink/[0.03] text-ink-soft" : "border-red-600/40 bg-red-50 text-red-900"}`}>{last.out}</pre>}
      </div>
    </div>
  );
}

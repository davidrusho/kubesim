"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { controlPlaneHealth, type Namespace, type Node, type Pod, type Service } from "@/lib/engine";
import { SYSTEM_NAMESPACES } from "@/lib/engine/bootstrap";
import type { SimStore } from "@/lib/sim/useSimulation";
import { podCategory } from "@/lib/sim/status";
import { explainEvent, isNarrated } from "@/lib/sim/explain";
import { age } from "@/lib/sim/status";
import { controlPlaneNote, controlPlaneStatus, unreachableNote } from "@/lib/sim/controlplane";
import { useLastKnown } from "./lastKnown";
import { ClusterView, type Selection } from "./ClusterView";
import { CommandLog, EventsTable, ResourceTable } from "./Inspector";
import { Splitter } from "./Splitter";
import { DOCK_SPLIT, SIDE_SPLIT, clampShare, parseShare, type SplitSpec } from "./split";
import { useStored } from "./useStored";
import { Terminal } from "./Terminal";
import { ClusterText } from "./ClusterText";
import { Editor } from "./Editor";
import { DragProvider, Palette } from "./DragLayer";
import { Segmented, clock } from "../ui";

const SPEEDS = [1, 5, 30, 60];

/** Speed picker: one compact button that opens the choices. */
function SpeedMenu({ sim }: { sim: SimStore }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Simulation speed, ${sim.speed}×`}
        title="Simulation speed"
        className="flex h-8 items-center gap-1 rounded-md border border-ink/15 bg-paper px-2.5 font-mono text-[12.5px] tabular-nums text-ink hover:border-ink/40"
      >
        {sim.speed}×
        <svg viewBox="0 0 16 16" className={`h-3 w-3 text-ink-soft transition ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="group" aria-label="Simulation speed" className="float-card absolute left-0 top-full z-50 mt-1 flex w-44 flex-col py-1">
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              onClick={() => {
                sim.setSpeed(sp);
                setOpen(false);
              }}
              aria-pressed={sim.speed === sp}
              className={`flex items-center justify-between px-3 py-1.5 text-left text-[13px] hover:bg-ink/[0.05] ${sim.speed === sp ? "text-ink underline underline-offset-4" : "text-ink-soft"}`}
            >
              <span className="font-mono tabular-nums">{sp}×</span>
              <span className="text-[12px] text-ink-soft">{sp === 1 ? "real time" : sp === 5 ? "skip waits" : sp === 30 ? "fast" : "fastest"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type DockTab = "terminal" | "editor" | "resources" | "events" | "commands";
/** On small screens only one of these is shown at a time. */
export type MobileView = "canvas" | "dock" | "side";

/** `roomyHeader` false: a crowded header (the Sandbox's) drops the clock on phones so its buttons fit. */
export function SimControls({ sim, roomyHeader = true }: { sim: SimStore; roomyHeader?: boolean }) {
  const c = sim.cluster;
  if (!c) return null;
  return (
    <>
      <button onClick={() => sim.setPaused(!sim.paused)} className="grid h-8 w-8 place-items-center rounded-md border border-ink/15 bg-paper text-ink hover:border-ink/40" title={sim.paused ? "Resume" : "Pause"} aria-label={sim.paused ? "Resume simulation" : "Pause simulation"}>
        {sim.paused ? (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><path d="M4 2.5v11l9-5.5z" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" /><rect x="9.5" y="2.5" width="3" height="11" /></svg>
        )}
      </button>
      <div className="hidden sm:block">
        <SpeedMenu sim={sim} />
      </div>
      <div className={`items-center gap-2 font-mono text-[13px] tabular-nums text-ink ${roomyHeader ? "flex" : "hidden sm:flex"}`} title="Simulated time">
        <span className={`h-1.5 w-1.5 rounded-full ${sim.paused ? "bg-ink/25" : "bg-green-700"}`} />
        {clock(c.now)}
      </div>
      {sim.crashed && (
        <div role="alert" className="flex items-center gap-2 border border-red-600/40 bg-red-50 px-2.5 py-1 text-[12.5px] text-red-900" title={sim.crashed}>
          Something went wrong in the simulator, not in your commands.
          <button onClick={() => sim.reset()} className="font-medium underline underline-offset-2 hover:text-red-950" title="Rebuild this cluster from the beginning. Your other Lessons and Challenges keep their progress.">
            Start over
          </button>
        </div>
      )}
    </>
  );
}

/** Width and height of an element, tracked as it resizes (0 until measured). Pass the element itself (a callback ref's value). */
function useSize(el: HTMLElement | null): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    // A ResizeObserver reports the current size as soon as it starts observing.
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return size;
}

const DESKTOP = "(min-width: 1024px)";
/** Whether the screen is wide enough for the Spotlight and Split layouts (static rendering assumes it is). */
function useDesktop(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(DESKTOP);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia(DESKTOP).matches,
    () => true,
  );
}

/**
 * How an app screen is arranged on wide screens.
 * Spotlight: the cluster fills the screen; the step and the terminal float over it in cards at the bottom.
 * Split: the cluster in one card, the step and the terminal in cards beside it.
 */
export type Layout = "spotlight" | "split";
const LAYOUT_KEY = "kubesim.layout.v1";
const layoutListeners = new Set<() => void>();

/** The Learner's layout choice, shared by every screen and kept across visits; `fallback` until they choose. */
export function useLayoutChoice(fallback: Layout): [Layout, (l: Layout) => void] {
  const stored = useSyncExternalStore(
    (fn) => {
      layoutListeners.add(fn);
      return () => layoutListeners.delete(fn);
    },
    () => {
      try {
        return localStorage.getItem(LAYOUT_KEY);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const set = (l: Layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
    layoutListeners.forEach((fn) => fn());
  };
  return [stored === "spotlight" || stored === "split" ? stored : fallback, set];
}

/** Header switch between the two layouts (wide screens only). */
export function LayoutToggle({ value, onChange }: { value: Layout; onChange: (l: Layout) => void }) {
  const opts: { v: Layout; label: string; icon: React.ReactNode }[] = [
    { v: "spotlight", label: "Spotlight", icon: <><rect x="2" y="2.5" width="12" height="11" rx="2" /><rect x="5" y="9.5" width="6" height="2.5" rx="1" fill="currentColor" stroke="none" /></> },
    { v: "split", label: "Split", icon: <><rect x="2" y="2.5" width="7" height="11" rx="2" /><rect x="10.5" y="2.5" width="3.5" height="11" rx="1.5" /></> },
  ];
  return (
    <div role="group" aria-label="Layout" className="hidden items-center rounded-lg border border-ink/15 bg-canvas p-0.5 lg:flex">
      {opts.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)} aria-pressed={value === o.v} title={`${o.label} layout`} className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors ${value === o.v ? "bg-paper font-medium text-ink shadow-[0_1px_2px_rgb(15_23_42/0.08)]" : "text-ink-soft hover:text-ink"}`}>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
            {o.icon}
          </svg>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Canvas overlay geometry, in px. Kept in one place so overlays and the zoom-to-fit agree. */
const PALETTE_W = 200;
const EDGE = 16;
/** Left edge of the overlays that sit beside the palette. */
const BESIDE_PALETTE = EDGE + PALETTE_W + 12;
/** Width of the folded palette's "+ Add" button. */
const ADD_W = 56;
/** Clear of the zoom controls (bottom-right). */
const ZOOM_W = 176;

/** A tab of the dock beyond the built-in ones (the Sandbox's Scenarios and Build). */
export interface ExtraTab {
  id: string;
  label: React.ReactNode;
  render: () => React.ReactNode;
}

interface Props {
  sim: SimStore;
  selection: Selection;
  onSelect: (s: Selection) => void;
  showSystem?: boolean;
  tabs?: DockTab[];
  extraTabs?: ExtraTab[];
  initialTab?: DockTab | string;
  /** Ask the dock to show this tab (changes to it switch the tab). */
  requestTab?: { id: DockTab | string; seq: number };
  /** Extra overlay on the canvas. */
  overlay?: React.ReactNode;
  narration?: boolean;
  /** Small screens show one of these at a time. */
  mobileView?: MobileView;
  /** Allow drag-and-drop on the canvas (off for Explainers). */
  interactive?: boolean;
  /** Show the drag-to-create palette. */
  palette?: boolean;
  layout?: Layout;
  /** Practice mode (Incidents, Challenges): the terminal shows no example command. */
  quiet?: boolean;
  /** The screen's own panel: a Lesson's steps, a Challenge's goals. */
  side?: React.ReactNode;
  sideLabel?: string;
  /** Details of the selected object, floating over the canvas. */
  inspector?: React.ReactNode;
  onCloseInspector?: () => void;
  /** Small screens: show the side panel above the canvas instead of on its own tab. */
  sideAboveOnMobile?: boolean;
}

export function Workspace({ sim, selection, onSelect, showSystem = false, tabs = ["terminal", "editor", "resources", "events", "commands"], extraTabs = [], initialTab, requestTab, overlay, narration = true, mobileView = "canvas", interactive = true, palette = false, layout = "split", quiet = false, side, sideLabel = "Steps", inspector, onCloseInspector, sideAboveOnMobile = false }: Props) {
  const allTabs: string[] = [...tabs, ...extraTabs.map((t) => t.id)];
  const [tab, setTab] = useState<string>(initialTab ?? allTabs[0]);
  const [open, setOpen] = useState(allTabs.length > 0);
  const [textView, setTextView] = useState(false);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const [stackEl, setStackEl] = useState<HTMLDivElement | null>(null);
  const canvasSize = useSize(canvasEl);
  const canvasW = canvasSize.w;
  const stackH = useSize(stackEl).h;
  // Split layout: where the two draggable splitters sit, and a counter that re-fits the diagram when one is released.
  const [refit, setRefit] = useState(0);
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const [colEl, setColEl] = useState<HTMLDivElement | null>(null);
  const mainSize = useSize(mainEl);
  const colSize = useSize(colEl);
  const sideSplit = useShare(SIDE_SPLIT);
  const dockSplit = useShare(DOCK_SPLIT);
  const desktop = useDesktop();
  const spotlight = desktop && layout === "spotlight";
  /** A narrow canvas (phones) can't spare a column for the palette: it floats over the diagram. */
  const wide = canvasW >= 640;
  const [paletteChoice, setPaletteChoice] = useState<boolean | null>(null);
  // The palette starts folded so the diagram is the first thing you see; "+ Add" opens it.
  const paletteOpen = palette && (paletteChoice ?? false);
  const paletteColumn = paletteOpen && wide;
  // Follow requests from the store (kubectl edit, "Open in editor", "Run") and from the screen.
  const [seen, setSeen] = useState({ edit: sim.editSeq, term: sim.termSeq, req: requestTab?.seq });
  if (seen.edit !== sim.editSeq || seen.term !== sim.termSeq || seen.req !== requestTab?.seq) {
    const want: string | null = seen.req !== requestTab?.seq ? (requestTab?.id ?? null) : seen.edit !== sim.editSeq ? "editor" : "terminal";
    setSeen({ edit: sim.editSeq, term: sim.termSeq, req: requestTab?.seq });
    if (want && allTabs.includes(want)) {
      setTab(want);
      setOpen(true);
    }
  }

  const live = sim.cluster!;
  // While the apiserver does not answer, the canvas keeps the last picture it read and says so (ADR 0003, decision 5).
  const apiUp = controlPlaneHealth(live).api;
  const c = useLastKnown(live, apiUp, sim.frameNow);
  const unreachable = unreachableNote(live, narration);
  // Practice mode reads the control plane's health from the same picture as everything else (what `get pods` showed); narration reads it live.
  const health = controlPlaneStatus(narration ? live : c, narration);
  const cpNote = narration ? controlPlaneNote(health) : undefined;
  const ns = sim.viewNs;
  const inView = (n?: string) => (ns === "*" ? showSystem || !SYSTEM_NAMESPACES.has(n ?? "") : n === ns);
  const events = sim.events.filter((e) => inView(e.metadata.namespace));
  const pods = c.list<Pod>("Pod").filter((p) => inView(p.metadata.namespace));
  const readyPods = pods.filter((p) => podCategory(p) === "ok").length;
  const svcs = c.list<Service>("Service").filter((s) => inView(s.metadata.namespace) && s.metadata.name !== "kubernetes");
  const nodes = c.list<Node>("Node");
  const readyNodes = nodes.filter((n) => c.nodeReady(n) && c.state.nodes[n.metadata.name]?.up).length;
  const namespaces = c.list<Namespace>("Namespace").map((n) => n.metadata.name).filter((n) => showSystem || !SYSTEM_NAMESPACES.has(n));
  const story = sim.events.filter((e) => isNarrated(e) && inView(e.metadata.namespace)).slice(0, 1);
  // Overlays share two rows (top: summary + narration, bottom: Text view) so they never stack over the diagram;
  // the zoom-to-fit keeps the diagram clear of both rows, the palette column and anything floating over the canvas.
  // Folded, the palette is just its "+ Add" button.
  const topLeft = palette ? (paletteOpen ? BESIDE_PALETTE : EDGE + ADD_W + 8) : EDGE;
  const bottomLeft = paletteColumn ? BESIDE_PALETTE : EDGE;
  const summaryW = 300 + (namespaces.length > 1 ? 150 : 0);
  const roomForNote = canvasW - topLeft - summaryW - EDGE >= 260;
  // The apiserver being unreachable is always said; a control-plane cause (narration only) takes the story's place.
  const banner = unreachable ?? (roomForNote ? cpNote : undefined);
  const showStory = narration && story.length > 0 && roomForNote && !banner;
  const floatInspector = desktop && !!inspector;
  const inset = {
    top: 52,
    bottom: spotlight ? Math.max(60, stackH + 24) : 60,
    left: paletteColumn ? BESIDE_PALETTE - 12 : 0,
    right: floatInspector ? 392 : 0,
  };
  // Phones stack the Nodes so fit-to-screen can show all of them at a readable size.
  const perRow = canvasW > 0 && canvasW < 560 ? 1 : 4;
  // A tall canvas (Split, a tablet held upright) grows the diagram downwards: the workloads wrap over the Nodes.
  const wrap = !spotlight && canvasSize.h > canvasSize.w * 0.7;
  const labels: Record<DockTab, React.ReactNode> = {
    terminal: "Terminal",
    editor: "YAML editor",
    resources: "Resources",
    events: (
      <>
        Events <span className="text-ink-soft">{events.length}</span>
      </>
    ),
    commands: "Commands",
  };
  const tabOptions = [...tabs.map((t) => ({ value: t as string, label: labels[t] })), ...extraTabs.map((t) => ({ value: t.id, label: t.label }))];
  const extra = extraTabs.find((t) => t.id === tab);

  // Replicas set from the canvas go through kubectl, so the command shows in the terminal.
  const scale = (kind: "deployment" | "statefulset", n: string, name: string, replicas: number) => sim.exec(`kubectl scale ${kind} ${name} --replicas=${replicas}${n !== "default" ? ` -n ${n}` : ""}`);
  const view = <ClusterView cluster={c} health={health} packets={sim.packets} slots={sim.slots} now={sim.frameNow} selection={selection} onSelect={onSelect} showSystem={showSystem} namespace={ns} inset={inset} perRow={perRow} wrap={wrap} refit={refit} onScale={interactive ? scale : undefined} />;
  const canvas = (
    <div ref={setCanvasEl} className={`relative h-full min-h-0 w-full overflow-hidden ${apiUp ? "" : "cv-stale"}`}>
      {interactive ? (
        <DragProvider sim={sim}>
          {view}
          {palette && <Palette open={paletteOpen} onToggle={() => setPaletteChoice(!paletteOpen)} width={PALETTE_W} floating={!wide} />}
        </DragProvider>
      ) : (
        view
      )}

      <div className="pointer-events-none absolute top-3 z-10 hidden items-center gap-2 md:flex" style={{ left: topLeft, right: EDGE + (floatInspector ? 392 : 0) }}>
        <div className="flex shrink-0 items-center gap-3 rounded-lg border border-ink/10 bg-paper/95 px-3 py-1.5 text-[13px] text-ink-soft shadow-[0_1px_2px_rgb(15_23_42/0.05)]" aria-label="Cluster summary" data-overlay="summary">
          {[
            [`${readyNodes}/${nodes.length}`, "nodes", readyNodes === nodes.length],
            [`${readyPods}/${pods.length}`, "pods ready", readyPods === pods.length],
            [String(svcs.length), svcs.length === 1 ? "service" : "services", true],
          ].map(([v, k, ok]) => (
            <span key={String(k)} className="whitespace-nowrap">
              <span className={`font-mono tabular-nums ${ok ? "text-ink" : "text-amber-700"}`}>{v}</span> {k}
            </span>
          ))}
          {namespaces.length > 1 && (
            <label className="pointer-events-auto -my-1.5 flex items-center gap-1.5 self-stretch border-l border-ink/10 pl-3">
              namespace
              <select value={ns} onChange={(e) => sim.setViewNs(e.target.value)} className="bg-transparent font-mono text-[12.5px] text-ink outline-none" aria-label="Namespace shown on the canvas">
                <option value="*">all</option>
                {namespaces.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {/* Spotlight's bottom edge belongs to the floating card, so the Text view switch sits up here, clear of the diagram. */}
        {spotlight && <TextViewButton on={textView} onClick={() => setTextView(!textView)} />}
        {banner && (
          <div data-overlay={unreachable ? "unreachable" : "control-plane"} role="status" className="ml-auto flex min-w-0 max-w-[460px] flex-1 items-center gap-2.5 rounded-lg border border-amber-500/40 bg-paper/95 px-3 py-1.5 text-[13px] shadow-[0_1px_2px_rgb(15_23_42/0.05)]" title={banner}>
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
            <span className="line-clamp-2 min-w-0 text-ink">{banner}</span>
          </div>
        )}
        {showStory && (
          <div data-overlay="narration" className="ml-auto flex min-w-0 max-w-[460px] flex-1 items-center gap-2.5 rounded-lg border border-signal/25 bg-paper/95 px-3 py-1.5 text-[13px] shadow-[0_1px_2px_rgb(15_23_42/0.05)]" title={explainEvent(story[0])}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${story[0].type === "Warning" ? "bg-amber-500" : "bg-signal"}`} />
            <span className="min-w-0 truncate text-ink">{explainEvent(story[0])}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-soft">{age(live.now - story[0].lastTimestamp)}</span>
          </div>
        )}
      </div>

      {!spotlight && (
        <div className="pointer-events-none absolute bottom-4 z-10 flex items-end gap-2" style={{ left: bottomLeft, maxWidth: `calc(100% - ${bottomLeft + ZOOM_W}px)` }}>
          <TextViewButton on={textView} onClick={() => setTextView(!textView)} />
        </div>
      )}
      {textView && (
        <div className="absolute inset-y-0 right-0 z-20 w-full max-w-md border-l border-ink/10 bg-paper shadow-[-8px_0_24px_rgb(15_23_42/0.06)]">
          <ClusterText c={c} namespace={ns} showSystem={showSystem} onSelect={onSelect} />
        </div>
      )}
      {inspector && (
        <div
          role="dialog"
          aria-label="Details"
          className={desktop ? "float-card absolute right-3 top-3 z-30 flex w-[380px] flex-col overflow-hidden" : "absolute inset-0 z-30 flex flex-col bg-paper"}
          style={desktop ? { bottom: spotlight ? stackH + 28 : 12 } : undefined}
        >
          <div className="flex h-11 shrink-0 items-center border-b border-ink/10 px-4">
            <button onClick={onCloseInspector} className="text-[14px] text-ink-soft hover:text-ink">
              ← Back
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{inspector}</div>
        </div>
      )}
      {narration && (
        <div className="sr-only" aria-live="polite">
          {story[0] ? explainEvent(story[0]) : ""}
        </div>
      )}
      {/* Centred in the canvas the diagram uses, clear of the palette column. */}
      {overlay && (
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10" style={{ left: inset.left }}>
          {overlay}
        </div>
      )}
    </div>
  );

  const dockBody = (
    <div id="dock-panel" className={`min-h-0 flex-1 ${tab === "terminal" || tab === "editor" ? "" : "overflow-auto px-4 py-2"} ${extra ? "!p-0" : ""}`}>
      {tab === "terminal" && <Terminal sim={sim} quiet={quiet} />}
      {tab === "editor" && <Editor sim={sim} />}
      {tab === "commands" && <CommandLog log={sim.log} />}
      {tab === "resources" && <ResourceTable c={c} namespace={sim.viewNs === "*" ? sim.namespace : sim.viewNs} />}
      {tab === "events" && <EventsTable events={events} now={live.now} />}
      {extra?.render()}
    </div>
  );
  const dockTabs = (collapsible: boolean) => (
    <div className="flex h-11 shrink-0 items-stretch gap-3 overflow-x-auto border-b border-ink/10 px-4">
      <Segmented
        value={tab}
        onChange={(v) => {
          setTab(v);
          setOpen(true);
        }}
        options={tabOptions}
      />
      {collapsible && (
        <button onClick={() => setOpen(!open)} className="ml-auto grid h-7 w-7 shrink-0 place-items-center self-center rounded-md text-ink-soft hover:bg-ink/[0.05] hover:text-ink" aria-label={open ? "Collapse panel" : "Expand panel"}>
          <svg viewBox="0 0 16 16" className={`h-4 w-4 transition ${open ? "" : "rotate-180"}`} fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
  const sidePanel = side ? (
    <aside aria-label={sideLabel} className="min-h-0 overflow-y-auto">
      {side}
    </aside>
  ) : null;

  // ---------------------------------------------------------------- phones and small tablets: one view at a time
  if (!desktop) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper">
        {sideAboveOnMobile && sidePanel && <div className="flex max-h-[45vh] shrink-0 flex-col border-b border-ink/10">{sidePanel}</div>}
        {mobileView === "side" && sidePanel && <div className="flex min-h-0 flex-1 flex-col">{sidePanel}</div>}
        {mobileView === "canvas" && <div className="min-h-0 flex-1">{canvas}</div>}
        {mobileView === "dock" && allTabs.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col">
            {dockTabs(false)}
            {dockBody}
          </div>
        )}
      </main>
    );
  }

  // ---------------------------------------------------------------- Spotlight
  if (spotlight) {
    return (
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        {canvas}
        {(sidePanel || allTabs.length > 0) && (
          <div
            ref={setStackEl}
            className={`float-card absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 overflow-hidden transition-[height] duration-300 ${sidePanel ? "w-[min(1120px,calc(100%-23rem))]" : "w-[min(820px,calc(100%-23rem))]"} ${open ? "h-[clamp(13rem,31vh,19rem)]" : "h-11"}`}
          >
            {sidePanel && open && <div className="flex w-[46%] min-w-0 shrink-0 flex-col border-r border-ink/10">{sidePanel}</div>}
            {allTabs.length > 0 && (
              <div className="flex min-w-0 flex-1 flex-col">
                {dockTabs(true)}
                {open && dockBody}
              </div>
            )}
          </div>
        )}
      </main>
    );
  }

  // ---------------------------------------------------------------- Split
  const hasSide = !!sidePanel || allTabs.length > 0;
  // The gap is 12px on each side of a splitter; the container loses its padding too.
  const mainW = Math.max(0, mainSize.w - 24 - 12);
  const sideShare = clampShare(sideSplit.share, mainW, SIDE_SPLIT.min1, SIDE_SPLIT.min2);
  const sideW = Math.round(mainW * sideShare);
  const colH = Math.max(0, colSize.h - 12);
  const dockShare = clampShare(dockSplit.share, colH, DOCK_SPLIT.min1, DOCK_SPLIT.min2);
  const dockH = Math.round(colH * dockShare);
  const release = (hook: ReturnType<typeof useShare>, spec: SplitSpec, total: number) => (v: number) => {
    const clamped = clampShare(v, total, spec.min1, spec.min2);
    hook.commit(clamped);
    setRefit((n) => n + 1);
  };
  return (
    <main ref={setMainEl} className="flex min-h-0 min-w-0 flex-1 gap-3 bg-canvas p-3">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-ink/10 bg-paper">{canvas}</div>
      {hasSide && (
        <>
          <Splitter orientation="vertical" label="Resize the cluster and the side panel" share={sideShare} total={mainW} onChange={sideSplit.set} onCommit={release(sideSplit, SIDE_SPLIT, mainW)} onReset={() => { sideSplit.reset(); setRefit((n) => n + 1); }} />
          <div ref={setColEl} className="flex min-h-0 shrink-0 flex-col gap-3" style={{ width: mainSize.w ? sideW : undefined, minWidth: mainSize.w ? undefined : 420 }}>
            {sidePanel && <div className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-ink/10 bg-paper ${allTabs.length ? "" : "flex-1"}`} style={allTabs.length ? { flex: "1 1 0" } : undefined}>{sidePanel}</div>}
            {sidePanel && allTabs.length > 0 && (
              <Splitter orientation="horizontal" label="Resize the panel and the terminal" share={dockShare} total={colH} onChange={dockSplit.set} onCommit={release(dockSplit, DOCK_SPLIT, colH)} onReset={dockSplit.reset} />
            )}
            {allTabs.length > 0 && (
              <div className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-ink/10 bg-paper ${sidePanel ? "" : "flex-1"}`} style={sidePanel ? { flex: "0 0 auto", height: colSize.h ? dockH : undefined, minHeight: colSize.h ? undefined : 240 } : undefined}>
                {dockTabs(false)}
                {dockBody}
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}

/** A splitter's share: the stored one, or the one being dragged right now; saved when the drag settles. */
function useShare(spec: SplitSpec) {
  const [raw, setRaw] = useStored(spec.key);
  const [live, setLive] = useState<number | null>(null);
  return {
    share: live ?? parseShare(raw, spec.fallback),
    set: setLive,
    commit: (v: number) => {
      setLive(null);
      setRaw(String(Math.round(v * 1000) / 1000));
    },
    reset: () => {
      setLive(null);
      setRaw(null);
    },
  };
}

function TextViewButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={on} data-overlay="text-view" className="pointer-events-auto h-8 shrink-0 rounded-lg border border-ink/15 bg-paper px-2.5 text-[12.5px] text-ink shadow-[0_1px_2px_rgb(15_23_42/0.05)] hover:border-ink/30">
      {on ? "Diagram view" : "Text view"}
    </button>
  );
}

/** Bottom tab bar for small screens. */
export function MobileTabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <nav className="font-sheet flex shrink-0 border-t border-ink/10 bg-paper lg:hidden" aria-label="Views">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={`flex-1 py-3 text-[14px] ${value === o.value ? "text-ink shadow-[inset_0_3px_0_#326ce5]" : "text-ink-soft"}`} aria-current={value === o.value ? "page" : undefined}>
          {o.label}
        </button>
      ))}
    </nav>
  );
}

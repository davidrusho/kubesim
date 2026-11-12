"use client";

// Incident mode: the shop is serving real traffic when something breaks. A pager shows the live
// error rate and the clock; it's resolved once the shop has been healthy for RESOLVE_MS. Nothing
// that names a command is shown up front: the first Hint reveals where to start, each further
// Hint the next one, and the fix stays hidden until asked for.

import Link from "next/link";
import { useEffect, useState } from "react";
import { applyYaml } from "@/lib/kubectl/kubectl";
import { INCIDENTS, RESOLVE_MS, clock, incidentBySlug, shopProblem, shopTraffic, shopYaml } from "@/lib/sim/incidents";
import { useSimulation } from "@/lib/sim/useSimulation";
import { SITE_URL } from "@/lib/site";
import { AppHeader } from "../AppHeader";
import { Burst } from "../Burst";
import { Btn } from "../ui";
import type { Selection } from "../sim/ClusterView";
import { Inspector } from "../sim/Inspector";
import { LayoutToggle, MobileTabs, SimControls, Workspace, useLayoutChoice } from "../sim/Workspace";
import { DIFFICULTY } from "./difficulty";
import { dailyStreak, saveIncident, type IncidentResult } from "./incidentProgress";
import { ladder } from "@/lib/lessons/hints";
import { HintLadder, ScrollOnMount } from "./HintLadder";
import { Prose } from "./Prose";

export function IncidentPlayer({ slug, day, seed = 11 }: { slug: string; /** The Daily Incident's number, when this is it. */ day?: number; seed?: number }) {
  const inc = incidentBySlug(slug)!;
  /**
   * The run, followed frame by frame from the simulation: cluster time the incident started and the
   * command count then (setup commands don't count), whether the outage has shown yet, and since
   * when the shop has been healthy again.
   */
  const [run] = useState<{ at: number | null; history: number; brokeSeen: boolean; healthySince: number | null; done: boolean }>(() => ({ at: null, history: 0, brokeSeen: false, healthySince: null, done: false }));
  const [result, setResult] = useState<(IncidentResult & { streak: number; prev?: IncidentResult }) | null>(null);
  const [hints, setHints] = useState(0);
  const [sawFix, setSawFix] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const [sel, setSel] = useState<Selection>(null);
  const [layout, setLayout] = useLayoutChoice("split");
  const [mobileTab, setMobileTab] = useState<"incident" | "cluster" | "terminal">("incident");
  const sim = useSimulation({
    seed,
    ...(inc.nodes ? { nodes: inc.nodes } : {}),
    setup: (c) => void applyYaml({ cluster: c, namespace: "default", files: {} }, shopYaml(), undefined, undefined, "shop.yaml"),
    warmupMs: 60_000,
    files: { "shop.yaml": shopYaml() },
    onStart: (s) => {
      inc.break(s.cluster!);
      Object.assign(run, { at: s.cluster!.now, history: s.history.length, brokeSeen: false, healthySince: null, done: false });
    },
    onReset: () => {
      setResult(null);
      setHints(0);
      setSawFix(false);
    },
  });
  const c = sim.cluster;
  const problem = c ? shopProblem(c) : null;
  const traffic = c ? shopTraffic(c) : { rps: 0, err: 0 };
  const now = c?.now ?? 0;
  const elapsed = run.at !== null ? now - run.at : 0;

  // Follow the outage on every simulation update: it shows, the shop gets healthy again, and after RESOLVE_MS of that it's resolved.
  useEffect(() => {
    const unsubscribe = sim.subscribe(() => {
        const cl = sim.cluster;
        if (!cl || run.at === null || run.done) return;
        if (shopProblem(cl)) {
          run.brokeSeen = true;
          run.healthySince = null;
          return;
        }
        if (!run.brokeSeen) return;
        run.healthySince ??= cl.now;
        if (cl.now - run.healthySince < RESOLVE_MS) return;
        run.done = true;
        const r: IncidentResult = { ms: run.healthySince - run.at, hints, commands: Math.max(0, sim.history.length - run.history), sawFix };
        const prev = saveIncident(inc.slug, r, day);
        setResult({ ...r, prev, streak: day ? dailyStreak(day) : 0 });
        setCelebrate((n) => n + 1);
      });
    return () => void unsubscribe();
  }, [sim, run, hints, sawFix, inc.slug, day]);

  if (!c) return <div className="font-sheet flex h-dvh items-center justify-center bg-paper text-[14px] text-ink-soft">Starting the shop…</div>;

  const runCmd = (cmd: string) => {
    sim.exec(cmd);
    setMobileTab("terminal");
  };
  const d = DIFFICULTY[inc.difficulty];
  const recovering = !result && run.brokeSeen && !problem && run.healthySince !== null ? now - run.healthySince : null;
  const state = result ? "resolved" : recovering !== null ? "recovering" : run.brokeSeen ? "down" : "brewing";
  const next = INCIDENTS[INCIDENTS.findIndex((x) => x.slug === inc.slug) + 1];
  const rungs = ladder(inc.hints, inc.start);

  return (
    <div className="font-sheet flex h-dvh flex-col overflow-hidden bg-paper text-ink">
      <AppHeader
        trail={[{ href: "/incidents", label: "Incidents" }, { label: day ? `Daily #${day}` : inc.title }]}
        center={<SimControls sim={sim} />}
        right={
          <>
            <LayoutToggle value={layout} onChange={setLayout} />
            <Btn
              onClick={() => {
                if (!result && sim.history.length && !window.confirm("Start this incident over? The shop breaks again and the clock restarts.")) return;
                sim.reset();
                setSel(null);
              }}
            >
              Start over
            </Btn>
          </>
        }
      />
      <Workspace
        sim={sim}
        selection={sel}
        onSelect={setSel}
        inspector={sel && <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} quiet />}
        onCloseInspector={() => setSel(null)}
        tabs={["terminal", "editor", "events", "resources"]}
        layout={layout}
        quiet
        // The cluster's one-line status names the cause: it appears with the second hint, or once resolved.
        narration={hints >= 2 || !!result}
        palette
        mobileView={mobileTab === "cluster" ? "canvas" : mobileTab === "incident" ? "side" : "dock"}
        sideLabel="Incident"
        side={
          <>
            <Pager state={state} page={inc.page} elapsed={result ? result.ms : elapsed} rps={traffic.rps} err={traffic.err} problem={problem} recovering={recovering} />
            {result && <Resolved result={result} slug={inc.slug} title={inc.title} day={day} debrief={inc.debrief} celebrate={celebrate} next={next && !day ? { href: `/incidents/${next.slug}`, title: next.title } : undefined} />}
            <div className="border-b border-ink/10 px-5 py-4">
              <p className="text-[13px] text-ink-soft">
                {day ? `Daily Incident #${day}` : "Incident"} · <span className={`rounded border px-1.5 py-px text-[11.5px] ${d.cls}`}>{d.label}</span>
              </p>
              <h1 className="font-display mt-1 text-[22px] leading-tight">{inc.title}</h1>
              <div className="mt-3">
                <Prose text={inc.brief} onRun={runCmd} />
              </div>
            </div>
            {!result && (
              <>
                {hints > 0 && (
                  <div className="px-5 pt-4">
                    <HintLadder rungs={rungs} shown={hints} onRun={runCmd} />
                  </div>
                )}
                {/* A direct child of the panel, so it stays pinned to its foot and Hint is in reach however short the panel is dragged. */}
                <div className="sticky bottom-0 z-10 flex flex-wrap gap-1.5 border-t border-ink/10 bg-paper px-5 py-3">
                  {hints < rungs.length && (
                    <Btn tone="primary" onClick={() => setHints((n) => n + 1)}>
                      {hints ? "Another hint" : "Hint"}
                    </Btn>
                  )}
                  {!sawFix && <Btn onClick={() => setSawFix(true)}>Show the fix</Btn>}
                </div>
                {sawFix && (
                  <div className="px-5 pb-4">
                    <ScrollOnMount>
                      <div className="mb-1.5 text-[13px] text-ink-soft">One way to fix it:</div>
                      <Prose text={inc.fix} onRun={runCmd} onEdit={(y) => sim.openFile("fix.yaml", y)} />
                    </ScrollOnMount>
                  </div>
                )}
              </>
            )}
          </>
        }
      />
      <MobileTabs
        value={mobileTab}
        onChange={setMobileTab}
        options={[
          { value: "incident", label: result ? "Resolved" : `Incident ${clock(elapsed)}` },
          { value: "cluster", label: "Cluster" },
          { value: "terminal", label: "Terminal" },
        ]}
      />
    </div>
  );
}

/** The pager: what's wrong, live numbers, and the clock. */
function Pager({ state, page, elapsed, rps, err, problem, recovering }: { state: "brewing" | "down" | "recovering" | "resolved"; page: string; elapsed: number; rps: number; err: number; problem: string | null; recovering: number | null }) {
  const tone = state === "resolved" ? "border-green-200 bg-green-50" : state === "recovering" ? "border-amber-200 bg-amber-50" : "border-red-200 bg-red-50";
  const dot = state === "resolved" ? "bg-green-600" : state === "recovering" ? "bg-amber-500" : "bg-red-600 cv-blink";
  const label = state === "resolved" ? "Resolved" : state === "recovering" ? "Recovering" : "Paged";
  return (
    <div className={`sticky top-0 z-10 border-b px-5 py-3.5 ${tone}`} role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em]">
          <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
          {label}
        </span>
        <span className="font-mono text-[20px] font-semibold tabular-nums" aria-label={`Time ${clock(elapsed)}`}>
          {clock(elapsed)}
        </span>
      </div>
      <div className="mt-1 text-[15px] font-medium">{state === "resolved" ? "The shop is serving again." : page}</div>
      <div className="mt-2 flex items-baseline gap-5 font-mono tabular-nums">
        <span>
          <span className={`text-[22px] font-semibold ${err >= 0.01 ? "text-red-700" : "text-green-700"}`}>{Math.round(err * 100)}%</span>
          <span className="ml-1 text-[11px] uppercase tracking-[0.06em] text-ink-soft">errors</span>
        </span>
        <span>
          <span className="text-[22px] font-semibold">{rps < 10 ? rps.toFixed(1) : Math.round(rps)}</span>
          <span className="ml-1 text-[11px] uppercase tracking-[0.06em] text-ink-soft">req/s</span>
        </span>
      </div>
      {state !== "resolved" && (
        <div className="mt-1.5 text-[12.5px] text-ink-soft">
          {state === "recovering" ? `Healthy for ${Math.floor((recovering ?? 0) / 1000)}s of ${RESOLVE_MS / 1000}s…` : state === "brewing" ? "Something just changed. Watch the numbers." : problem}
        </div>
      )}
    </div>
  );
}

function Resolved({ result, slug, title, day, debrief, celebrate, next }: { result: IncidentResult & { streak: number; prev?: IncidentResult }; slug: string; title: string; day?: number; debrief: string; celebrate: number; next?: { href: string; title: string } }) {
  const [copied, setCopied] = useState(false);
  const how = result.sawFix ? "after peeking at the fix" : result.hints ? `with ${result.hints} hint${result.hints > 1 ? "s" : ""}` : "with no hints";
  const url = day ? `${SITE_URL}/daily/` : `${SITE_URL}/incidents/${slug}/`;
  const text = day
    ? `kubesim Daily Incident #${day}: "${title}"\nResolved in ${clock(result.ms)}, ${result.commands} commands, ${how}.${result.streak > 1 ? `\n${result.streak}-day streak` : ""}`
    : `I fixed "${title}" in a simulated Kubernetes cluster in ${clock(result.ms)}, ${how}.`;
  const beat = result.prev && !result.sawFix && result.ms < result.prev.ms;
  return (
    <div className="relative border-b border-ink/10 px-5 py-5">
      <Burst shot={celebrate} pieces={30} spread={150} />
      <div className="font-display text-[20px]">Resolved in {clock(result.ms)}</div>
      <p className="mt-1 text-[14px] text-ink-soft">
        {result.commands} command{result.commands === 1 ? "" : "s"}, {how}.{beat ? ` Your best before was ${clock(result.prev!.ms)}.` : ""}
        {day && result.streak > 1 ? ` ${result.streak}-day streak.` : ""}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer" className="btn-primary inline-flex h-9 items-center rounded-lg px-3.5 text-[14px] font-medium text-white">
          Share on X
        </a>
        <Btn
          onClick={() => {
            navigator.clipboard?.writeText(`${text}\n${url}`).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy result"}
        </Btn>
        {next && (
          <Link href={next.href} className="inline-flex h-9 items-center rounded-lg border border-ink/15 px-3.5 text-[14px] font-medium hover:border-ink/30">
            Next: {next.title} →
          </Link>
        )}
      </div>
      <h2 className="mt-6 text-[15.5px] font-medium">What happened</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">{debrief}</p>
      {day && <p className="mt-4 text-[13px] text-ink-soft">A new Daily Incident starts at midnight UTC.</p>}
    </div>
  );
}

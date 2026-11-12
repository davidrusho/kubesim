"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { lessonBySlug, solutionCommands } from "@/lib/lessons/lessons";
import { CURRICULUM, curriculumIndex } from "@/lib/lessons/curriculum";
import { useSimulation } from "@/lib/sim/useSimulation";
import { AppHeader } from "../AppHeader";
import { Btn, StepMark } from "../ui";
import type { Selection } from "../sim/ClusterView";
import { Inspector } from "../sim/Inspector";
import { LayoutToggle, MobileTabs, SimControls, Workspace, useLayoutChoice } from "../sim/Workspace";
import { Prose } from "./Prose";
import { Burst } from "../Burst";
import { loadPassed, savePassed } from "./progress";
import { replaySteps } from "@/lib/lessons/replay";
import { prefersReducedMotion, safeCheck } from "./checks";
import { capture } from "@/lib/posthog-client";

export function LessonPlayer({ slug }: { slug: string }) {
  const lesson = lessonBySlug(slug)!;
  const [passed, setPassed] = useState<number[]>([]);
  const [restoring, setRestoring] = useState(false);
  const sim = useSimulation({
    setup: lesson.setup,
    warmupMs: lesson.warmupMs ?? 0,
    seed: 7,
    editor: lesson.editor,
    onReset: () => savePassed(slug, [], lesson.steps.length),
    // Restore saved progress: replay the passed Steps' solutions so the cluster matches.
    onStart: (s) => {
      const saved = loadPassed(slug);
      const n = saved.length && saved.every((i, k) => i === k) ? saved.length : 0;
      let restored = 0;
      if (n) {
        try {
          s.history = replaySteps(lesson, s.cluster!, n);
          restored = n;
        } catch {
          savePassed(slug, [], lesson.steps.length);
        }
      }
      setPassed(Array.from({ length: restored }, (_, i) => i));
      setRestoring(restored > 0);
    },
  });
  const [sel, setSel] = useState<Selection>(null);
  const [hint, setHint] = useState(false);
  /** Counts steps passed in this visit (not restored ones): each one gets a little burst. */
  const [celebrate, setCelebrate] = useState(0);
  const [solving, setSolving] = useState<{ step: number; boosted: boolean } | null>(null);
  const [layout, setLayout] = useLayoutChoice("split");
  const [mobileTab, setMobileTab] = useState<"steps" | "cluster" | "terminal">("steps");
  const c = sim.cluster;
  const current = lesson.steps.findIndex((_, i) => !passed.includes(i));
  const done = current === -1;
  const idx = curriculumIndex(slug);
  const next = CURRICULUM[idx + 1];
  const stepRef = useRef<HTMLLIElement>(null);

  // Re-evaluate the current step's Check whenever the cluster changes. A Check that throws counts as "not yet".
  const ok = !!c && !done && safeCheck(() => lesson.steps[current].check({ cluster: c, history: sim.history }));
  useEffect(() => {
    if (!ok) return;
    const t = setTimeout(() => {
      setPassed((p) => {
        if (p.includes(current)) return p;
        const nextPassed = [...p, current];
        savePassed(slug, nextPassed, lesson.steps.length);
        return nextPassed;
      });
      setCelebrate((n) => n + 1);
      setHint(false);
      setSolving((sv) => {
        if (sv?.boosted) sim.setSpeed(1);
        return null;
      });
    }, 450);
    return () => clearTimeout(t);
  }, [ok, current, slug, lesson.steps.length, sim]);
  useEffect(() => {
    stepRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
  }, [passed]);

  const openEditor = (yaml: string) => {
    sim.openFile("manifest.yaml", yaml);
    setMobileTab("terminal");
  };
  const run = (cmd: string) => {
    sim.exec(cmd);
    setMobileTab("terminal");
  };
  const showMe = () => {
    capture("lesson_solution_requested", { lesson_slug: slug, step_number: current + 1 });
    const s = lesson.steps[current].solution;
    // A solution can depend on what earlier commands created (e.g. a NodePort
    // is only known after `expose`): re-plan until it asks for nothing new.
    const ranCmds = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const todo = solutionCommands(lesson.steps[current], c!).filter((cmd) => !ranCmds.has(cmd));
      if (!todo.length) break;
      for (const cmd of todo) {
        ranCmds.add(cmd);
        sim.exec(cmd);
      }
    }
    if (s.yaml) {
      openEditor(s.yaml);
      sim.apply(s.yaml);
    }
    setSolving({ step: current, boosted: false });
  };

  if (!c) return <div className="font-sheet flex h-dvh items-center justify-center bg-paper text-[14px] text-ink-soft">Preparing your cluster…</div>;

  return (
    <div className="font-sheet flex h-dvh flex-col overflow-hidden bg-paper text-ink">
      <AppHeader
        trail={[{ href: "/learn", label: "Lessons" }, { label: lesson.title }]}
        center={<SimControls sim={sim} />}
        right={
          <>
            <LayoutToggle value={layout} onChange={setLayout} />
            <Btn
              onClick={() => {
                if ((passed.length || sim.history.length) && !window.confirm("Start this lesson over? Your progress in it and its cluster are reset.")) return;
                sim.reset();
                setSel(null);
                setSolving(null);
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
        inspector={sel && <Inspector sim={sim} c={c} sel={sel} onSelect={setSel} />}
        onCloseInspector={() => setSel(null)}
        tabs={["terminal", "editor", "events", "resources"]}
        initialTab={lesson.startTab ?? "terminal"}
        layout={layout}
        mobileView={mobileTab === "cluster" ? "canvas" : mobileTab === "steps" ? "side" : "dock"}
        sideLabel="Steps"
        side={
          <>
            <div className="sticky top-0 z-10 border-b border-ink/10 bg-paper px-5 pb-3.5 pt-4">
              <div className="flex items-baseline gap-3">
                <h1 className="font-display min-w-0 flex-1 text-[22px] leading-tight">{lesson.title}</h1>
                <Link href="/learn" className="shrink-0 text-[13px] text-ink-soft hover:text-ink">
                  Lesson {idx + 1} of {CURRICULUM.length}
                </Link>
              </div>
              <div className="relative mt-3 flex items-center gap-3">
                <Burst shot={celebrate} />
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.07]">
                  <div className="h-full rounded-full bg-signal transition-all duration-500" style={{ width: `${(passed.length / lesson.steps.length) * 100}%` }} />
                </div>
                <span data-progress className="font-mono text-[12px] tabular-nums text-ink-soft">
                  {passed.length}/{lesson.steps.length}
                </span>
              </div>
              {restoring && passed.length > 0 && (
                <p className="mt-3 rounded-lg bg-signal-soft px-3 py-2 text-[13px] text-ink">
                  Welcome back. We rebuilt your cluster from the {passed.length} step{passed.length > 1 ? "s" : ""} you finished.
                </p>
              )}
            </div>
            <ol className="pb-2 pt-1">
              {lesson.steps.map((s, i) => {
                const isDone = passed.includes(i);
                const isCur = i === current;
                return (
                  <li key={i} ref={isCur ? stepRef : undefined} className={`scroll-mt-24 px-5 ${isCur ? "py-4" : "py-2.5"}`}>
                    <div className="flex items-center gap-3">
                      <StepMark n={i + 1} state={isDone ? "done" : isCur ? "current" : "todo"} />
                      <span className={`text-[15px] ${isCur ? "font-semibold text-ink" : isDone ? "text-ink-soft" : "text-ink-soft/80"}`}>{s.title}</span>
                      {isCur && ok && <span className="ml-auto text-[13px] font-medium text-green-700">Nice!</span>}
                    </div>
                    {isCur && (
                      <div className="mt-2.5 pl-9">
                        <Prose text={s.body} onRun={run} onEdit={openEditor} />
                        <div className="mt-4 flex items-center gap-2">
                          <span className="flex items-center gap-1.5 text-[13px] text-ink-soft">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
                            Waiting for you…
                          </span>
                          <div className="ml-auto flex gap-1.5">
                            <Btn tone="ghost" onClick={() => setHint(!hint)}>
                              Hint
                            </Btn>
                            <Btn onClick={showMe} title="Runs the commands for this step so you can watch how it is done">
                              Show me
                            </Btn>
                          </div>
                        </div>
                        {solving?.step === i && !ok && (
                          <div className="mt-3 flex items-center gap-2 rounded-lg bg-signal-soft px-3 py-2 text-[13px]">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
                            Solution applied. Waiting for the cluster to catch up…
                            {!solving.boosted && sim.speed < 5 && (
                              <button
                                className="ml-auto rounded-md border border-ink/15 bg-paper px-2 py-0.5 text-[12px] hover:border-ink/40"
                                onClick={() => {
                                  sim.setSpeed(5);
                                  setSolving({ step: i, boosted: true });
                                }}
                              >
                                Skip ahead (5×)
                              </button>
                            )}
                          </div>
                        )}
                        {hint && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{s.hint}</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {done && (
              <div className="relative mx-5 mb-5 mt-2 rounded-xl bg-signal-soft p-5">
                <Burst shot={celebrate} pieces={30} spread={150} />
                <div className="font-display text-[20px]">Lesson complete</div>
                <p className="mt-1 text-[14px] text-ink-soft">You practised: {lesson.concepts.join(", ")}. Keep experimenting on this cluster, or move on.</p>
                <div className="mt-4 flex gap-2">
                  {next ? (
                    <Link href={`/learn/${next.slug}`} className="inline-flex h-9 items-center btn-primary rounded-lg px-3.5 text-[14px] font-medium text-white">
                      Next: {next.title} →
                    </Link>
                  ) : (
                    <Link href="/sandbox" className="inline-flex h-9 items-center btn-primary rounded-lg px-3.5 text-[14px] font-medium text-white">
                      Open the Sandbox →
                    </Link>
                  )}
                </div>
              </div>
            )}
          </>
        }
      />
      <MobileTabs
        value={mobileTab}
        onChange={setMobileTab}
        options={[
          { value: "steps", label: `Steps ${passed.length}/${lesson.steps.length}` },
          { value: "cluster", label: "Cluster" },
          { value: "terminal", label: "Terminal" },
        ]}
      />
    </div>
  );
}

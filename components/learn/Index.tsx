"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { INCIDENTS, clock, dailyIncident } from "@/lib/sim/incidents";
import { CHALLENGES, CURRICULUM, EXAMS, EXAM_TRADEMARK_NOTICE, EXPLAINERS, LESSONS, TRACKS, trackOf, type LessonMeta as Lesson } from "@/lib/lessons/meta";
import { AppHeader } from "../AppHeader";
import { DIFFICULTY } from "./difficulty";
import { challengeKey, examKey, resetAllProgress, useProgress } from "./progress";
import { bestIncident, dailyResult, dailyStreak } from "./incidentProgress";
import { loadUsage, usageSummary } from "./challengeUsage";

function Shell({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <div className="font-sheet min-h-screen bg-paper text-ink">
      <AppHeader sheet />
      <header className="mx-auto max-w-5xl px-6 pb-8 pt-12">
        <h1 className="font-display text-balance text-[40px] leading-[1.05] sm:text-[48px]">{title}</h1>
        <p className="text-pretty mt-3 max-w-2xl text-[17px] leading-snug text-ink-soft">{intro}</p>
      </header>
      <main className="mx-auto max-w-5xl px-6 pb-24">{children}</main>
    </div>
  );
}

/** A ruled list: hairlines between rows, a heavier rule on top. */
const RULED = "border-t border-ink/10 [&>*]:border-b [&>*]:border-ink/10";
/** One row of a ruled list. */
const ROW = "group flex items-start gap-5 px-1 py-4 transition-colors hover:bg-ink/[0.04]";

function LessonRow({ l, i, isNext }: { l: Lesson; i: number; isNext: boolean }) {
  const progress = useProgress();
  const p = progress[l.slug];
  const done = !!p && p.done >= l.steps.length;
  const started = !!p && p.done > 0 && !done;
  return (
    <li>
      <Link href={`/learn/${l.slug}`} className={ROW}>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border font-mono text-[13px] font-medium ${done ? "border-signal bg-signal text-white" : isNext ? "border-signal text-signal" : "border-ink/40 text-ink-soft"}`} aria-label={done ? "Done" : undefined}>
          {done ? "✓" : String(i + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-[17px] font-medium underline-offset-4 group-hover:underline">{l.title}</h3>
            {isNext && <span className="text-[13px] font-medium text-signal">{started ? "Continue" : "Up next"}</span>}
          </div>
          <p className="mt-0.5 text-[14.5px] text-ink-soft">{l.summary}</p>
          <p className="mt-1.5 font-mono text-[11.5px] text-ink-soft">{l.concepts.join(" · ")}</p>
        </div>
        <div className="hidden shrink-0 text-right text-[13px] text-ink-soft sm:block">
          <div>{l.minutes} min</div>
          <div className="mt-0.5 font-mono text-[12px]">
            {p?.done ?? 0}/{l.steps.length} steps
          </div>
        </div>
      </Link>
    </li>
  );
}

export function LessonIndex() {
  const progress = useProgress();
  const firstOpen = CURRICULUM.find((l) => (progress[l.slug]?.done ?? 0) < l.steps.length);
  const doneCount = LESSONS.filter((l) => (progress[l.slug]?.done ?? 0) >= l.steps.length).length;
  return (
    <Shell title="Lessons" intro={`${LESSONS.length} short, hands-on lessons in ${TRACKS.length} tracks. Each one gives you a live cluster, a real kubectl terminal, and checks that tick off as you go. Take the tracks in order; each builds on the last.`}>
      <nav aria-label="Curriculum map" className="mb-10 grid grid-cols-2 rounded-xl border border-ink/10 sm:grid-cols-4 lg:grid-cols-7">
        {TRACKS.map((t) => {
          const ls = LESSONS.filter((l) => trackOf(l) === t.id);
          const d = ls.filter((l) => (progress[l.slug]?.done ?? 0) >= l.steps.length).length;
          return (
            <a key={t.id} href={`#${t.id}`} className="-mb-px -mr-px border-b border-r border-ink/10 p-3 hover:bg-ink/[0.04]">
              <div className="text-[14px] font-medium">{t.title}</div>
              <div className="mt-2 h-1 bg-ink/10" role="progressbar" aria-valuemin={0} aria-valuemax={ls.length} aria-valuenow={d} aria-label={`${t.title}: ${d} of ${ls.length} lessons done`}>
                <div className="h-full rounded-full bg-signal" style={{ width: `${ls.length ? (d / ls.length) * 100 : 0}%` }} />
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-ink-soft">
                {d}/{ls.length}
              </div>
            </a>
          );
        })}
      </nav>
      <p className="-mt-6 mb-10 text-[14px] text-ink-soft">
        {doneCount} of {LESSONS.length} lessons done.{" "}
        <Link href="/progress" className="text-ink underline underline-offset-4 hover:text-signal">
          Your progress
        </Link>
      </p>
      <div className="flex flex-col gap-12">
        {TRACKS.map((t) => {
          const ls = CURRICULUM.map((l, i) => ({ l, i })).filter(({ l }) => trackOf(l) === t.id);
          if (!ls.length) return null;
          return (
            <section key={t.id} id={t.id} aria-labelledby={`h-${t.id}`} className="scroll-mt-20">
              <h2 id={`h-${t.id}`} className="font-display text-[24px]">
                {t.title}
              </h2>
              <p className="mt-0.5 text-[15px] text-ink-soft">{t.blurb}</p>
              <ol className={`mt-4 ${RULED}`}>
                {ls.map(({ l, i }) => (
                  <LessonRow key={l.slug} l={l} i={i} isNext={firstOpen?.slug === l.slug} />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
      <div className="mt-14 grid grid-cols-1 rounded-xl border border-ink/10 sm:grid-cols-2">
        <Link href="/challenges" className="group p-5 hover:bg-ink/[0.04]">
          <div className="text-[17px] font-medium underline-offset-4 group-hover:underline">{CHALLENGES.length} challenges: fix a broken cluster</div>
          <p className="mt-1 text-[14.5px] text-ink-soft">No steps, just a symptom and a goal. Practise troubleshooting.</p>
        </Link>
        <Link href="/exams" className="group border-ink max-sm:border-t sm:border-l p-5 hover:bg-ink/[0.04]">
          <div className="text-[17px] font-medium underline-offset-4 group-hover:underline">{EXAMS.length} timed practice exams</div>
          <p className="mt-1 text-[14.5px] text-ink-soft">Unofficial practice in the style of the CKAD™ and CKA™ exams: independent tasks, a clock, and a score at the end.</p>
        </Link>
      </div>
    </Shell>
  );
}

/** One Challenge on the index. Its concepts name the cause (an ImagePullBackOff, a kubectl command), so they stay hidden until the Challenge is solved. */
export function ChallengeRow({ c, done, mounted }: { c: (typeof CHALLENGES)[number]; done: boolean; mounted: boolean }) {
  return (
    <Link href={`/challenges/${c.slug}`} className={ROW}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h3 className="text-[17px] font-medium underline-offset-4 group-hover:underline">{c.title}</h3>
          {done && <span className="text-[13px] font-medium">✓ Solved{mounted ? ` ${usageSummary(loadUsage(c.slug))}` : ""}</span>}
        </div>
        <p className="mt-0.5 text-[14.5px] leading-snug text-ink-soft">{c.summary}</p>
        {done && <p className="mt-1.5 font-mono text-[11.5px] text-ink-soft">{c.concepts.join(" · ")}</p>}
      </div>
      <span className="shrink-0 text-[13px] text-ink-soft">{c.minutes} min</span>
    </Link>
  );
}

export function ChallengeIndex() {
  const progress = useProgress();
  const mounted = useMounted();
  const solved = CHALLENGES.filter((c) => (progress[challengeKey(c.slug)]?.done ?? 0) >= c.steps.length).length;
  return (
    <Shell title="Challenges" intro={`Each challenge starts with something wrong and a goal, like a ticket from a colleague. There are no steps: investigate with kubectl, find the cause, fix it. Hints, and the fix itself, are there if you're stuck. ${solved} of ${CHALLENGES.length} solved.`}>
      {(["easy", "medium", "hard"] as const).map((level) => {
        const list = CHALLENGES.filter((c) => c.difficulty === level);
        if (!list.length) return null;
        return (
          <section key={level} className="mb-10" aria-labelledby={`h-${level}`}>
            <h2 id={`h-${level}`} className="font-display mb-3 text-[24px]">
              {DIFFICULTY[level].label}
            </h2>
            <div className={RULED}>
              {list.map((c) => (
                <ChallengeRow key={c.slug} c={c} done={(progress[challengeKey(c.slug)]?.done ?? 0) >= c.steps.length} mounted={mounted} />
              ))}
            </div>
          </section>
        );
      })}
      {CHALLENGES.length === 0 && <p className="text-[14px] text-ink-soft">Challenges are on their way.</p>}
    </Shell>
  );
}

/** True once running in the browser: the date and saved results aren't known while prerendering. */
const useMounted = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

/** A still of today's pager (IncidentPlayer's Pager), set into the Daily Incident banner on wider screens. */
function TodayPager({ page, resolvedMs }: { page: string; resolvedMs?: number }) {
  const resolved = resolvedMs !== undefined;
  return (
    <div aria-hidden className={`absolute -bottom-6 right-6 hidden w-[340px] rounded-2xl border px-5 pb-10 pt-4 text-ink shadow-[0_24px_50px_-20px_rgb(10_30_80/0.55)] md:block lg:right-10 lg:w-[420px] ${resolved ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em]">
          <span className={`h-2 w-2 rounded-full ${resolved ? "bg-green-600" : "cv-blink bg-red-600"}`} />
          {resolved ? "Resolved" : "Paged"}
        </span>
        <span className="font-mono text-[20px] font-semibold tabular-nums">{resolved ? clock(resolvedMs) : "0:00"}</span>
      </div>
      <div className="mt-1 text-[15px] font-medium">{resolved ? "The shop is serving again." : page}</div>
      {resolved ? (
        <div className="mt-2 flex items-baseline gap-5 font-mono tabular-nums">
          <span>
            <span className="text-[22px] font-semibold text-green-700">0%</span>
            <span className="ml-1 text-[11px] uppercase tracking-[0.06em] text-ink-soft">errors</span>
          </span>
          <span>
            <span className="text-[22px] font-semibold">10</span>
            <span className="ml-1 text-[11px] uppercase tracking-[0.06em] text-ink-soft">req/s</span>
          </span>
        </div>
      ) : (
        <div className="mt-1.5 text-[13px] text-ink-soft">Something just changed. Watch the numbers.</div>
      )}
    </div>
  );
}

export function IncidentIndex() {
  const mounted = useMounted();
  const today = mounted ? dailyIncident() : null;
  const done = today ? dailyResult(today.n) : undefined;
  const streak = today ? dailyStreak(today.n) : 0;
  return (
    <Shell title="Incidents" intro="A small shop runs in the cluster: a website, an API, Postgres and Redis, with customers sending real traffic. Then something breaks and you're paged. Find the cause with kubectl and fix it against the clock; it's resolved once the shop has served cleanly for 15 seconds.">
      <Link href="/daily" className="group relative mb-10 block overflow-hidden rounded-2xl bg-signal p-6 text-white transition-colors hover:bg-[#2a5bc4]">
        <div className="md:max-w-[46%] lg:max-w-[52%]">
          <div className="font-mono text-[12px] uppercase tracking-[0.08em] text-white/75">{today ? `Daily Incident #${today.n}` : "Daily Incident"}</div>
          <div className="font-display mt-1 text-[26px] leading-tight">{done ? `Resolved in ${clock(done.ms)}` : "Today's outage is waiting"}</div>
          <p className="mt-1.5 max-w-xl text-[15px] text-white/85">
            {done ? "Come back tomorrow for the next one." : "One incident a day, the same for everyone. Fix it, share your time, keep your streak going."}
            {streak > 0 ? ` ${streak}-day streak.` : ""}
          </p>
          <span className="mt-4 inline-flex h-9 items-center rounded-full bg-white px-4 text-[14px] font-medium text-[#123a9c]">{done ? "See it again →" : "Start today's incident →"}</span>
        </div>
        {/* Today's pager, running off the banner's foot: what you'll see when you start. */}
        {today && <TodayPager page={today.incident.page} resolvedMs={done?.ms} />}
      </Link>
      <div className={RULED}>
        {INCIDENTS.map((inc) => {
          const best = mounted ? bestIncident(inc.slug) : undefined;
          return (
            <Link key={inc.slug} href={`/incidents/${inc.slug}`} className={ROW}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h2 className="text-[17px] font-medium underline-offset-4 group-hover:underline">{inc.title}</h2>
                  <span className={`rounded border px-1.5 py-px text-[11.5px] ${DIFFICULTY[inc.difficulty].cls}`}>{DIFFICULTY[inc.difficulty].label}</span>
                </div>
                <p className="mt-0.5 text-[14.5px] leading-snug text-ink-soft">{inc.brief}</p>
              </div>
              <span className="shrink-0 font-mono text-[12.5px] text-ink-soft">{best ? `best ${clock(best.ms)} · ${best.sawFix ? "fix shown" : best.hints ? `${best.hints} hint${best.hints > 1 ? "s" : ""}` : "no hints"}` : ""}</span>
            </Link>
          );
        })}
      </div>
    </Shell>
  );
}

export function ExamIndex() {
  const progress = useProgress();
  return (
    <Shell title="Practice exams" intro="Unofficial practice exams in the style of the CKAD™ and CKA™: a fixed time, a list of independent tasks worth different points, and a score at the end. There are no hints while the clock runs. These aren't the real exams and aren't endorsed by their makers, but many of the core skills are the same.">
      <div className={RULED}>
        {EXAMS.map((e) => {
          const best = progress[examKey(e.slug)]?.done;
          return (
            <Link key={e.slug} href={`/exams/${e.slug}`} className={`${ROW} flex-col gap-2 sm:flex-row sm:gap-5`}>
              <div className="min-w-0 flex-1">
                <h2 className="text-[19px] font-medium underline-offset-4 group-hover:underline">{e.title}</h2>
                <p className="mt-1 text-[14.5px] leading-snug text-ink-soft">{e.summary}</p>
              </div>
              <div className="flex shrink-0 gap-4 font-mono text-[12px] text-ink-soft sm:mt-1 sm:flex-col sm:gap-0.5 sm:text-right">
                <span>{e.minutes} min</span>
                <span>{e.tasks.length} tasks</span>
                <span>pass {e.passPercent}%</span>
                {best !== undefined && <span className={best >= e.passPercent ? "font-medium text-ink" : ""}>best {best}%</span>}
              </div>
            </Link>
          );
        })}
      </div>
      {EXAMS.length === 0 && <p className="text-[14px] text-ink-soft">Practice exams are on their way.</p>}
      <p className="mt-10 text-[12.5px] leading-relaxed text-ink-soft">{EXAM_TRADEMARK_NOTICE}</p>
    </Shell>
  );
}

export function ProgressPage() {
  const progress = useProgress();
  const lessonsDone = LESSONS.filter((l) => (progress[l.slug]?.done ?? 0) >= l.steps.length).length;
  const stepsDone = LESSONS.reduce((a, l) => a + Math.min(progress[l.slug]?.done ?? 0, l.steps.length), 0);
  const stepsTotal = LESSONS.reduce((a, l) => a + l.steps.length, 0);
  const solved = CHALLENGES.filter((c) => (progress[challengeKey(c.slug)]?.done ?? 0) >= c.steps.length).length;
  const next = CURRICULUM.find((l) => (progress[l.slug]?.done ?? 0) < l.steps.length);
  const stats = [
    ["Lessons", `${lessonsDone}/${LESSONS.length}`, `${stepsDone} of ${stepsTotal} steps`],
    ["Challenges", `${solved}/${CHALLENGES.length}`, "solved"],
    ["Practice exams", `${EXAMS.filter((e) => (progress[examKey(e.slug)]?.done ?? -1) >= e.passPercent).length}/${EXAMS.length}`, "passed"],
  ];
  return (
    <Shell title="Your progress" intro="Everything here is stored in this browser only. There are no accounts, so clearing site data (or the button below) starts you over.">
      <dl className="grid grid-cols-1 rounded-xl border border-ink/10 sm:grid-cols-3">
        {stats.map(([k, v, sub]) => (
          <div key={k} className="border-ink p-4 max-sm:[&+&]:border-t sm:[&+&]:border-l">
            <dt className="text-[12px] text-ink-soft">{k}</dt>
            <dd className="mt-1 font-mono text-[26px] font-medium">{v}</dd>
            <dd className="text-[13.5px] text-ink-soft">{sub}</dd>
          </div>
        ))}
      </dl>
      {next && (
        <Link href={`/learn/${next.slug}`} className="group mt-6 block btn-primary rounded-xl p-4 text-white">
          <span className="text-[13.5px] opacity-80">Up next</span>
          <span className="block text-[18px] font-medium">{next.title}</span>
        </Link>
      )}
      <section className="mt-10" aria-labelledby="h-map">
        <h2 id="h-map" className="font-display text-[24px]">
          Curriculum map
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-2">
          {TRACKS.map((t) => {
            const ls = LESSONS.filter((l) => trackOf(l) === t.id);
            if (!ls.length) return null;
            return (
              <div key={t.id}>
                <div className="border-b border-ink/10 pb-1 text-[16px] font-medium">{t.title}</div>
                <ul className="flex flex-col [&>li]:border-b [&>li]:border-ink/10">
                  {ls.map((l) => {
                    const p = progress[l.slug];
                    const done = !!p && p.done >= l.steps.length;
                    return (
                      <li key={l.slug}>
                        <Link href={`/learn/${l.slug}`} className="flex items-center gap-2 px-1 py-1.5 text-[14.5px] hover:bg-ink/[0.04]">
                          <span className={`grid h-4 w-4 place-items-center rounded-lg border text-[9px] ${done ? "border-signal bg-signal text-white" : p?.done ? "border-signal" : "border-ink/30"}`} aria-hidden="true">
                            {done ? "✓" : ""}
                          </span>
                          <span className={done ? "text-ink-soft" : ""}>{l.title}</span>
                          <span className="sr-only">{done ? "(done)" : p?.done ? "(started)" : "(not started)"}</span>
                          <span className="ml-auto font-mono text-[11px] text-ink-soft">
                            {Math.min(p?.done ?? 0, l.steps.length)}/{l.steps.length}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
      <button
        className="mt-10 rounded-lg border border-red-300 px-3 py-1.5 text-[13.5px] font-medium text-red-700 hover:bg-red-50"
        onClick={() => {
          if (window.confirm("Forget all Lesson, Challenge and exam progress on this device?")) resetAllProgress();
        }}
      >
        Reset all progress
      </button>
    </Shell>
  );
}

const GLYPH: Record<string, React.ReactNode> = {
  "self-healing": <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />,
  scaling: <path d="M4 18h4v-4H4zM10 18h4v-8h-4zM16 18h4V6h-4z" />,
  "rolling-update": <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  "service-load-balancing": <path d="M12 4v5M12 9l-6 6M12 9l6 6M12 9v6M6 15v5M18 15v5M12 15v5" />,
  "node-failure": <path d="M12 3v7M7.5 6.5a7 7 0 1 0 9 0" />,
  crashloop: <path d="M12 8v5M12 16.5v.5M10.3 3.9L2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  "readiness-vs-liveness": <path d="M3 12h4l2-5 4 10 2-5h6" />,
  autoscaling: <path d="M4 20V10M10 20V6M16 20V13M3 5l6-2 6 3 6-3" />,
  "statefulset-ordering": <path d="M5 5h14v4H5zM5 10h14v4H5zM5 15h14v4H5z" />,
  "ingress-routing": <path d="M3 12h9M12 12l6-6M12 12l6 6M20 4v4M20 16v4" />,
  "network-policy": <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z M9 12l2 2 4-4" />,
};

export function ExplainerIndex() {
  return (
    <Shell title="Explainers" intro="Short narrated scenarios running on a real simulated cluster. Sit back and watch each concept play out step by step, then pause, change speed, or click anything to dig in.">
      <div className={RULED}>
        {EXPLAINERS.map((e) => (
          <Link key={e.id} href={`/explainers/${e.id}`} className={ROW}>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-ink/10">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                {GLYPH[e.id] ?? <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />}
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] font-medium underline-offset-4 group-hover:underline">{e.title}</h2>
              <p className="mt-0.5 text-[14.5px] leading-snug text-ink-soft">{e.summary}</p>
            </div>
            <div className="hidden shrink-0 text-right text-[13px] text-ink-soft sm:block">
              <div>{e.concept}</div>
              <div className="mt-0.5 font-mono text-[12px]">{e.beats(e.param?.default ?? 0).length} steps</div>
            </div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}

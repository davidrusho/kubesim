// Replays Lesson Step solutions against a cluster. Used to restore a
// Learner's saved progress, and by the "every Lesson is solvable" test.

import type { Cluster } from "@/lib/engine";
import { applyYaml, runKubectl } from "@/lib/kubectl/kubectl";
import { solutionCommands, type Lesson, type Step } from "./lessons";

/** Runs the solutions of the first `count` Steps; returns the command history. Throws if a Step can't be reached. */
export function replaySteps(lesson: Pick<Lesson, "slug"> & { steps: Pick<Step, "title" | "check" | "solution">[] }, c: Cluster, count: number, history: string[] = []): string[] {
  const ctx = { cluster: c, namespace: "default" };
  for (let i = 0; i < count; i++) {
    const step = lesson.steps[i];
    for (let attempt = 0; attempt < 3 && !step.check({ cluster: c, history }); attempt++) {
      for (const cmd of solutionCommands(step, c)) {
        history.push(cmd);
        runKubectl(ctx, cmd);
      }
      if (step.solution.yaml) {
        history.push("kubectl apply -f manifest.yaml");
        const r = applyYaml(ctx, step.solution.yaml);
        if (!r.ok) throw new Error(`${lesson.slug} step ${i + 1}: ${r.out}`);
      }
      for (let t = 0; t < 120 && !step.check({ cluster: c, history }); t++) c.advance(1000);
    }
    if (!step.check({ cluster: c, history })) throw new Error(`${lesson.slug} step ${i + 1} "${step.title}" did not pass`);
  }
  return history;
}

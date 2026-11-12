// The hint ladder shared by Incidents and Challenges. Nothing that tells the Learner which
// command to run is shown until they press Hint: the first press reveals "Where to start"
// (read-only commands), each further press the next hint, and "Show the fix" is the last rung.

/** A first look that fits any outage or broken cluster. */
export const START_COMMANDS = ["kubectl get pods -o wide", "kubectl get events --sort-by=.lastTimestamp"];

export interface Rung {
  label: string;
  /** Prose markdown (tiny: paragraphs, `code`, ```bash fences). */
  text: string;
}

/** The "Where to start" rung: read-only commands, with Run buttons once revealed. */
export const startRung = (commands: string[] = START_COMMANDS): Rung => ({
  label: "Where to start",
  text: "Look before you change anything. These only read the cluster.\n\n```bash\n" + commands.join("\n") + "\n```",
});

/** The whole ladder: "Where to start" first, then every hint. */
export function ladder(hints: string[], start: string[] = START_COMMANDS): Rung[] {
  return [startRung(start), ...hints.map((text, i) => ({ label: `Hint ${i + 1}`, text }))];
}

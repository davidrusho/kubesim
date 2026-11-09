// Small pieces shared by the Concept Illustration renderer and its tests.

/** Where the official Kubernetes icons are served from (files live in public/icons/k8s/). */
export const ICON_DIR = "/icons/k8s/";

export type StatusTone = "ok" | "warn" | "bad" | "idle";

/** Health colour for a status word as `kubectl get pods` prints it: green running, amber starting, red failing. */
export function statusTone(status: string | undefined): StatusTone {
  if (!status) return "idle";
  // Running but not Ready yet (kubectl prints 0/1) is still starting.
  if (/^upgrading/i.test(status)) return "warn";
  if (/^upgraded/i.test(status)) return "ok";
  if (/^v\d/i.test(status)) return "idle";
  if (/^running\s+0\//i.test(status)) return "warn";
  if (/^(running|ready|bound|active|available|healthy|succeeded|complete)/i.test(status)) return "ok";
  if (/^(pending|containercreating|podinitializing|init|starting|terminating|waiting|unknown)/i.test(status)) return "warn";
  if (/^(crashloop|error|err|failed|failing|imagepull|oomkilled|evicted|notready|not ready|unhealthy|unschedulable)/i.test(status)) return "bad";
  return "idle";
}

/** Height reserved at the bottom of a scene for its legend. */
export const LEGEND_H = 24;

/** The rectangle a scene's legend can occupy (every entry showing at once), or null if it has none. */
export function legendRect(scene: { width: number; height: number; legend?: boolean; edges: { kind?: string; cross?: string }[]; steps?: { block?: string[] }[] }): { x: number; y: number; w: number; h: number } | null {
  if (!scene.legend) return null;
  const texts = ["traffic", "owns or refers to", "blocked", "crosses the cluster boundary"].filter((t) => (t === "traffic" ? scene.edges.some((e) => e.kind !== "owns") : t === "owns or refers to" ? scene.edges.some((e) => e.kind === "owns") : t === "blocked" ? !!scene.steps?.some((x) => x.block?.length) : scene.edges.some((e) => e.cross)));
  const w = texts.reduce((a, t) => a + 30 + t.length * 7.2 + 16, 6);
  return { x: 0, y: scene.height - LEGEND_H - 4, w, h: LEGEND_H + 4 };
}

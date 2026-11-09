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
  if (/^(crashloop|error|err|failed|failing|exited|not running|unavailable|imagepull|oomkilled|evicted|notready|not ready|unhealthy|unschedulable)/i.test(status)) return "bad";
  return "idle";
}

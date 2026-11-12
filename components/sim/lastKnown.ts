"use client";

// While the apiserver does not answer, the Cluster View must not keep reading live state: nothing outside the node
// could read it. It draws the last picture it read while the apiserver was up, and the screen marks it stale.

import { useState } from "react";
import { Cluster } from "@/lib/engine";

/** A copy is taken at most this often (wall-clock ms) while the apiserver answers, so it is never much older than the moment it went down. */
export const COPY_EVERY_MS = 1500;

interface Copy {
  of: Cluster;
  copy: Cluster;
  at: number;
}

/** Whether a new copy is due: none yet, one of another cluster (a reset or a loaded link), or an old one. */
export function copyDue(known: Copy | null, c: Cluster, nowMs: number): boolean {
  return !known || known.of !== c || nowMs - known.at >= COPY_EVERY_MS;
}

/** What to draw: the live cluster while the apiserver answers (or when no copy of this cluster was ever taken), else the last copy. */
export function picture(known: Copy | null, c: Cluster, apiUp: boolean): Cluster {
  return apiUp || !known || known.of !== c ? c : known.copy;
}

/** Keeps the copy between renders. Outside React state on purpose: taking a copy is a cache fill, not something the screen should re-render for. */
export class KnownPicture {
  private known: Copy | null = null;

  /** Call on every render with the live cluster and whether the apiserver answers; returns the cluster to draw. */
  view(c: Cluster, apiUp: boolean, nowMs: number): Cluster {
    if (apiUp && copyDue(this.known, c, nowMs)) this.known = { of: c, copy: new Cluster(c.snapshot()), at: nowMs };
    return picture(this.known, c, apiUp);
  }
}

/** `frameNowMs` is the simulation's frame clock (wall-clock milliseconds), which is what a copy's age is counted in. */
export function useLastKnown(c: Cluster, apiUp: boolean, frameNowMs: number): Cluster {
  const [kp] = useState(() => new KnownPicture());
  return kp.view(c, apiUp, frameNowMs);
}

import { expect, test } from "bun:test";
import { Cluster, EXAM_NODES, type Pod } from "@/lib/engine";
import { hostWrite } from "@/lib/engine/host";
import { controlPlaneHealth } from "@/lib/engine";
import { COPY_EVERY_MS, KnownPicture } from "./lastKnown";

const APISERVER = "/etc/kubernetes/manifests/kube-apiserver.yaml";
const apiserverPod = (c: Cluster) => c.raw("Pod", "kube-system", "kube-apiserver-controlplane") as unknown as Pod | undefined;

test("while the apiserver is down the canvas draws the last picture it read, not the live cluster (ADR 0003, decision 5)", () => {
  const c = new Cluster({ seed: 5, systemPods: true, nodes: EXAM_NODES });
  c.advance(20_000);
  const kp = new KnownPicture();
  const t0 = 10_000;
  const seen = c.now; // the simulated time of the picture the copy is taken from
  // Up: the live cluster is drawn, and a copy is taken for later.
  expect(kp.view(c, true, t0)).toBe(c);
  // The apiserver's manifest breaks. Its Pod is replaced, so the live cluster no longer shows it Running.
  const h = c.state.hosts.controlplane;
  hostWrite(h, APISERVER, h.files[APISERVER].content.replace("--secure-port=6443", "--secure-port=6444"), c.now);
  c.advance(30_000);
  expect(controlPlaneHealth(c).api).toBe(false);
  const drawn = kp.view(c, false, t0 + 31_000);
  expect(drawn).not.toBe(c);
  expect(apiserverPod(drawn)?.status?.phase).toBe("Running");
  expect(drawn.now).toBe(seen); // the picture of the moment before, not of now
  // And it stays that picture however long the outage lasts: later changes are not read.
  c.advance(30_000);
  expect(kp.view(c, false, t0 + 90_000).now).toBe(seen);
  // Back up: the live cluster again.
  hostWrite(h, APISERVER, h.files[APISERVER].content.replace("--secure-port=6444", "--secure-port=6443"), c.now);
  c.advance(40_000);
  expect(controlPlaneHealth(c).api).toBe(true);
  expect(kp.view(c, true, t0 + 130_000)).toBe(c);
});

test("a copy is refreshed only now and then while up, and a different cluster (reset, shared link) never shows the old one's picture", () => {
  const a = new Cluster({ seed: 5, systemPods: true, nodes: EXAM_NODES });
  const kp = new KnownPicture();
  kp.view(a, true, 0);
  a.advance(5_000);
  kp.view(a, true, COPY_EVERY_MS - 1); // too soon for another copy
  expect(kp.view(a, false, COPY_EVERY_MS).now).toBe(a.now - 5_000);
  const b = new Cluster({ seed: 6, systemPods: true, nodes: EXAM_NODES });
  expect(kp.view(b, false, 99_999)).toBe(b); // nothing known of b: drawn live
});

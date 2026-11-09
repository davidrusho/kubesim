# Contributing to kubesim

Thanks for helping people learn Kubernetes. This guide covers the most common contributions: a Lesson, a Challenge, a practice exam task, an Explainer, a Concept Illustration, and an engine fix.

## Setup

```bash
bun install
bun run dev        # http://localhost:3000
```

Before you open a PR, run all of these. CI runs the same:

```bash
bun run typecheck
bun run lint
bun run test
bun run build      # the static export must succeed
bun run e2e        # optional locally (CI runs it): Playwright against out/
```

Please read [CONTEXT.md](CONTEXT.md) first: it defines the words we use (Learner, Lesson, Step, Check, Track, Challenge, Practice Exam, Sandbox, Explainer, Concept Illustration) and the ones we avoid.

## Add or edit a Lesson

Lessons live in [`lib/lessons/lessons.ts`](lib/lessons/lessons.ts). A Lesson is a starting cluster plus a list of Steps:

```ts
{
  slug: "my-lesson",            // URL: /learn/my-lesson
  title: "…", short: "…", summary: "…", minutes: 6, concepts: ["Pod"],  // short: 1–2 words for the home page
  setup: (c) => deployment(c, "web", "nginx:1.27", 3),  // optional starting cluster
  warmupMs: 10_000,             // let it settle before the Learner arrives
  steps: [
    {
      title: "Scale it",
      body: "Markdown-ish text. **bold**, `code`,\n\n```bash\nkubectl scale deployment web --replicas=5\n```",
      check: (x) => (dep(x.cluster, "web")?.spec?.replicas ?? 0) === 5,
      hint: "kubectl scale deployment NAME --replicas=N",
      solution: { commands: ["kubectl scale deployment web --replicas=5"] },
    },
  ],
}
```

- **Checks test cluster state**, not what was typed, wherever possible. Many commands can reach the same state, and all of them should pass. Use `x.history` (the command lines run) only when the point of a Step is to *look* at something, like `kubectl get pods`. History regexes must accept the spellings people really type: flags in any order (`kubectl logs -f web`), long and short forms (`-n team-a`, `--namespace=team-a`), and resource aliases (`deploy`, `deployments.apps`). Add the alternatives and the shortcuts that must not pass to `lib/lessons/lessons.checks.test.ts`.
- A Check is re-evaluated every frame against the live cluster, so keep it cheap.
- **Every Step needs a working `solution`.** It powers the "Show me" button. `lib/lessons/lessons.test.ts` replays every solution and fails if any Check doesn't pass. If the solution depends on generated names, make `commands` a function of the cluster.
- Body text: `bash` fences get a Run button per line (lines containing `<placeholder>` don't). `yaml` fences get "Open in editor". ` ```illustration <id>``` ` embeds a Concept Illustration.
- Write for someone who knows Docker but not Kubernetes. Short sentences, one idea per Step, and point at what to watch on the canvas.

Index pages (`/learn`, `/challenges`, `/exams`, `/progress`, `/explainers`) read a lightweight copy of titles, summaries, tracks and Step titles from `lib/lessons/meta.ts`, so they don't load the engine. After adding or renaming a Lesson, Challenge, exam task, Explainer or Step, run `bun lib/lessons/gen-meta.ts`; `lib/lessons/meta.test.ts` fails until you do. `TRACKS` lives in `meta.ts`.

Every Lesson has a `track` (see `TRACKS`); the curriculum map on `/learn` groups Lessons by it, and the curriculum order is the tracks in order, then Lessons in the order they appear in `LESSONS`. Don't use a concept before the Lesson that introduces it.

## Add a Challenge

Challenges live in [`lib/lessons/challenges.ts`](lib/lessons/challenges.ts). A Challenge is a Lesson with a `difficulty` and a `brief`, and its Steps are goals rather than instructions:

- `setup` builds the broken cluster. The `brief` describes the symptom the way a colleague would ("the shop page returns 503 since this morning"), never the cause.
- Each goal's `body` states the outcome ("customers can reach the shop through the `shop` Service"), and its Check tests exactly that. Goals can be met in any order.
- `hint` nudges towards where to look; `solution` is one way to fix it.
- `lessons.test.ts` asserts no goal passes right after setup, then replays every solution.

## Add a practice exam task

Practice exams live in [`lib/lessons/exams.ts`](lib/lessons/exams.ts). Tasks are independent Steps with `points` (a whole exam sums to 100) and usually a `namespace` created in `setup`. Write them like exam questions: exact names, images, ports and namespaces, and no commands. Checks run once, when the Learner submits, so they may be stricter than a Lesson's. The same solvability test applies.

## Add an Explainer

Explainers live in [`lib/explainers/explainers.ts`](lib/explainers/explainers.ts). Each is a `setup` for the cluster plus `beats`: captions that fire at simulated-time offsets, optionally running an action:

```ts
{ at: 3000, title: "A Pod disappears", text: "…", run: (sim) => sim.run((c) => A.deletePod(c, "web-abc12")) }
```

Use the actions in `lib/sim/actions.ts` so the History tab shows the real kubectl command. Leave the Learner time to read: about 3 to 6 simulated seconds per beat at speed 1. For slow processes like Node failure, set `speed`.

## Add a Concept Illustration

Illustrations are data, not drawings. Add a `Scene` to [`components/illustrations/scenes.ts`](components/illustrations/scenes.ts):

- `boxes`: rectangles in viewBox coordinates. `group: true` draws a dashed container behind the others, e.g. a Node. `tone` picks the colour: violet for control plane, blue for networking and node agents, green for Pods, amber and red for problems.
- `edges`: arrows between box ids, with an optional `label` and `bend`.
- `steps`: each lists the ids to highlight (`on`), the edges that carry an animated packet (`flow`), and boxes to cross out (`off`), plus a caption.

Register it in `SCENES`, then embed it in a Lesson body with ` ```illustration <id>``` `. It also appears on `/concepts` automatically. Packets are hidden under `prefers-reduced-motion`.

A scene can also show how things nest and where they sit. All of this is optional, and a scene that uses none of it renders as before:

- **Containment.** `region: "cluster" | "node" | "namespace"` draws a tinted region with a header strip; regions nested inside others are drawn darker. Set `parent` on a box to the id of the region it sits in; the tests check that it lies inside. `kind: "pod"` draws a Pod card with a status-coloured bar and a badge from `status` (`Running 1/1` green, `Pending` and `ContainerCreating` amber, failures red). Give a Pod `containers` and `openH` and list it under a step's `open` to show its containers. `kind: "chip"` is a small component, such as a kubelet.
- **Outside actors.** `outside: true` draws an actor (kubectl, a load balancer, a registry) that must lie outside the cluster region. An edge that enters the cluster names the region in `cross`, which draws an entry marker where the line meets its boundary; keep its `label` to a short verb.
- **Logical vs physical.** `kind: "owns"` on an edge draws a dashed ownership line (Deployment, ReplicaSet, Pods). `fromSide`/`toSide` pick where an edge leaves and enters a box, and `elbow: true` with a shared `bus` routes right-angled edges that several boxes can share.
- **Blocked traffic.** A step's `block` lists edges drawn red with a cross from then on, for traffic a NetworkPolicy refuses. `region: "pod"` draws a Pod as a region that holds its own chips (probes, `resolv.conf` lines).
- **Watches and reads.** `kind: "watch"` draws a dotted line from the component that initiates (a watcher, or something that polls) to what it watches or reads; use it the same way in every scene.
- **Areas.** `region: "area"` is a plain dashed grouping with no icon, for things that belong to no namespace or Node, such as Pods waiting for a Node. A moved box slides to its new place (not under reduced motion).
- **Legend.** `legend: true` draws a small key under the scene for the line styles on screen (traffic, watches, owns or refers to, blocked, crosses the cluster boundary).
- **Icons.** `icon: "pod"` names a file in `public/icons/k8s/` (official Kubernetes icons, see [NOTICE.md](NOTICE.md)). Add a file there before naming it.
- **Building up.** A step's `add` lists boxes and edges that appear from that step on (anything no step adds is always drawn), and its `status` sets a Pod's status from then on. The picture is cropped to the union of every step's content, so its height never changes between steps, and a region is drawn only as tall as what is in it at that step. A step's `move` puts a box somewhere else from then on (a Pod from the unscheduled area onto a Node; mark it `unbound: true` and the tests check it stays off every Node until then), and its `sub` changes a chip's subtitle (a version number).

Draw new scenes 848 wide, the width of the Concepts column, so the 12px text is 12px on screen. `components/illustrations/scenes.test.ts` checks every scene, step by step and against the rendered drawing: ids and references, nesting and that every box's parent is on screen, outside actors, entry markers, icon files, text that fits its box, boxes that overlap, edges that run through a box, edge labels that cover a box, a frame that is identical in every step and holds everything shown, a legend entry for every kind of line on screen, Pods that a step moves onto a Node being marked `unbound` and staying off every Node until then, and Pods that straddle a Node's edge.

## Fix or extend the engine

The engine ([`lib/engine`](lib/engine)) must behave like real Kubernetes. When you change behaviour:

1. Find the real behaviour and cite it: the Kubernetes source, docs, or output captured from a real cluster. Add it to [`docs/research/kubernetes-behaviour-reference.md`](docs/research/kubernetes-behaviour-reference.md) if it's new.
2. Add a test in `lib/engine/engine.test.ts` or `lib/kubectl/kubectl.test.ts` that pins the behaviour: timings, event messages, printed output.
3. Keep it deterministic. Use `cluster.rng`, never `Math.random`, and sim time (`cluster.now`), never wall-clock time.
4. Keep state as plain JSON in `ClusterState`, so snapshots (autosave, shared links) keep working. Old snapshots must still load: default any new `ClusterState` field in the `Cluster` constructor.
5. Controllers run every 100 ms of simulated time; keep them cheap. Write status with `cluster.updateStatus` so unchanged objects cost almost nothing.

A new kubectl command goes in [`lib/kubectl/kubectl.ts`](lib/kubectl/kubectl.ts); its `get` columns in [`printers.ts`](lib/kubectl/printers.ts), its `describe` in [`describe.ts`](lib/kubectl/describe.ts), and any `create` generator in [`generators.ts`](lib/kubectl/generators.ts). Match the real command's flags, output and error text. New API kinds are registered once, in [`lib/engine/kinds.ts`](lib/engine/kinds.ts). Commands that change the cluster must call `can(…)` so `--as` impersonation is checked against RBAC.

Commands inside containers (`kubectl exec`, exec probes, and the programs containers run) go through [`lib/engine/exec.ts`](lib/engine/exec.ts), a small BusyBox/coreutils subset over each container's file view ([`fs.ts`](lib/engine/fs.ts)). New images go in [`images.ts`](lib/engine/images.ts); prefer images the official Kubernetes docs use.

## Pull requests

- One change per PR. Include a screenshot for UI changes.
- Big or hard-to-reverse decisions get an ADR in `docs/adr/`.
- Be kind in review. Everyone here is learning something.

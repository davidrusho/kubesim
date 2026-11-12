# Kubernetes Simulator

A free, open-source website where people learn Kubernetes by working against a simulated cluster that runs entirely in their browser.

## Language

**Learner**:
A person using the site to learn Kubernetes.
_Avoid_: User, student, customer

**Simulated Cluster**:
An in-browser model of a Kubernetes cluster that reacts to commands as a real cluster would, with no real containers or servers behind it.
_Avoid_: Real cluster, backend cluster, playground cluster

**Lesson**:
A guided unit of learning that walks the Learner through tasks performed against a Simulated Cluster.
_Avoid_: Tutorial, course, module

**Sandbox**:
Free-play mode: an open Simulated Cluster with no Lesson guiding it.
_Avoid_: Playground, free mode

**Step**:
One task within a Lesson: an instruction to the Learner, completed when its Check passes.
_Avoid_: Exercise, task, challenge

**Check**:
A condition on the Simulated Cluster's state that decides whether a Step is complete.
_Avoid_: Validator, assertion, test

**Cluster View**:
The live visual diagram of the Simulated Cluster shown beside the terminal.
_Avoid_: Visualizer, graph, dashboard

**Chaos Action**:
A destructive action the Learner triggers from the Cluster View (killing a Pod or Node) to watch the cluster react.
_Avoid_: Fault, failure button

**Explainer**:
An interactive animated diagram of one concept: the Cluster View playing a scripted scenario whose parameters the Learner can tweak and replay, with no commands typed.
_Avoid_: Animation, demo, visualisation

**Concept Illustration**:
A step-through SVG diagram, written as data (boxes, arrows and captions), shown inside a Lesson and on the Concepts page. It shows something the Simulated Cluster doesn't model, such as control-plane internals.
_Avoid_: Figure, image, drawing

**Track**:
A group of Lessons on one topic (Foundations, Workloads, Configuration, Networking, Storage, Operations, Security). The Tracks in order make up the curriculum map.
_Avoid_: Module, course, chapter

**Challenge**:
A Simulated Cluster that starts broken or unfinished, plus one or more goals, with no step-by-step instructions. Each goal is a Step whose Check tests the fix. Nothing that names a command is shown until the Learner presses Hint: the first press reveals where to start (read-only commands), each further press the next hint for that goal, and the solution is the last resort. The hints and fixes used are remembered and shown when the goal is solved.
_Avoid_: Puzzle, quiz, lab

**Incident**:
The shop (a web tier, an API, Postgres and Redis, with simulated customers sending real traffic) running healthily until something breaks. The Learner is paged with the live error rate and a clock, and the Incident is resolved once the shop has served cleanly, with every workload healthy, for 15 seconds of cluster time. The page and brief name no command; the first press of Hint reveals where to start (read-only commands), each further press the next hint, and the fix is the last rung. How many hints were used, and whether the fix was shown, is kept with the result.
_Avoid_: Outage game, scenario (Scenarios are the Sandbox's guided demos)

**Daily Incident**:
One Incident a day, picked by the UTC date so it's the same for everyone, numbered from its first day. Results and the streak are kept in the browser.
_Avoid_: Daily challenge, puzzle of the day

**Building Block**:
An item in the Sandbox's + Add palette that deploys a real manifest (a database, an API, a load generator, the whole shop). It runs `kubectl apply -f <name>.yaml` and saves the file in the Editor.
_Avoid_: Template, component, blueprint (in prose; `blueprints.ts` is the code)

**Practice Exam**:
A timed list of independent tasks in the style of the CKAD or CKA, each worth points, graded from cluster state when the Learner submits or time runs out.
_Avoid_: Test, quiz, certification

**Shared Link**:
A URL that carries a compressed snapshot of a Sandbox cluster in its hash, so a Learner can hand a copy of their cluster to someone else. There is still no backend.
_Avoid_: Permalink, saved cluster

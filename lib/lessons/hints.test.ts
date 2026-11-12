import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HintLadder } from "@/components/learn/HintLadder";
import { ChallengeRow } from "@/components/learn/Index";
import { Prose } from "@/components/learn/Prose";
import { CHALLENGES as CHALLENGE_META } from "./meta";
import { INCIDENTS } from "@/lib/sim/incidents";
import { CHALLENGES } from "./challenges";
import { START_COMMANDS, ladder } from "./hints";

/** Text that names a command to run: a code fence, or a CLI the Learner would type. */
const COMMAND_SHAPED = /```|\b(kubectl|curl|wget|nslookup|dig|crictl|journalctl|systemctl|etcdctl|helm|kustomize|docker)\b/i;

describe("hint ladders", () => {
  test("every incident has a non-empty ladder", () => {
    for (const inc of INCIDENTS) {
      expect(inc.hints.length, inc.slug).toBeGreaterThan(0);
      for (const h of inc.hints) expect(h.trim(), inc.slug).not.toBe("");
      expect(ladder(inc.hints)[0].label).toBe("Where to start");
    }
  });

  test("every challenge goal has its own ladder of 3 or 4 hints, and 'where to start' comes first", () => {
    for (const ch of CHALLENGES) {
      for (const [i, g] of ch.steps.entries()) {
        const where = `${ch.slug} goal ${i + 1}`;
        // A single `hint` string, split into sentences, is not a ladder.
        expect("hint" in g, `${where} still has a single hint`).toBe(false);
        expect(Array.isArray(g.hints), `${where} has no hints array`).toBe(true);
        expect(g.hints.length, where).toBeGreaterThanOrEqual(3);
        expect(g.hints.length, where).toBeLessThanOrEqual(4);
        for (const h of g.hints) expect(h.trim(), where).not.toBe("");
        const rungs = ladder(g.hints, ch.start);
        expect(rungs.length).toBe(g.hints.length + 1);
        expect(rungs[0].text).toContain("```bash\n" + (ch.start ?? START_COMMANDS).join("\n"));
      }
    }
  });

  test("a goal's first hint says where to look and names no command", () => {
    for (const ch of CHALLENGES) for (const [i, g] of ch.steps.entries()) expect(COMMAND_SHAPED.test(g.hints[0]), `${ch.slug} goal ${i + 1}: ${g.hints[0]}`).toBe(false);
  });

  test("the second hint names a read-only command to run", () => {
    for (const ch of CHALLENGES) for (const [i, g] of ch.steps.entries()) expect(/`(kubectl|curl|wget) [^`]+`/.test(g.hints[1]), `${ch.slug} goal ${i + 1}: ${g.hints[1]}`).toBe(true);
  });

  test("hints are plain prose: no em or en dashes, no 'simply' or 'just'", () => {
    for (const ch of CHALLENGES) for (const [i, g] of ch.steps.entries()) for (const h of g.hints) expect(h, `${ch.slug} goal ${i + 1}`).not.toMatch(/[\u2013\u2014]|\b(simply|just)\b/i);
  });

  test("a read-only start command is read-only", () => {
    for (const ch of CHALLENGES) for (const c of ch.start ?? []) expect(c, ch.slug).not.toMatch(/\b(apply|create|delete|edit|patch|scale|set|run|replace|drain|cordon|taint|label)\b/);
  });
});

describe("nothing command-shaped is on screen before the first Hint", () => {
  test("the ladder renders nothing until a hint is asked for, then 'where to start' with Run buttons", () => {
    const rungs = ladder(["a hint"]);
    const none = renderToStaticMarkup(createElement(HintLadder, { rungs, shown: 0, onRun: () => {} }));
    expect(none).toBe("");
    const first = renderToStaticMarkup(createElement(HintLadder, { rungs, shown: 1, onRun: () => {} }));
    expect(first).toContain("Where to start");
    expect(first).toContain("kubectl get pods -o wide");
    expect(first).toContain(">Run<");
    expect(first).not.toContain("a hint");
    expect(renderToStaticMarkup(createElement(HintLadder, { rungs, shown: 2, onRun: () => {} }))).toContain("a hint");
  });

  test("no incident or challenge text shown up front names a command", () => {
    const shown: [string, string][] = [];
    for (const inc of INCIDENTS) shown.push([`incident ${inc.slug} page`, inc.page], [`incident ${inc.slug} brief`, inc.brief], [`incident ${inc.slug} title`, inc.title]);
    for (const ch of CHALLENGES) {
      shown.push([`challenge ${ch.slug} brief`, ch.brief], [`challenge ${ch.slug} summary`, ch.summary], [`challenge ${ch.slug} title`, ch.title]);
      for (const [i, g] of ch.steps.entries()) shown.push([`challenge ${ch.slug} goal ${i + 1} title`, g.title], [`challenge ${ch.slug} goal ${i + 1} body`, g.body]);
    }
    for (const [where, text] of shown) expect(COMMAND_SHAPED.test(text), `${where}: ${text.slice(0, 120)}`).toBe(false);
  });

  test("rendered, the briefs and goals have no Run button and no code block", () => {
    for (const ch of CHALLENGES) {
      const html = renderToStaticMarkup(createElement("div", null, createElement(Prose, { text: ch.brief, onRun: () => {} }), ...ch.steps.map((g, i) => createElement(Prose, { key: i, text: g.body, onRun: () => {} }))));
      expect(html, ch.slug).not.toContain(">Run<");
      expect(html, ch.slug).not.toContain("$</span>");
    }
    for (const inc of INCIDENTS) expect(renderToStaticMarkup(createElement(Prose, { text: inc.brief, onRun: () => {} })), inc.slug).not.toContain(">Run<");
  });
});

describe("a Challenge's cause is not given away before it is solved", () => {
  test("the index row hides the concepts of an unsolved Challenge and shows them once it is solved", () => {
    expect(CHALLENGE_META.length).toBeGreaterThan(0);
    for (const c of CHALLENGE_META) {
      const open = renderToStaticMarkup(createElement(ChallengeRow, { c, done: false, mounted: false }));
      // Positive control: the row itself renders, with its link and summary.
      expect(open, c.slug).toContain(`href="/challenges/${c.slug}"`);
      expect(open, c.slug).toContain("<h3");
      expect(open, c.slug).not.toContain(c.concepts.join(" · "));
      expect(open, c.slug).not.toContain("font-mono");
      const solved = renderToStaticMarkup(createElement(ChallengeRow, { c, done: true, mounted: false }));
      expect(solved, c.slug).toContain(c.concepts.join(" · "));
    }
  });

  /** Words that name each Challenge's cause. Its brief (what the Learner reads first) must not use them. */
  const CAUSE: Record<string, RegExp> = {
    "typo-image": /\b(bump|tag|typo|ImagePull|misspell)/i,
    "service-selector": /selector|label|endpoint/i,
    "missing-configmap": /unused|tidied|deleted|removed|missing/i,
    "postgres-password": /POSTGRES_PASSWORD|secretKeyRef|valueFrom|env(ironment)? var|plain ?text/i,
    "readiness-wrong-port": /wrong|\bport\b|\bpath\b|incorrect|health checks/i,
    "oversized-request": /oversiz|too (big|large|high)|sized|\brequests?\b/i,
    "wrong-storageclass": /StorageClass|fast-ssd|production|copied|PVC|claim/i,
    "forbidden-sa": /RoleBinding|\bRole\b|binding|set up for it/i,
    "egress-dns": /DNS|egress|NetworkPolicy|\b53\b|kube-dns|CoreDNS/i,
    "after-maintenance": /cordon|taint|maintenance|unschedulable|drain/i,
    "nodeselector-typo": /label|typo|nodeSelector|misspell|selector/i,
    "ingress-ignored": /IngressClass|\bclass\b|ingress-nginx|copied|controller/i,
    "allow-frontend": /default-deny|deny|NetworkPolicy/i,
    "daemonset-tainted-node": /taint|toleration|NoSchedule|set aside/i,
    "hpa-stuck": /\brequests?\b|metrics|missing|no cpu|limits?\b/i,
    "anti-affinity-third-replica": /anti-?affinity|requiredDuring|hard rule/i,
    "storefront-gateway": /IngressClass|port name|named port|targetPort|label/i,
    "run-as-nonroot": /runAsUser|\buid\b|CreateContainerConfigError|numeric/i,
    "readonly-tmp": /emptyDir|\/tmp|writable|permission denied/i,
    "node-reader": /ClusterRole|Role and a RoleBinding|created a Role/i,
    "hardening-rollout": /allow rule|non-root everywhere|tighter CI/i,
    "payments-onboarding": /onboarding script|ran yesterday|wrong namespace/i,
    "audit-cleanup": /replaced|moved the comments|unused|labels|not found/i,
    "secret-wrong-key": /typo|secretKeyRef|wrong key|misspell/i,
    "oom-resizer": /OOM|Killed|too low|raise/i,
    "failed-backfill": /immutable|recreate|backoffLimit/i,
    "cronjob-never-runs": /suspend|cron expression|typo/i,
    "cache-emptydir": /emptyDir|PersistentVolumeClaim|\bPVC\b/i,
    "cronjob-stuck-run": /concurrencyPolicy|activeDeadlineSeconds|Forbid|suspend/i,
    "configmap-subpath": /subPath|symlink|\bmount/i,
  };

  /** Extra words for the title and summary only: the brief may use them as constraints ("keep the readiness probe"), the index may not. */
  const CAUSE_LISTING: Record<string, RegExp> = {
    "typo-image": /small change/i,
    "egress-dns": /locked down too far|blocks more/i,
    "allow-frontend": /lockdown|policy/i,
    "run-as-nonroot": /non-?root/i,
    "readonly-tmp": /read-only|hardened/i,
    "node-reader": /where Nodes don't live/i,
    "after-maintenance": /half-finished/i,
    "wrong-storageclass": /provision/i,
    "hardening-rollout": /hardened|hardening/i,
    "readiness-wrong-port": /probe|health checks/i,
  };

  test("every Challenge has a cause-word list, and its title, summary and brief use none of them", () => {
    for (const ch of CHALLENGES) {
      expect(CAUSE[ch.slug], `${ch.slug} has no entry in CAUSE`).toBeDefined();
      expect(ch.brief, `${ch.slug} brief`).not.toMatch(CAUSE[ch.slug]);
      for (const [what, text] of [["title", ch.title], ["summary", ch.summary]]) {
        expect(text, `${ch.slug} ${what}`).not.toMatch(CAUSE[ch.slug]);
        if (CAUSE_LISTING[ch.slug]) expect(text, `${ch.slug} ${what}`).not.toMatch(CAUSE_LISTING[ch.slug]);
      }
    }
    for (const slug of Object.keys(CAUSE)) expect(CHALLENGES.some((c) => c.slug === slug), `${slug} is not a Challenge`).toBe(true);
  });

  test("the cause words can match: the old typo-image and wrong-storageclass briefs would have failed", () => {
    expect("Someone \"just bumped the nginx tag\" on the `web` Deployment").toMatch(CAUSE["typo-image"]);
    expect("A Pod waiting on a claim that can never be provisioned.").toMatch(CAUSE_LISTING["wrong-storageclass"]);
    expect("RBAC that grants Node access in a namespace, where Nodes don't live.").toMatch(CAUSE_LISTING["node-reader"]);
    expect("Its manifests were copied from the production cluster, which has a StorageClass called `fast-ssd`.").toMatch(CAUSE["wrong-storageclass"]);
  });
});

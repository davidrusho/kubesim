"use client";

import { createContext, useContext, useRef, useState } from "react";
import {
  isIsolated,
  selectingPolicies,
  podRequests,
  nodeAllocatable,
  type AnyObject,
  type Cluster,
  type ConfigMap,
  type Container,
  type CronJob,
  type DaemonSet,
  type Deployment,
  type Endpoints,
  type HorizontalPodAutoscaler,
  type Ingress,
  type Job,
  type KubeEvent,
  type NetworkPolicy,
  type NetworkPolicyPeer,
  type Node,
  type PersistentVolume,
  type PersistentVolumeClaim,
  type Pod,
  type Probe,
  type ReplicaSet,
  type Role,
  type RoleBinding,
  type Service,
  type StatefulSet,
  type StorageClass,
} from "@/lib/engine";
import * as A from "@/lib/sim/actions";
import { diagnose, type Finding, type Fix } from "@/lib/sim/diagnose";
import { RAW_KIND, canDelete, deleteCommand, deleteNote } from "@/lib/sim/objects";
import type { SimStore } from "@/lib/sim/useSimulation";
import { age, podCategory, podReady, podStatus, restarts } from "@/lib/sim/status";
import { manifestFor } from "@/lib/kubectl/kubectl";
import { tableRows } from "@/lib/kubectl/printers";
import { Btn as UiBtn, CAT_COLOR, Dot, Heading, clock } from "../ui";
import type { Selection, SelKind } from "./ClusterView";
import type { LogEntry } from "@/lib/sim/useSimulation";

type Sim = SimStore;

/** Dot colour for objects with no health of their own (ConfigMaps, policies, bindings, autoscalers): ink-soft, not a status colour. */
const NEUTRAL = "#5a6680";

/** A label/value row. `hint` adds a short plain-English gloss under the label. */
function KV({ k, v, hint }: { k: string; v: React.ReactNode; hint?: string }) {
  return (
    <div className="flex gap-3 py-1 text-[12.5px]">
      <span className="w-24 shrink-0 text-ink-soft">
        {k}
        {hint && <span className="block text-[10.5px] leading-snug text-ink-soft/80">{hint}</span>}
      </span>
      <span className="min-w-0 break-all font-mono text-[12px] text-ink">{v}</span>
    </div>
  );
}

function EventList({ events, now }: { events: KubeEvent[]; now: number }) {
  if (!events.length) return <p className="text-[12.5px] text-ink-soft">No events.</p>;
  return (
    <ol className="relative flex flex-col gap-2.5 border-l border-ink/15 pl-3">
      {events.slice(-12).map((e) => (
        <li key={e.metadata.uid} className="relative text-[12px] leading-snug">
          <span className="absolute -left-[16.5px] top-1.5 h-2 w-2 rounded-full border-2 border-paper" style={{ background: e.type === "Warning" ? CAT_COLOR.starting : "rgba(17,24,39,.3)" }} />
          <div className="flex items-baseline gap-2">
            <span className={`font-medium ${e.type === "Warning" ? "text-amber-700" : "text-ink"}`}>{e.reason}</span>
            {e.count > 1 && <span className="text-[11px] text-ink-soft">×{e.count}</span>}
            <span className="ml-auto font-mono text-[10.5px] text-ink-soft">{age(now - e.lastTimestamp)}</span>
          </div>
          <div className="text-ink-soft">{e.message}</div>
        </li>
      ))}
    </ol>
  );
}

/** What the header needs from the Inspector around it: the selection (for Delete) and what's wrong with it. */
/** Practice screens (Incidents, Challenges) hide the explanations and diagnoses that say what to run or what is wrong: those come from Hint. */
const Quiet = createContext(false);

/** The shared button, except that in practice mode a tooltip that names a command is dropped. */
function Btn(props: React.ComponentProps<typeof UiBtn>) {
  const quiet = useContext(Quiet);
  return <UiBtn {...props} title={quiet && props.title && /\b(kubectl|curl)\b/i.test(props.title) ? undefined : props.title} />;
}
const Selected = createContext<{ sim: Sim; c: Cluster; sel: NonNullable<Selection>; onSelect: (s: Selection) => void; findings?: Finding[] } | null>(null);

function InspectHeader({ kind, name, color, status, actions }: { kind: string; name: string; color: string; status: string; actions?: React.ReactNode }) {
  const ctx = useContext(Selected);
  return (
    <>
      <div className="border-b border-ink/15 p-4">
        <div className="text-[12px] font-medium text-ink-soft">{kind}</div>
        <div className="mt-1 break-all font-mono text-[14px] font-medium text-ink">{name}</div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink">
            <Dot color={color} />
            {status}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {actions}
            {ctx && <DeleteButton {...ctx} />}
          </div>
        </div>
      </div>
      {ctx?.findings && <WhatsWrong {...ctx} findings={ctx.findings} />}
    </>
  );
}

/** Deletes whatever is selected, through kubectl. Anything but a Pod asks twice: the second click says what will happen. */
function DeleteButton({ sim, c, sel, onSelect }: { sim: Sim; c: Cluster; sel: NonNullable<Selection>; onSelect: (s: Selection) => void }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  if (!canDelete(c, sel.kind, sel.ns, sel.name)) return null;
  const go = () => {
    window.clearTimeout(timer.current);
    if (sel.kind !== "pod" && !armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    sim.exec(deleteCommand(sel.kind, sel.ns, sel.name));
    // A deleted Pod lingers while it shuts down, which is worth watching; anything else is gone.
    if (sel.kind !== "pod") onSelect(null);
  };
  return (
    <span className="relative">
      <Btn tone="danger" onClick={go} title={armed ? deleteNote(c, sel.kind, sel.ns, sel.name) : deleteCommand(sel.kind, sel.ns, sel.name)} className={armed ? "!border-red-700 !bg-red-50" : ""}>
        {armed ? "Really delete?" : "Delete"}
      </Btn>
      {armed && (
        <span role="status" className="absolute right-0 top-full z-10 mt-1.5 w-64 rounded-lg border border-red-300 bg-paper p-2.5 text-[12px] leading-snug text-ink shadow-lg">
          <code className="block font-mono text-[11px] text-red-700">{deleteCommand(sel.kind, sel.ns, sel.name)}</code>
          <span className="mt-1 block">{deleteNote(c, sel.kind, sel.ns, sel.name)}</span>
        </span>
      )}
    </span>
  );
}

const LEVEL = {
  bad: { bar: "border-red-700", tint: "bg-red-50", title: "text-red-900", dot: CAT_COLOR.bad },
  warn: { bar: "border-amber-700", tint: "bg-amber-50", title: "text-amber-900", dot: CAT_COLOR.starting },
  info: { bar: "border-ink/25", tint: "bg-ink/[0.03]", title: "text-ink", dot: NEUTRAL },
} as const;

/** What's wrong with the selection, in plain English, with fixes that run the kubectl they show. */
function WhatsWrong({ sim, onSelect, findings }: { sim: Sim; onSelect: (s: Selection) => void; findings: Finding[] }) {
  const run = (f: Fix) => ("cmd" in f ? sim.exec(f.cmd) : sim.run(f.run));
  const problems = findings.filter((f) => f.level !== "info").length;
  return (
    <div className="border-b border-ink/15 p-4" aria-label="What's wrong">
      <Heading>{problems ? "What's wrong" : findings.length ? "Worth knowing" : "Health"}</Heading>
      {!findings.length && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-ink">
          <Dot color={CAT_COLOR.ok} />
          Nothing wrong.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {findings.map((f) => {
          const t = LEVEL[f.level];
          return (
            <div key={f.title} className={`border-l-[3px] ${t.bar} ${t.tint} rounded-r-lg px-3 py-2.5`}>
              <div className={`flex items-center gap-1.5 text-[13px] font-medium ${t.title}`}>
                <Dot color={t.dot} />
                {f.title}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink">{f.detail}</p>
              {!!f.fixes?.length && (
                <div className="mt-2.5 flex flex-col gap-2">
                  {f.fixes.map((x) => (
                    <div key={x.label} className="flex min-w-0 flex-col items-start gap-1">
                      <Btn tone="primary" onClick={() => run(x)} title={"cmd" in x ? `Runs: ${x.cmd}` : undefined} className="h-7 shrink-0 px-2.5 text-[12px]">
                        {x.label}
                      </Btn>
                      {"cmd" in x && <code className="break-all font-mono text-[11px] leading-snug text-ink-soft">$ {x.cmd}</code>}
                    </div>
                  ))}
                </div>
              )}
              {f.see && (
                <button onClick={() => onSelect(f.see!)} className="mt-2 text-[12px] font-medium text-signal underline-offset-2 hover:underline">
                  Look at {f.see.kind === "pod" ? "Pod" : f.see.kind === "node" ? "Node" : f.see.kind === "hpa" ? "HPA" : f.see.kind} {f.see.name} →
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="border-t border-ink/15 p-4">
      <Heading right={right}>{title}</Heading>
      {children}
    </div>
  );
}

function Explain({ children }: { children: React.ReactNode }) {
  if (useContext(Quiet)) return null;
  return <p className="mb-3 border border-ink/10 bg-ink/[0.03] p-2.5 text-[12px] leading-relaxed text-ink">{children}</p>;
}

function Yaml({ obj }: { obj: AnyObject }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-ink/15 p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-[12px] font-medium text-ink-soft hover:text-ink" aria-expanded={open}>
        YAML <span className="font-mono">{open ? "−" : "+"}</span>
      </button>
      {open && <pre className="mt-2 max-h-80 overflow-auto border border-ink/15 bg-ink/[0.03] p-2.5 font-mono text-[11px] leading-relaxed text-ink">{manifestFor(obj)}</pre>}
    </div>
  );
}

function PodLinks({ pods, onSelect, note }: { pods: Pod[]; onSelect: (s: Selection) => void; note?: (p: Pod) => string }) {
  if (!pods.length) return <p className="text-[12.5px] text-ink-soft">None.</p>;
  return (
    <>
      {pods.map((p) => (
        <button key={p.metadata.uid} onClick={() => onSelect({ kind: "pod", ns: p.metadata.namespace, name: p.metadata.name })} className="flex w-full items-center gap-2 px-1.5 py-1 text-left hover:bg-ink/[0.04]">
          <Dot color={CAT_COLOR[podCategory(p)]} />
          <span className="truncate font-mono text-[11.5px] text-ink">{p.metadata.name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-ink-soft">{note ? note(p) : podStatus(p)}</span>
        </button>
      ))}
    </>
  );
}

const Link = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
  <button className="text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink" onClick={onClick}>
    {children}
  </button>
);

const probeText = (p: Probe) =>
  `${p.httpGet ? `GET :${p.httpGet.port}${p.httpGet.path ?? "/"}` : p.tcpSocket ? `TCP :${p.tcpSocket.port}` : p.exec ? `exec ${(p.exec.command ?? []).join(" ")}` : "grpc"} every ${p.periodSeconds ?? 10}s${p.initialDelaySeconds ? `, after ${p.initialDelaySeconds}s` : ""}, ${p.failureThreshold ?? 3} failures`;

const ownedPods = (c: Cluster, o: AnyObject) => c.list<Pod>("Pod", o.metadata.namespace).filter((p) => p.metadata.ownerReferences?.some((r) => r.uid === o.metadata.uid));
const usedBy = (c: Cluster, ns: string | undefined, test: (p: Pod) => boolean) => c.list<Pod>("Pod", ns).filter(test);

export function Inspector({ sim, c, sel, onSelect, quiet = false }: { sim: Sim; c: Cluster; sel: Selection; onSelect: (s: Selection) => void; /** Practice mode: no "What's wrong" panel, no explanations. */ quiet?: boolean }) {
  if (!sel) {
    return (
      <div className="flex flex-col items-center p-10 text-center">
        <p className="text-[13px] font-medium text-ink">Nothing selected</p>
        <p className="mt-1 text-[12.5px] text-ink-soft">Click anything on the canvas to inspect it: a Pod, Node, Service, workload, volume or policy.</p>
      </div>
    );
  }
  const kind = RAW_KIND[sel.kind];
  const obj = c.raw(kind, sel.kind === "node" ? undefined : (sel.ns ?? "default"), sel.name);
  if (!obj) return <p className="p-6 text-[13px] text-ink-soft">{sel.name} no longer exists.</p>;
  const props = { sim, c, onSelect };
  const findings = !quiet && DIAGNOSED.has(sel.kind) ? diagnose(c, sel.kind, sel.ns, sel.name) : undefined;
  const body = (() => {
    switch (sel.kind) {
      case "pod":
        return <PodInspector {...props} p={obj as unknown as Pod} />;
      case "node":
        return <NodeInspector {...props} n={obj as unknown as Node} />;
      case "service":
        return <ServiceInspector {...props} s={obj as unknown as Service} />;
      case "deployment":
        return <DeploymentInspector {...props} d={obj as unknown as Deployment} />;
      case "replicaset":
        return <ReplicaSetInspector {...props} r={obj as unknown as ReplicaSet} />;
      case "statefulset":
        return <StatefulSetInspector {...props} s={obj as unknown as StatefulSet} />;
      case "daemonset":
        return <DaemonSetInspector {...props} d={obj as unknown as DaemonSet} />;
      case "job":
        return <JobInspector {...props} j={obj as unknown as Job} />;
      case "cronjob":
        return <CronJobInspector {...props} cj={obj as unknown as CronJob} />;
      case "ingress":
        return <IngressInspector {...props} ing={obj as unknown as Ingress} />;
      case "configmap":
      case "secret":
        return <ConfigInspector {...props} o={obj as unknown as ConfigLike} secret={sel.kind === "secret"} />;
      case "pvc":
        return <PvcInspector {...props} pvc={obj as unknown as PersistentVolumeClaim} />;
      case "networkpolicy":
        return <NetPolInspector {...props} np={obj as unknown as NetworkPolicy} />;
      case "hpa":
        return <HpaInspector {...props} h={obj as unknown as HorizontalPodAutoscaler} />;
      case "rolebinding":
        return <BindingInspector {...props} b={obj as unknown as RoleBinding} />;
    }
  })();
  return (
    // Keyed by the selection so per-object state (decoded Secret values, chosen container) never carries over.
    <div key={`${sel.kind}/${sel.ns ?? ""}/${sel.name}`}>
      <Quiet.Provider value={quiet}>
        <Selected.Provider value={{ sim, c, sel, onSelect, findings }}>{body}</Selected.Provider>
      </Quiet.Provider>
      <Section title="Events">
        <EventList events={c.eventsFor(obj)} now={c.now} />
      </Section>
      <Yaml obj={obj} />
    </div>
  );
}

/** Kinds "What's wrong" knows how to read; the rest (config, policies, bindings) get no health section. */
const DIAGNOSED = new Set<SelKind>(["pod", "node", "service", "deployment", "replicaset", "statefulset", "daemonset", "job", "cronjob", "ingress", "pvc", "hpa"]);

interface P {
  sim: Sim;
  c: Cluster;
  onSelect: (s: Selection) => void;
}

function PodInspector({ c, onSelect, p }: P & { p: Pod }) {
  const containers = p.spec?.containers ?? [];
  const [cname, setCname] = useState(containers[0]?.name ?? "");
  const ct: Container = containers.find((x) => x.name === cname) ?? containers[0] ?? { name: "", image: "" };
  const logs = c.logsFor(p, ct.name) ?? [];
  const cs = p.status?.containerStatuses?.find((x) => x.name === ct.name);
  const prev = (cs?.restartCount ?? 0) > 0 ? c.logsFor(p, ct.name, true) : undefined;
  const owner = p.metadata.ownerReferences?.find((o) => o.controller);
  const ownerKind = owner?.kind === "ReplicaSet" ? "replicaset" : owner?.kind === "StatefulSet" ? "statefulset" : owner?.kind === "DaemonSet" ? "daemonset" : owner?.kind === "Job" ? "job" : undefined;
  const m = c.state.metrics.pods[p.metadata.uid];
  const ns = p.metadata.namespace;
  const policies = [...selectingPolicies(c, p, "Ingress"), ...selectingPolicies(c, p, "Egress")];
  const req = podRequests(p.spec);
  return (
    <>
      <InspectHeader kind="Pod" name={p.metadata.name} color={CAT_COLOR[podCategory(p)]} status={podStatus(p)} />
      <div className="p-4">
        <KV k="Namespace" v={ns} />
        <KV k="Ready" v={podReady(p)} />
        <KV k="Restarts" v={restarts(p)} />
        <KV k="Node" v={p.spec?.nodeName ? <Link onClick={() => onSelect({ kind: "node", name: p.spec!.nodeName! })}>{p.spec.nodeName}</Link> : "—"} />
        <KV k="Pod IP" v={p.status?.podIP ?? "—"} />
        {p.spec?.hostname && p.spec.subdomain && <KV k="DNS" v={`${p.spec.hostname}.${p.spec.subdomain}.${ns}.svc`} />}
        <KV k="Controlled by" v={owner ? ownerKind ? <Link onClick={() => onSelect({ kind: ownerKind as SelKind, ns, name: owner.name })}>{`${owner.kind}/${owner.name}`}</Link> : `${owner.kind}/${owner.name}` : "—"} />
        <KV k="QoS" hint="how protected it is when the Node runs short" v={p.status?.qosClass ?? "BestEffort"} />
        {m && <KV k="Using" v={`CPU ${m.cpu}m${req.cpu ? ` of ${req.cpu}m requested` : ""} · memory ${Math.round(m.memory / 2 ** 20)}Mi`} />}
        {p.spec?.serviceAccountName && p.spec.serviceAccountName !== "default" && <KV k="ServiceAccount" v={p.spec.serviceAccountName} />}
        <KV k="Age" v={age(c.now - p.metadata.creationTimestamp)} />
        {cs?.state.waiting?.message && <p className="mt-2 border border-red-600/40 bg-red-50 p-2 font-mono text-[11px] leading-snug text-red-900">{cs.state.waiting.message}</p>}
        {cs?.lastState.terminated?.reason === "OOMKilled" && <p className="mt-2 border border-red-600/40 bg-red-50 p-2 text-[12px] leading-snug text-red-900">The last run went over its memory limit and was <b>OOMKilled</b> (exit code 137).</p>}
        {policies.length > 0 && (
          <p className="mt-2 border border-ink/10 bg-ink/[0.03] p-2 text-[12px] leading-snug text-ink">
            Isolated by {policies.length === 1 ? "NetworkPolicy" : "NetworkPolicies"}{" "}
            {[...new Set(policies.map((x) => x.metadata.name))].map((n, i) => (
              <span key={n}>
                {i ? ", " : ""}
                <Link onClick={() => onSelect({ kind: "networkpolicy", ns, name: n })}>{n}</Link>
              </span>
            ))}
            : only traffic a policy allows gets through.
          </p>
        )}
      </div>
      <Section
        title={`Container${containers.length > 1 ? "s" : ""}`}
        right={
          containers.length > 1 ? (
            <div className="flex gap-1">
              {containers.map((x) => (
                <button key={x.name} onClick={() => setCname(x.name)} className={`border px-1.5 font-mono text-[10.5px] ${x.name === ct.name ? "border-signal bg-signal text-white" : "border-ink/30 bg-paper text-ink-soft hover:border-ink/40 hover:text-ink"}`}>
                  {x.name}
                </button>
              ))}
            </div>
          ) : undefined
        }
      >
        <KV k="Image" v={ct.image} />
        <KV k="State" v={cs ? (cs.state.running ? `running since ${clock(cs.state.running.startedAt)}` : cs.state.waiting ? `waiting: ${cs.state.waiting.reason}` : `terminated: ${cs.state.terminated?.reason} (exit ${cs.state.terminated?.exitCode})`) : "—"} />
        {ct.readinessProbe && <KV k="Readiness" v={probeText(ct.readinessProbe)} />}
        {ct.livenessProbe && <KV k="Liveness" v={probeText(ct.livenessProbe)} />}
        {ct.startupProbe && <KV k="Startup" v={probeText(ct.startupProbe)} />}
        {(ct.resources?.requests || ct.resources?.limits) && (
          <KV k="Resources" v={`${Object.entries(ct.resources?.requests ?? {}).map(([a, b]) => `${a} ${b}`).join(", ") || "no requests"}${ct.resources?.limits ? ` · limit ${Object.entries(ct.resources.limits).map(([a, b]) => `${a} ${b}`).join(", ")}` : ""}`} />
        )}
        {(ct.env?.length || ct.envFrom?.length) && (
          <KV
            k="Env"
            v={
              <span className="whitespace-pre-line">
                {[
                  ...(ct.envFrom ?? []).map((e) => `all keys of ${e.configMapRef ? `ConfigMap ${e.configMapRef.name}` : `Secret ${e.secretRef?.name}`}`),
                  ...(ct.env ?? []).map((e) => `${e.name}=${e.value ?? (e.valueFrom?.configMapKeyRef ? `(ConfigMap ${e.valueFrom.configMapKeyRef.name}/${e.valueFrom.configMapKeyRef.key})` : e.valueFrom?.secretKeyRef ? `(Secret ${e.valueFrom.secretKeyRef.name}/${e.valueFrom.secretKeyRef.key})` : e.valueFrom?.fieldRef ? `(${e.valueFrom.fieldRef.fieldPath})` : "")}`),
                ].join("\n")}
              </span>
            }
          />
        )}
        {(ct.volumeMounts ?? []).filter((m) => !m.name.startsWith("kube-api-access-")).length > 0 && (
          <KV
            k="Mounts"
            v={
              <span className="whitespace-pre-line">
                {(ct.volumeMounts ?? [])
                  .filter((mt) => !mt.name.startsWith("kube-api-access-"))
                  .map((mt) => {
                    const v = p.spec?.volumes?.find((x) => x.name === mt.name);
                    const src = v?.configMap ? `ConfigMap ${v.configMap.name}` : v?.secret ? `Secret ${v.secret.secretName}` : v?.persistentVolumeClaim ? `PVC ${v.persistentVolumeClaim.claimName}` : v?.emptyDir ? "emptyDir" : v?.hostPath ? `hostPath ${v.hostPath.path}` : mt.name;
                    return `${mt.mountPath} ← ${src}${mt.readOnly ? " (ro)" : ""}`;
                  })
                  .join("\n")}
              </span>
            }
          />
        )}
      </Section>
      <Section title={`Logs · ${ct.name}`}>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap border border-ink/15 bg-ink/[0.03] p-2.5 font-mono text-[11px] leading-relaxed text-ink">
          {prev?.length ? `── previous run ──\n${prev.slice(-40).map((l) => l.text).join("\n")}\n── current ──\n` : ""}
          {logs.slice(-80).map((l) => l.text).join("\n") || "(no output yet)"}
        </pre>
      </Section>
    </>
  );
}

function NodeInspector({ sim, c, onSelect, n }: P & { n: Node }) {
  const pods = c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === n.metadata.name);
  const nm = n.metadata.name;
  const up = c.state.nodes[nm]?.up;
  const ready = c.nodeReady(n);
  const alloc = nodeAllocatable(n);
  const live = pods.filter((p) => p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
  const req = live.reduce((a, p) => { const r = podRequests(p.spec); return { cpu: a.cpu + r.cpu, memory: a.memory + r.memory }; }, { cpu: 0, memory: 0 });
  const use = c.state.metrics.nodes[nm];
  return (
    <>
      <InspectHeader
        kind="Node"
        name={nm}
        color={ready ? (up ? CAT_COLOR.ok : CAT_COLOR.bad) : CAT_COLOR.starting}
        status={ready ? (up ? (n.spec?.unschedulable ? "Ready, cordoned" : "Ready") : "No heartbeat") : "NotReady"}
        actions={
          <>
            {up ? <Btn tone="danger" onClick={() => sim.run((cl) => A.chaosKill(cl, nm))} title="Chaos: switch this Node off to watch the cluster react. Bring it back any time.">Simulate failure</Btn> : <Btn tone="primary" onClick={() => sim.run((cl) => A.chaosRecover(cl, nm))} title="Switch this Node back on">Recover</Btn>}
            {n.spec?.unschedulable ? <Btn onClick={() => sim.run((cl) => A.cordon(cl, nm, false))} title="kubectl uncordon: let new Pods be scheduled here again">Uncordon</Btn> : <Btn onClick={() => sim.run((cl) => A.drain(cl, nm))} title="kubectl drain: stop new Pods landing here and move the current ones to other Nodes">Drain</Btn>}
          </>
        }
      />
      <div className="p-4">
        <KV k="Internal IP" v={n.status?.addresses[0].address} />
        <KV k="Pod CIDR" hint="the Node's range of Pod IPs" v={n.spec?.podCIDR} />
        <KV k="Kubelet" hint="the agent that runs Pods here" v={up ? "reporting status" : "stopped"} />
        <KV k="Requested" v={`CPU ${req.cpu}m of ${alloc.cpu}m (${Math.round((req.cpu / alloc.cpu) * 100)}%) · memory ${Math.round(req.memory / 2 ** 20)}Mi of ${Math.round(alloc.memory / 2 ** 20)}Mi`} />
        {use && <KV k="Using" v={`CPU ${use.cpu}m · memory ${Math.round(use.memory / 2 ** 20)}Mi`} />}
        <KV k="Labels" v={<span className="whitespace-pre-line">{Object.entries(n.metadata.labels ?? {}).filter(([k]) => !k.startsWith("beta.")).map(([k, v]) => `${k}=${v}`).join("\n")}</span>} />
        <KV k="Taints" hint="rules that keep Pods away" v={<span className="whitespace-pre-line">{(n.spec?.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`).join("\n") || "—"}</span>} />
      </div>
      <Section title="Conditions">
        {n.status?.conditions.map((cd) => (
          <div key={cd.type} className="flex items-center justify-between py-1 text-[12.5px]">
            <span className="text-ink-soft">{cd.type}</span>
            <span className={`font-mono text-[11.5px] ${cd.type === "Ready" ? (cd.status === "True" ? "text-green-700" : "text-amber-700") : "text-ink-soft"}`}>{cd.status}</span>
          </div>
        ))}
      </Section>
      <Section title={`Pods · ${pods.length}`}>
        <PodLinks pods={pods} onSelect={onSelect} />
      </Section>
    </>
  );
}

function ServiceInspector({ sim, c, s }: P & { s: Service }) {
  const ep = c.raw("Endpoints", s.metadata.namespace, s.metadata.name) as unknown as Endpoints | undefined;
  const ready = (ep?.subsets ?? []).flatMap((x) => (x.addresses ?? []).map((a) => `${a.ip}:${x.ports?.[0]?.port}`));
  const notReady = (ep?.subsets ?? []).flatMap((x) => (x.notReadyAddresses ?? []).map((a) => a.ip));
  const headless = s.spec?.clusterIP === "None";
  const lb = s.status?.loadBalancer?.ingress?.[0]?.ip;
  return (
    <>
      <InspectHeader
        kind="Service"
        name={s.metadata.name}
        color={ready.length ? CAT_COLOR.ok : CAT_COLOR.bad}
        status={`${headless ? "headless" : s.spec?.type} · ${ready.length} endpoints`}
        actions={
          <>
            <Btn onClick={() => sim.curl(`http://${s.metadata.name}${s.metadata.namespace !== "default" ? "." + s.metadata.namespace : ""}`, 10)} title="curl the Service 10 times and watch which Pods answer">Send 10 requests</Btn>
          </>
        }
      />
      <div className="p-4">
        {headless && <Explain>A headless Service has no cluster IP. DNS answers with the Pods&apos; own IPs, and a StatefulSet&apos;s Pods each get a name like <b>web-0.{s.metadata.name}</b>.</Explain>}
        <KV k="Cluster IP" v={s.spec?.clusterIP} />
        {s.spec?.type === "LoadBalancer" && <KV k="External IP" v={lb ?? "<pending>"} />}
        <KV k="Ports" v={(s.spec?.ports ?? []).map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol} → ${p.targetPort}`).join(", ")} />
        <KV k="Selector" v={Object.entries(s.spec?.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(",")} />
        <KV k="DNS" v={`${s.metadata.name}.${s.metadata.namespace}.svc.cluster.local`} />
        <KV k="Endpoints" v={ready.join(", ") || <span className="text-red-700">none</span>} />
        {notReady.length > 0 && <KV k="Not ready" v={<span className="text-amber-700">{notReady.join(", ")}</span>} />}
      </div>
    </>
  );
}

function DeploymentInspector({ sim, c, onSelect, d }: P & { d: Deployment }) {
  const quiet = useContext(Quiet);
  const ns = d.metadata.namespace;
  const want = d.spec?.replicas ?? 1;
  const st = d.status ?? {};
  const rss = c.list<ReplicaSet>("ReplicaSet", ns).filter((r) => r.metadata.ownerReferences?.some((o) => o.uid === d.metadata.uid));
  const rev = (r: ReplicaSet) => Number(r.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
  const ru = d.spec?.strategy?.rollingUpdate;
  const hpa = c.list<HorizontalPodAutoscaler>("HorizontalPodAutoscaler", ns).find((h) => h.spec?.scaleTargetRef.kind === "Deployment" && h.spec.scaleTargetRef.name === d.metadata.name);
  return (
    <>
      <InspectHeader kind="Deployment" name={d.metadata.name} color={(st.availableReplicas ?? 0) === want ? CAT_COLOR.ok : CAT_COLOR.starting} status={`${st.readyReplicas ?? 0}/${want} ready`} actions={<><Btn onClick={() => sim.run((cl) => A.scale(cl, d.metadata.name, want + 1))}>Scale +1</Btn><Btn onClick={() => sim.run((cl) => A.scale(cl, d.metadata.name, Math.max(0, want - 1)))}>Scale −1</Btn><Btn onClick={() => sim.run((cl) => A.rolloutUndo(cl, d.metadata.name, ns))} title="kubectl rollout undo: go back to the previous Pod template">Undo rollout</Btn></>} />
      <div className="p-4">
        <Explain>A Deployment keeps <b>{want}</b> copies of a Pod template running. When the template changes, it creates a new ReplicaSet and shifts Pods over one step at a time.</Explain>
        <KV k="Image" v={d.spec?.template?.spec?.containers?.[0]?.image ?? "—"} />
        <KV k="Selector" v={Object.entries(d.spec!.selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",")} />
        <KV k="Strategy" v={`${d.spec?.strategy?.type}${ru ? ` (surge ${ru.maxSurge}, unavailable ${ru.maxUnavailable})` : ""}`} />
        <KV k="Updated" v={`${st.updatedReplicas ?? 0} of ${want}`} />
        <KV k="Available" v={`${st.availableReplicas ?? 0} of ${want}`} />
        <KV k="Revision" v={d.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? "—"} />
        {d.spec?.paused && <KV k="Paused" v={quiet ? "yes" : "yes: template changes wait for kubectl rollout resume"} />}
        {hpa && <KV k="Autoscaler" v={<Link onClick={() => onSelect({ kind: "hpa", ns, name: hpa.metadata.name })}>{`${hpa.metadata.name} (${hpa.spec?.minReplicas ?? 1}–${hpa.spec?.maxReplicas})`}</Link>} />}
      </div>
      <Section title="ReplicaSets (revision history)">
        {rss.sort((a, b) => rev(b) - rev(a)).map((r) => (
          <button key={r.metadata.uid} onClick={() => onSelect({ kind: "replicaset", ns, name: r.metadata.name })} className="flex w-full items-center gap-2 px-1.5 py-1.5 text-left hover:bg-ink/[0.04]">
            <span className="w-11 shrink-0 font-mono text-[10.5px] text-ink-soft">rev {rev(r)}</span>
            <span className="truncate font-mono text-[11.5px] text-ink">{r.metadata.name}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-soft">{r.status?.readyReplicas ?? 0}/{r.spec?.replicas}</span>
          </button>
        ))}
      </Section>
    </>
  );
}

function ReplicaSetInspector({ c, onSelect, r }: P & { r: ReplicaSet }) {
  const ns = r.metadata.namespace;
  const owner = r.metadata.ownerReferences?.find((o) => o.controller);
  return (
    <>
      <InspectHeader kind="ReplicaSet" name={r.metadata.name} color={(r.status?.readyReplicas ?? 0) === (r.spec?.replicas ?? 0) ? CAT_COLOR.ok : CAT_COLOR.starting} status={`${r.status?.readyReplicas ?? 0}/${r.spec?.replicas} ready`} />
      <div className="p-4">
        <Explain>A ReplicaSet counts Pods matching its selector and creates or deletes Pods until the count equals <b>{r.spec?.replicas}</b>. That&apos;s what makes Pods self-heal.</Explain>
        <KV k="Owner" v={owner ? <Link onClick={() => onSelect({ kind: "deployment", ns, name: owner.name })}>{`${owner.kind}/${owner.name}`}</Link> : "—"} />
        <KV k="Selector" v={Object.entries(r.spec!.selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",")} />
        <KV k="Image" v={r.spec?.template?.spec?.containers?.[0]?.image ?? "—"} />
        <KV k="Revision" v={r.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? "—"} />
      </div>
      <Section title={`Pods · ${ownedPods(c, r as unknown as AnyObject).length}`}>
        <PodLinks pods={ownedPods(c, r as unknown as AnyObject)} onSelect={onSelect} />
      </Section>
    </>
  );
}

function StatefulSetInspector({ sim, c, onSelect, s }: P & { s: StatefulSet }) {
  const ns = s.metadata.namespace;
  const want = s.spec?.replicas ?? 1;
  const pods = ownedPods(c, s as unknown as AnyObject).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name, undefined, { numeric: true }));
  const claims = c.list<PersistentVolumeClaim>("PersistentVolumeClaim", ns).filter((p) => (s.spec?.volumeClaimTemplates ?? []).some((v) => p.metadata.name.startsWith(`${v.metadata.name}-${s.metadata.name}-`)));
  return (
    <>
      <InspectHeader kind="StatefulSet" name={s.metadata.name} color={(s.status?.readyReplicas ?? 0) === want ? CAT_COLOR.ok : CAT_COLOR.starting} status={`${s.status?.readyReplicas ?? 0}/${want} ready`} actions={<><Btn onClick={() => sim.exec(`kubectl scale statefulset ${s.metadata.name} --replicas=${want + 1}${ns !== "default" ? ` -n ${ns}` : ""}`)}>Scale +1</Btn><Btn onClick={() => sim.exec(`kubectl scale statefulset ${s.metadata.name} --replicas=${Math.max(0, want - 1)}${ns !== "default" ? ` -n ${ns}` : ""}`)}>Scale −1</Btn></>} />
      <div className="p-4">
        <Explain>Each Pod has a fixed name ({s.metadata.name}-0, -1, …), its own PersistentVolumeClaim, and a DNS name under the headless Service. With the default <b>{s.spec?.podManagementPolicy ?? "OrderedReady"}</b> policy they start in order, and scale down from the highest number.</Explain>
        <KV k="Image" v={s.spec?.template?.spec?.containers?.[0]?.image ?? "—"} />
        <KV k="Service" v={s.spec?.serviceName ?? "—"} />
        <KV k="Update" v={`${s.spec?.updateStrategy?.type ?? "RollingUpdate"}${s.spec?.updateStrategy?.rollingUpdate?.partition ? ` (partition ${s.spec.updateStrategy.rollingUpdate.partition})` : ""}`} />
        <KV k="Revision" v={s.status?.updateRevision ?? "—"} />
      </div>
      <Section title={`Pods · ${pods.length}`}>
        <PodLinks pods={pods} onSelect={onSelect} note={(p) => `${podStatus(p)}${p.spec?.subdomain ? ` · ${p.spec.hostname}.${p.spec.subdomain}` : ""}`} />
      </Section>
      {claims.length > 0 && (
        <Section title={`Claims · ${claims.length}`}>
          {claims.map((p) => (
            <button key={p.metadata.uid} onClick={() => onSelect({ kind: "pvc", ns, name: p.metadata.name })} className="flex w-full items-center gap-2 px-1.5 py-1 text-left hover:bg-ink/[0.04]">
              <Dot color={p.status?.phase === "Bound" ? CAT_COLOR.ok : CAT_COLOR.starting} />
              <span className="truncate font-mono text-[11.5px] text-ink">{p.metadata.name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-ink-soft">{p.status?.phase}</span>
            </button>
          ))}
        </Section>
      )}
    </>
  );
}

function DaemonSetInspector({ c, onSelect, d }: P & { d: DaemonSet }) {
  const pods = ownedPods(c, d as unknown as AnyObject);
  const st = d.status;
  return (
    <>
      <InspectHeader kind="DaemonSet" name={d.metadata.name} color={(st?.numberReady ?? 0) === (st?.desiredNumberScheduled ?? 0) ? CAT_COLOR.ok : CAT_COLOR.starting} status={`${st?.numberReady ?? 0}/${st?.desiredNumberScheduled ?? 0} nodes`} />
      <div className="p-4">
        <Explain>A DaemonSet runs one Pod on every Node that matches it, and adds one when a Node joins. It tolerates cordoned and unreachable Nodes, which is why <b>kubectl drain</b> needs <b>--ignore-daemonsets</b>.</Explain>
        <KV k="Image" v={d.spec?.template?.spec?.containers?.[0]?.image ?? "—"} />
        <KV k="Node selector" v={Object.entries(d.spec?.template?.spec?.nodeSelector ?? {}).map(([a, b]) => `${a}=${b}`).join(",") || "every node"} />
      </div>
      <Section title={`Pods · ${pods.length}`}>
        <PodLinks pods={pods} onSelect={onSelect} note={(p) => p.spec?.nodeName ?? "unscheduled"} />
      </Section>
    </>
  );
}

function JobInspector({ c, onSelect, j }: P & { j: Job }) {
  const pods = ownedPods(c, j as unknown as AnyObject);
  const st = j.status ?? {};
  const done = (st.conditions ?? []).some((x) => x.type === "Complete" && x.status === "True");
  const failed = (st.conditions ?? []).some((x) => x.type === "Failed" && x.status === "True");
  const owner = j.metadata.ownerReferences?.find((o) => o.controller);
  return (
    <>
      <InspectHeader kind="Job" name={j.metadata.name} color={failed ? CAT_COLOR.bad : done ? CAT_COLOR.ok : CAT_COLOR.starting} status={failed ? "Failed" : done ? "Complete" : "Running"} />
      <div className="p-4">
        <Explain>A Job runs Pods until <b>{j.spec?.completions ?? 1}</b> of them succeed ({j.spec?.parallelism ?? 1} at a time). Failed Pods are replaced after a growing back-off, up to <b>{j.spec?.backoffLimit ?? 6}</b> retries.</Explain>
        {owner && <KV k="CronJob" v={<Link onClick={() => onSelect({ kind: "cronjob", ns: j.metadata.namespace, name: owner.name })}>{owner.name}</Link>} />}
        <KV k="Completions" v={`${st.succeeded ?? 0}/${j.spec?.completions ?? 1}`} />
        <KV k="Active" v={st.active ?? 0} />
        <KV k="Failed" v={st.failed ?? 0} />
        {st.startTime !== undefined && <KV k="Duration" v={age((st.completionTime ?? c.now) - st.startTime)} />}
        {failed && <KV k="Reason" v={(st.conditions ?? []).find((x) => x.type === "Failed")?.reason} />}
      </div>
      <Section title={`Pods · ${pods.length}`}>
        <PodLinks pods={pods} onSelect={onSelect} />
      </Section>
    </>
  );
}

function CronJobInspector({ sim, c, onSelect, cj }: P & { cj: CronJob }) {
  const ns = cj.metadata.namespace;
  const jobs = c.list<Job>("Job", ns).filter((j) => j.metadata.ownerReferences?.some((o) => o.uid === cj.metadata.uid));
  const flagNs = ns !== "default" ? ` -n ${ns}` : "";
  return (
    <>
      <InspectHeader
        kind="CronJob"
        name={cj.metadata.name}
        color={cj.spec?.suspend ? CAT_COLOR.gone : CAT_COLOR.ok}
        status={cj.spec?.suspend ? "suspended" : cj.spec!.schedule}
        actions={
          <>
            <Btn onClick={() => sim.exec(`kubectl create job ${cj.metadata.name}-manual-${Math.floor(c.now / 1000)} --from=cronjob/${cj.metadata.name}${flagNs}`)}>Run now</Btn>
            <Btn onClick={() => sim.exec(`kubectl patch cronjob ${cj.metadata.name}${flagNs} -p '{"spec":{"suspend":${!cj.spec?.suspend}}}'`)}>{cj.spec?.suspend ? "Resume" : "Suspend"}</Btn>
          </>
        }
      />
      <div className="p-4">
        <Explain>At every time matching <b>{cj.spec!.schedule}</b> ({cj.spec?.timeZone ?? "UTC"}), this CronJob creates a Job.{cj.spec?.timeZone ? "" : " This simulator, like a kind cluster, uses UTC; a real cluster uses its controller manager's time zone unless you set spec.timeZone."} It keeps the last {cj.spec?.successfulJobsHistoryLimit ?? 3} successful and {cj.spec?.failedJobsHistoryLimit ?? 1} failed Jobs.</Explain>
        <KV k="Concurrency" v={cj.spec?.concurrencyPolicy ?? "Allow"} />
        <KV k="Last run" v={cj.status?.lastScheduleTime !== undefined ? `${age(c.now - cj.status.lastScheduleTime)} ago` : "never"} />
        <KV k="Active" v={cj.status?.active?.length ?? 0} />
      </div>
      <Section title={`Jobs · ${jobs.length}`}>
        {jobs.length === 0 && <p className="text-[12.5px] text-ink-soft">No Jobs yet.</p>}
        {jobs.map((j) => {
          const done = (j.status?.conditions ?? []).some((x) => x.type === "Complete" && x.status === "True");
          const failed = (j.status?.conditions ?? []).some((x) => x.type === "Failed" && x.status === "True");
          return (
            <button key={j.metadata.uid} onClick={() => onSelect({ kind: "job", ns, name: j.metadata.name })} className="flex w-full items-center gap-2 px-1.5 py-1 text-left hover:bg-ink/[0.04]">
              <Dot color={failed ? CAT_COLOR.bad : done ? CAT_COLOR.ok : CAT_COLOR.starting} />
              <span className="truncate font-mono text-[11.5px] text-ink">{j.metadata.name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-ink-soft">{failed ? "Failed" : done ? "Complete" : "Running"}</span>
            </button>
          );
        })}
      </Section>
    </>
  );
}

function IngressInspector({ sim, c, onSelect, ing }: P & { ing: Ingress }) {
  const ns = ing.metadata.namespace;
  const addr = ing.status?.loadBalancer?.ingress?.[0]?.hostname ?? ing.status?.loadBalancer?.ingress?.[0]?.ip;
  const rules = (ing.spec?.rules ?? []).flatMap((r) => (r.http?.paths ?? []).map((p) => ({ host: r.host, path: p.path ?? "/", type: p.pathType, svc: p.backend.service?.name, port: p.backend.service?.port.number ?? p.backend.service?.port.name })));
  const curlFor = (host: string | undefined, path: string) => (host ? `curl -H 'Host: ${host}' http://localhost${path.replace(/\*$/, "")}` : `curl http://localhost${path}`);
  return (
    <>
      <InspectHeader kind="Ingress" name={ing.metadata.name} color={addr ? CAT_COLOR.ok : CAT_COLOR.starting} status={addr ? `address ${addr}` : "waiting for the controller"} actions={rules[0] ? <Btn onClick={() => sim.exec(curlFor(rules[0].host, rules[0].path))} title="Send a test request through this Ingress">curl</Btn> : undefined} />
      <div className="p-4">
        <Explain>The ingress-nginx controller routes HTTP from outside the cluster to Services by host and path. From the terminal, <b>curl http://localhost/…</b> (or a rule&apos;s hostname) goes through it.</Explain>
        <KV k="Class" v={ing.spec?.ingressClassName ?? "—"} />
        {Object.entries(ing.metadata.annotations ?? {}).filter(([k]) => k.startsWith("nginx.")).map(([k, v]) => (
          <KV key={k} k={k.split("/").pop()!} v={v} />
        ))}
      </div>
      <Section title="Rules">
        {rules.map((r, i) => {
          const svc = r.svc ? (c.raw("Service", ns, r.svc) as unknown as Service | undefined) : undefined;
          return (
            <div key={i} className="flex items-center gap-2 py-1 font-mono text-[11.5px]">
              <span className="text-ink-soft">{r.host ?? "*"}</span>
              <span className="text-ink">{r.path}</span>
              <span className="text-ink/30">{r.type}</span>
              <span className="text-ink/30">→</span>
              {svc ? <Link onClick={() => onSelect({ kind: "service", ns, name: svc.metadata.name })}>{`${r.svc}:${r.port}`}</Link> : <span className="text-red-700">{r.svc} (missing)</span>}
              <button className="ml-auto rounded-md border border-ink/15 bg-paper px-1.5 text-[10.5px] text-ink hover:border-ink/40" onClick={() => sim.exec(curlFor(r.host, r.path))}>
                curl
              </button>
            </div>
          );
        })}
      </Section>
    </>
  );
}

type ConfigLike = Omit<ConfigMap, "kind"> & { type?: string };

function ConfigInspector({ c, onSelect, o, secret }: P & { o: ConfigLike; secret: boolean }) {
  const [reveal, setReveal] = useState(false);
  const ns = o.metadata.namespace;
  const data = o.data ?? {};
  const users = usedBy(c, ns, (p) => {
    const vols = (p.spec?.volumes ?? []).some((v) => (secret ? v.secret?.secretName : v.configMap?.name) === o.metadata.name);
    const envs = (p.spec?.containers ?? []).some((ct) => (ct.env ?? []).some((e) => (secret ? e.valueFrom?.secretKeyRef?.name : e.valueFrom?.configMapKeyRef?.name) === o.metadata.name) || (ct.envFrom ?? []).some((e) => (secret ? e.secretRef?.name : e.configMapRef?.name) === o.metadata.name));
    return vols || envs;
  });
  const decode = (v: string) => {
    try {
      return decodeURIComponent(escape(atob(v)));
    } catch {
      return v;
    }
  };
  return (
    <>
      <InspectHeader kind={secret ? "Secret" : "ConfigMap"} name={o.metadata.name} color={NEUTRAL} status={`${Object.keys(data).length} key${Object.keys(data).length === 1 ? "" : "s"}${secret ? ` · ${o.type ?? "Opaque"}` : ""}`} actions={secret ? <Btn onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Decode"}</Btn> : undefined} />
      <div className="p-4">
        <Explain>
          {secret ? (
            <>Secret values are only <b>base64-encoded</b>, not encrypted. Pods read them as env vars or files, like a ConfigMap. Anyone who can read Secrets in this namespace can decode them.</>
          ) : (
            <>Pods read these keys as <b>env vars</b> (fixed when the container starts) or as <b>files</b> in a volume (updated within about a minute of an edit).</>
          )}
        </Explain>
        {Object.entries(data).map(([k, v]) => (
          <KV key={k} k={k} v={<span className="whitespace-pre-wrap">{secret ? (reveal ? decode(v) : v) : v.length > 160 ? v.slice(0, 160) + "…" : v}</span>} />
        ))}
      </div>
      <Section title={`Used by · ${users.length}`}>
        <PodLinks pods={users} onSelect={onSelect} />
      </Section>
    </>
  );
}

function PvcInspector({ c, onSelect, pvc }: P & { pvc: PersistentVolumeClaim }) {
  const ns = pvc.metadata.namespace;
  const pv = pvc.spec?.volumeName ? (c.raw("PersistentVolume", undefined, pvc.spec.volumeName) as unknown as PersistentVolume | undefined) : undefined;
  const node = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms?.[0]?.matchExpressions?.[0]?.values?.[0];
  const sc = pvc.spec?.storageClassName ? (c.raw("StorageClass", undefined, pvc.spec.storageClassName) as unknown as StorageClass | undefined) : undefined;
  const users = usedBy(c, ns, (p) => (p.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === pvc.metadata.name));
  const phase = pvc.metadata.deletionTimestamp !== undefined ? "Terminating" : (pvc.status?.phase ?? "Pending");
  return (
    <>
      <InspectHeader kind="PersistentVolumeClaim" name={pvc.metadata.name} color={phase === "Bound" ? CAT_COLOR.ok : CAT_COLOR.starting} status={phase} />
      <div className="p-4">
        <Explain>
          A claim asks for storage; a PersistentVolume provides it.{" "}
          {pvc.spec?.storageClassName && !pv && !sc ? (
            <>
              The <b>{pvc.spec.storageClassName}</b> StorageClass doesn&apos;t exist, so nothing will create a volume for it: it stays Pending until that class is created or a matching PersistentVolume appears.
            </>
          ) : pvc.spec?.storageClassName && !pv && sc && sc.provisioner !== "rancher.io/local-path" ? (
            <>
              The <b>{pvc.spec.storageClassName}</b> StorageClass uses the provisioner <b>{sc.provisioner}</b>, which isn&apos;t running in this cluster (only <b>rancher.io/local-path</b> is), so it stays Pending until someone creates a matching PersistentVolume.
            </>
          ) : pvc.spec?.storageClassName ? (
            <>
              The <b>{pvc.spec.storageClassName}</b> StorageClass creates volumes on demand{node ? `. This one lives on ${node}, so Pods using it always land there.` : phase === "Pending" ? ", and waits for the first Pod that uses the claim." : "."}
            </>
          ) : (
            <>
              This claim has <b>no StorageClass</b>, so nothing will create a volume for it automatically: it binds only to an existing PersistentVolume that matches{node ? `. Its volume lives on ${node}, so Pods using it always land there.` : "."}
            </>
          )}
        </Explain>
        <KV k="Requested" v={pvc.spec?.resources?.requests?.storage} />
        <KV k="Access" v={(pvc.spec?.accessModes ?? []).join(", ")} />
        <KV k="Volume" v={pv ? `${pv.metadata.name} (${pv.spec?.persistentVolumeReclaimPolicy})` : "—"} />
        {node && <KV k="Node" v={<Link onClick={() => onSelect({ kind: "node", name: node })}>{node}</Link>} />}
        {phase === "Terminating" && <KV k="Why waiting" v="a Pod still uses it (pvc-protection)" />}
      </div>
      <Section title={`Used by · ${users.length}`}>
        <PodLinks pods={users} onSelect={onSelect} />
      </Section>
    </>
  );
}

function peerText(p: NetworkPolicyPeer): string {
  if (p.ipBlock) return `IPs in ${p.ipBlock.cidr}${p.ipBlock.except?.length ? ` except ${p.ipBlock.except.join(", ")}` : ""}`;
  const pods = p.podSelector ? Object.entries(p.podSelector.matchLabels ?? {}).map(([a, b]) => `${a}=${b}`).join(",") || "any Pod" : undefined;
  const nss = p.namespaceSelector ? Object.entries(p.namespaceSelector.matchLabels ?? {}).map(([a, b]) => `${a}=${b}`).join(",") || "any namespace" : undefined;
  if (pods && nss) return `Pods ${pods} in namespaces ${nss}`;
  if (nss) return `every Pod in namespaces ${nss}`;
  return `Pods ${pods} in this namespace`;
}

function NetPolInspector({ c, onSelect, np }: P & { np: NetworkPolicy }) {
  const ns = np.metadata.namespace;
  const types = np.spec?.policyTypes ?? ["Ingress"];
  const selected = c.list<Pod>("Pod", ns).filter((p) => Object.entries(np.spec?.podSelector?.matchLabels ?? {}).every(([a, b]) => p.metadata.labels?.[a] === b));
  const rules = (dir: "Ingress" | "Egress") => {
    if (!types.includes(dir)) return null;
    const list = (dir === "Ingress" ? np.spec?.ingress : np.spec?.egress) ?? [];
    if (!list.length) return <li>Blocks all {dir === "Ingress" ? "incoming" : "outgoing"} traffic.</li>;
    return list.map((r, i) => {
      const peers = (dir === "Ingress" ? (r as { from?: NetworkPolicyPeer[] }).from : (r as { to?: NetworkPolicyPeer[] }).to) ?? [];
      const ports = (r.ports ?? []).map((p) => `${p.port ?? "any"}/${p.protocol ?? "TCP"}`).join(", ");
      return (
        <li key={`${dir}${i}`}>
          Allows {dir === "Ingress" ? "from" : "to"} {peers.length ? peers.map(peerText).join(" or ") : "anywhere"}
          {ports ? ` on ${ports}` : " on any port"}.
        </li>
      );
    });
  };
  return (
    <>
      <InspectHeader kind="NetworkPolicy" name={np.metadata.name} color={NEUTRAL} status={types.join(" + ")} />
      <div className="p-4">
        <Explain>Pods this policy selects are <b>isolated</b>: only traffic allowed by some policy gets in{types.includes("Egress") ? " or out" : ""}. Other traffic is dropped, so clients see a timeout.{types.includes("Egress") ? " Egress rules must also allow DNS (UDP and TCP port 53), or name lookups fail." : ""}</Explain>
        <KV k="Selects" v={Object.entries(np.spec?.podSelector?.matchLabels ?? {}).map(([a, b]) => `${a}=${b}`).join(",") || "every Pod in the namespace"} />
        <ul className="mt-2 list-disc pl-5 text-[12.5px] leading-relaxed text-ink">
          {rules("Ingress")}
          {rules("Egress")}
        </ul>
      </div>
      <Section title={`Selected Pods · ${selected.length}`}>
        <PodLinks pods={selected} onSelect={onSelect} note={(p) => (isIsolated(c, p, "Ingress") ? "isolated" : podStatus(p))} />
      </Section>
    </>
  );
}

function HpaInspector({ c, onSelect, h }: P & { h: HorizontalPodAutoscaler }) {
  const ns = h.metadata.namespace;
  const cur = h.status?.currentMetrics?.[0]?.resource?.current?.averageUtilization;
  const tgt = h.spec?.metrics?.[0]?.resource?.target.averageUtilization ?? 80;
  const target = h.spec!.scaleTargetRef;
  return (
    <>
      <InspectHeader kind="HorizontalPodAutoscaler" name={h.metadata.name} color={NEUTRAL} status={`${h.status?.currentReplicas ?? 0} → ${h.status?.desiredReplicas ?? 0} replicas`} />
      <div className="p-4">
        <Explain>Every 15 seconds the HPA compares average CPU use to <b>{tgt}%</b> of the Pods&apos; CPU requests and sets the replica count to match. It scales up quickly and waits 5 minutes before scaling down.</Explain>
        <KV k="Target" v={target.kind === "Deployment" ? <Link onClick={() => onSelect({ kind: "deployment", ns, name: target.name })}>{`${target.kind}/${target.name}`}</Link> : `${target.kind}/${target.name}`} />
        <KV k="CPU" v={`${cur !== undefined ? `${cur}%` : "unknown"} of ${tgt}% target`} />
        <KV k="Range" v={`${h.spec?.minReplicas ?? 1} to ${h.spec?.maxReplicas}`} />
        {h.status?.lastScaleTime !== undefined && <KV k="Last scaled" v={`${age(c.now - h.status.lastScaleTime)} ago`} />}
      </div>
      <Section title="Conditions">
        {(h.status?.conditions ?? []).map((cd) => (
          <div key={cd.type} className="py-1 text-[12px]">
            <span className={`font-medium ${cd.status === "True" ? "text-ink" : "text-amber-700"}`}>{cd.type}</span> <span className="text-ink-soft">{cd.reason}</span>
            <div className="text-ink-soft">{cd.message}</div>
          </div>
        ))}
      </Section>
    </>
  );
}

function BindingInspector({ c, b }: P & { b: RoleBinding }) {
  const role = c.raw(b.roleRef.kind, b.roleRef.kind === "Role" ? b.metadata.namespace : undefined, b.roleRef.name) as unknown as Role | undefined;
  return (
    <>
      <InspectHeader kind="RoleBinding" name={b.metadata.name} color={NEUTRAL} status={`${b.roleRef.kind}/${b.roleRef.name}`} />
      <div className="p-4">
        <Explain>A RoleBinding grants a Role&apos;s permissions to users, groups or ServiceAccounts, in namespace <b>{b.metadata.namespace}</b>. Try <b>kubectl auth can-i … --as=…</b> to check what someone may do.</Explain>
        <KV k="Subjects" v={<span className="whitespace-pre-line">{(b.subjects ?? []).map((s) => `${s.kind} ${s.kind === "ServiceAccount" ? `${s.namespace ?? b.metadata.namespace}/` : ""}${s.name}`).join("\n") || "—"}</span>} />
      </div>
      <Section title={`${b.roleRef.kind} ${b.roleRef.name}`}>
        {!role && <p className="text-[12.5px] text-red-700">This role doesn&apos;t exist, so the binding grants nothing.</p>}
        {(role?.rules ?? []).slice(0, 12).map((r, i) => (
          <div key={i} className="py-1 font-mono text-[11.5px] text-ink-soft">
            <span className="text-ink">{r.verbs.join(", ")}</span> <span className="text-ink-soft/70">on</span> {(r.resources ?? r.nonResourceURLs ?? []).join(", ")}
            {r.apiGroups && r.apiGroups.some((g) => g) ? <span className="text-ink-soft/70"> ({r.apiGroups.filter(Boolean).join(", ")})</span> : null}
            {r.resourceNames?.length ? <span className="text-ink-soft/70"> named {r.resourceNames.join(", ")}</span> : null}
          </div>
        ))}
      </Section>
    </>
  );
}

export function CommandLog({ log }: { log: LogEntry[] }) {
  if (!log.length) return <p className="py-2 text-[12.5px] text-ink-soft">Every action runs the real kubectl command shown here, so you learn the CLI as you click.</p>;
  return (
    <div className="flex flex-col gap-3 py-1">
      {log.map((l) => (
        <div key={l.id} className="font-mono text-[11.5px] leading-relaxed">
          <div className="flex gap-3">
            <span className="w-10 shrink-0 text-ink/30">{clock(l.at)}</span>
            <span>
              <span className="text-ink-soft">$ </span>
              <span className="text-ink">{l.cmd}</span>
            </span>
          </div>
          <pre className={`whitespace-pre-wrap pl-[52px] ${l.ok ? "text-ink-soft" : "text-red-700"}`}>{l.out}</pre>
        </div>
      ))}
    </div>
  );
}

const RESOURCE_KINDS: { kind: string; label: string }[] = [
  { kind: "Pod", label: "Pods" },
  { kind: "Deployment", label: "Deployments" },
  { kind: "ReplicaSet", label: "ReplicaSets" },
  { kind: "StatefulSet", label: "StatefulSets" },
  { kind: "DaemonSet", label: "DaemonSets" },
  { kind: "Job", label: "Jobs" },
  { kind: "CronJob", label: "CronJobs" },
  { kind: "HorizontalPodAutoscaler", label: "HorizontalPodAutoscalers" },
  { kind: "Service", label: "Services" },
  { kind: "Ingress", label: "Ingresses" },
  { kind: "NetworkPolicy", label: "NetworkPolicies" },
  { kind: "ConfigMap", label: "ConfigMaps" },
  { kind: "Secret", label: "Secrets" },
  { kind: "PersistentVolumeClaim", label: "PersistentVolumeClaims" },
];

/** A live `kubectl get` for the namespace in view, one table per kind that has objects. */
export function ResourceTable({ c, namespace = "default" }: { c: Cluster; namespace?: string }) {
  const ns = namespace === "*" ? "default" : namespace;
  const th = "pb-1.5 pr-4 text-left text-[11px] font-medium text-ink-soft";
  const sections = RESOURCE_KINDS.map(({ kind, label }) => {
    let objs = c.list(kind, ns);
    if (kind === "ConfigMap") objs = objs.filter((o) => o.metadata.name !== "kube-root-ca.crt");
    if (kind === "Service") objs = objs.filter((o) => o.metadata.name !== "kubernetes");
    return { kind, label, objs };
  }).filter((s) => s.objs.length);
  if (!sections.length) return <div className="py-2 text-[12.5px] text-ink-soft">No resources found in {ns} namespace.</div>;
  return (
    <div className="flex flex-col gap-4 py-1">
      {sections.map(({ kind, label, objs }) => {
        const [head, ...rows] = tableRows(c, kind, objs, false);
        return (
          <table key={kind} className="w-full font-mono text-[11.5px]" aria-label={label}>
            <thead>
              <tr>
                {head.map((h, i) => (
                  <th key={h} className={th}>
                    {i === 0 ? label : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-ink">
              {rows.map((r, i) => (
                <tr key={objs[i]?.metadata.uid ?? i} className="border-t border-ink/15">
                  {r.map((cell, j) => (
                    <td key={j} className={`py-1 pr-4 ${j === 0 ? "" : "text-ink-soft"}`}>
                      {kind === "Pod" && j === 2 ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Dot color={CAT_COLOR[podCategory(objs[i] as unknown as Pod)]} />
                          {cell}
                        </span>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}

export function EventsTable({ events, now }: { events: KubeEvent[]; now: number }) {
  if (!events.length) return <p className="py-2 text-[12.5px] text-ink-soft">No events yet.</p>;
  return (
    <div className="flex flex-col py-1 font-mono text-[11.5px]">
      {events.slice(0, 150).map((e) => (
        <div key={e.metadata.uid} className="flex gap-3 border-t border-ink/15 py-1 first:border-0">
          <span className="w-10 shrink-0 text-ink-soft">{age(now - e.lastTimestamp)}</span>
          <span className={`w-40 shrink-0 ${e.type === "Warning" ? "text-amber-700" : "text-ink"}`}>{e.reason}</span>
          <span className="w-56 shrink-0 truncate text-ink-soft">
            {e.involvedObject.kind.toLowerCase()}/{e.involvedObject.name}
          </span>
          <span className="min-w-0 text-ink-soft">
            {e.message}
            {e.count > 1 && <span className="text-ink-soft/70"> ×{e.count}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

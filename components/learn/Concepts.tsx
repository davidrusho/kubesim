"use client";

import Link from "next/link";
import { AppHeader } from "../AppHeader";
import { Illustration } from "../illustrations/Illustration";
import { SCENES } from "../illustrations/scenes";

const WHERE: Record<string, { href: string; label: string }> = {
  architecture: { href: "/learn/first-pod", label: "Your first Pod" },
  apply: { href: "/learn/declarative-yaml", label: "Declarative YAML" },
  service: { href: "/learn/services", label: "Services & networking" },
  probes: { href: "/learn/health-checks", label: "Health checks: readiness & liveness" },
  ingress: { href: "/learn/ingress", label: "Ingress" },
  "network-policy": { href: "/learn/network-policies", label: "Network policies" },
  "pv-pvc": { href: "/learn/persistent-storage", label: "Persistent storage" },
  hpa: { href: "/learn/autoscaling", label: "Autoscaling with the HPA" },
  rbac: { href: "/learn/rbac", label: "RBAC & ServiceAccounts" },
  scheduling: { href: "/learn/scheduling", label: "Scheduling: selectors, taints & drains" },
};

export function ConceptIndex() {
  return (
    <div className="font-sheet min-h-screen bg-paper text-ink">
      <AppHeader sheet />
      <header className="mx-auto max-w-4xl px-6 pb-8 pt-12">
        <h1 className="font-display text-balance text-[40px] leading-[1.05] sm:text-[48px]">Concepts</h1>
        <p className="text-pretty mt-3 max-w-2xl text-[17px] leading-snug text-ink-soft">Illustrated walk-throughs of how Kubernetes is put together. Step through each one, then try it for real in the lesson it belongs to.</p>
      </header>
      <main className="mx-auto max-w-4xl px-6 pb-24">
        <div className="flex flex-col gap-10">
          {Object.values(SCENES).map((s) => (
            <section key={s.id}>
              <Illustration scene={s} defaultOpen />
              {WHERE[s.id] && (
                <Link href={WHERE[s.id].href} className="mt-3 inline-flex min-h-6 items-center text-[14.5px] underline underline-offset-4 hover:text-signal">
                  Try it in “{WHERE[s.id].label}”
                </Link>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

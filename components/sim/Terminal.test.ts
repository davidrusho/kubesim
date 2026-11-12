import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Cluster } from "@/lib/engine";
import { SimStore } from "@/lib/sim/useSimulation";
import { Terminal } from "./Terminal";

test("a practice terminal suggests no command in its greeting or prompt", () => {
  const html = renderToStaticMarkup(createElement(Terminal, { sim: new SimStore(), quiet: true }));
  expect(html).not.toContain("kubectl");
  expect(html).not.toContain("help");
});

test("a practice prompt hides the namespace, as the exam prompt does; the ordinary one shows it", () => {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 3, systemPods: true });
  s.exec("kubectl config set-context --current --namespace=kube-system");
  s.exec("kubectl get pods");
  expect(s.namespace).toBe("kube-system"); // control: the switch took
  expect(renderToStaticMarkup(createElement(Terminal, { sim: s }))).toContain("(kube-system) $");
  expect(renderToStaticMarkup(createElement(Terminal, { sim: s, quiet: true }))).not.toContain("(kube-system)");
});

test("the ordinary terminal still suggests where to begin", () => {
  expect(renderToStaticMarkup(createElement(Terminal, { sim: new SimStore() }))).toContain("kubectl get pods");
});

test("command output is not soft-wrapped: one line stays one line, and the area scrolls sideways", () => {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 3, systemPods: true });
  s.exec("kubectl get pods -A -o wide");
  const html = renderToStaticMarkup(createElement(Terminal, { sim: s }));
  const pre = /<pre class="([^"]*)"/.exec(html)?.[1] ?? "";
  expect(pre).toContain("whitespace-pre");
  expect(pre).not.toContain("whitespace-pre-wrap");
  expect(pre).not.toContain("break-words");
  expect(html).toContain("overflow-auto"); // the output area scrolls horizontally
});

test("the terminal has a text size control", () => {
  const html = renderToStaticMarkup(createElement(Terminal, { sim: new SimStore() }));
  expect(html).toContain('aria-label="Smaller text"');
  expect(html).toContain('aria-label="Larger text"');
  expect(html).toContain("font-size:12px");
});

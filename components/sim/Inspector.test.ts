import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Cluster } from "@/lib/engine";
import { SimStore } from "@/lib/sim/useSimulation";
import { Inspector } from "./Inspector";

function shop() {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 3, systemPods: true });
  s.exec("kubectl create deployment web --image=nginx:nope --replicas=1");
  s.cluster.advance(60_000);
  return s;
}
const render = (quiet: boolean) => {
  const s = shop();
  return renderToStaticMarkup(createElement(Inspector, { sim: s, c: s.cluster!, sel: { kind: "deployment", ns: "default", name: "web" }, onSelect: () => {}, quiet }));
};

test("the Inspector explains and diagnoses by default", () => {
  const html = render(false);
  expect(html).toContain("keeps");
  expect(html).toContain("What&#x27;s wrong");
});

test("in practice mode it shows neither the explanation nor the 'What's wrong' panel", () => {
  const html = render(true);
  expect(html).not.toContain("keeps");
  expect(html).not.toContain("What&#x27;s wrong");
  expect(html).not.toContain("$ kubectl");
});

import { expect, test } from "@playwright/test";
import { run, setSpeed, watchErrors } from "./helpers";

test("home page links to every way to learn", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Learn Kubernetes by breaking it");
  for (const name of ["Lessons", "Challenges", "Exams", "Explainers", "Sandbox", "Progress"]) {
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("the first lesson ticks off a step from the terminal", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/learn/first-pod/");
  await run(page, "kubectl get nodes");
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText("control-plane");
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the curriculum map groups lessons by track", async ({ page }) => {
  await page.goto("/learn/");
  const map = page.getByRole("navigation", { name: "Curriculum map" });
  for (const t of ["Foundations", "Workloads", "Configuration", "Networking", "Storage", "Operations", "Security"]) await expect(map.getByText(t)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Networking", exact: true })).toBeVisible();
});

test("a lesson's progress shows on the progress page", async ({ page }) => {
  await page.goto("/learn/first-pod/");
  await run(page, "kubectl get nodes");
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
  await page.goto("/progress/");
  await expect(page.getByRole("link", { name: /^Your first Pod \(started\)/ })).toContainText("1/5");
});

test("sandbox: the Ingress scenario routes by path", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sandbox/");
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  await page.getByRole("button", { name: /Ingress routing/ }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await setSpeed(page, "30×");
  const log = page.getByRole("log", { name: "Terminal output" });
  await expect(log).toContainText("curl http://localhost/apple", { timeout: 30_000 });
  await expect(log).toContainText("banana");
  await expect(log).toContainText("404 Not Found");
  expect(errors).toEqual([]);
});

test("sandbox: an untouched cluster says it's free play, and goes away once you start", async ({ page }) => {
  await page.goto("/sandbox/");
  await expect(page.getByText("Your cluster. No rules.")).toBeVisible();
  await page.getByRole("button", { name: "Create a Deployment" }).click();
  await expect(page.getByText("Your cluster. No rules.")).toBeHidden();
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText("deployment.apps/web created");
});

test("layout: Spotlight and Split switch on every screen and the choice is remembered", async ({ page }) => {
  await page.goto("/learn/first-pod/");
  const layout = page.getByRole("group", { name: "Layout" });
  // Lessons (like Incidents and Challenges) open in Split: the steps and the terminal sit in cards beside the canvas.
  await expect(layout.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
  await layout.getByRole("button", { name: "Spotlight" }).click();
  await expect(layout.getByRole("button", { name: "Spotlight" })).toHaveAttribute("aria-pressed", "true");
  await run(page, "kubectl get nodes");
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
  // The choice carries over to other screens and survives a reload.
  await page.goto("/sandbox/");
  await expect(page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Spotlight" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Split" }).click();
  await page.reload();
  await expect(page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
  await run(page, "kubectl get nodes");
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText("control-plane");
});

test("sandbox: a shared link opens a copy of the cluster", async ({ page, context }) => {
  await page.goto("/sandbox/");
  await run(page, "kubectl create deployment shared-web --image=nginx --replicas=2");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("#cluster=1.");
  const other = await context.newPage();
  await other.addInitScript(() => localStorage.clear());
  await other.goto(url);
  await expect(other.getByRole("status").filter({ hasText: "Loaded the shared cluster" })).toBeVisible();
  await run(other, "kubectl get deploy");
  await expect(other.getByRole("log", { name: "Terminal output" })).toContainText("shared-web");
});

test("the Cluster View has a text alternative and keyboard access", async ({ page }) => {
  await page.goto("/sandbox/");
  await run(page, "kubectl run solo --image=nginx");
  await page.getByRole("button", { name: "Text view" }).click();
  await expect(page.getByRole("heading", { name: /Nodes \(3\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^solo: / })).toBeVisible();
  await page.getByRole("button", { name: /^solo: / }).click();
  await expect(page.getByText("Pod", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Diagram view" }).click();
  const pod = page.getByRole("button", { name: /^Pod solo,/ });
  await pod.focus();
  await page.keyboard.press("Enter");
  await expect(pod).toHaveAttribute("aria-pressed", "true");
});

test("a challenge hides the fix until asked", async ({ page }) => {
  await page.goto("/challenges/");
  const first = page.getByRole("main").locator("a[href^='/challenges/']").first();
  await first.click();
  await expect(page.getByText("The situation")).toBeVisible();
  const goal = page.getByRole("list", { name: "Goals" }).getByRole("listitem").first();
  await expect(goal.getByText("One way to fix it")).toHaveCount(0);
  await goal.getByRole("button", { name: "Show the fix" }).click();
  await expect(goal.getByText("One way to fix it")).toBeVisible();
});

// The practice exam flow is covered in flow.spec.ts ("exam: submitting grades the attempt…").

test("explainers play", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/explainers/");
  await page.getByRole("main").locator("a[href^='/explainers/']").first().click();
  await expect(page.locator("svg[aria-label='Cluster diagram']")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the home page's live cluster enlarges to full screen and back", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  const live = page.locator("section[aria-labelledby=try]");
  await live.scrollIntoViewIfNeeded();
  const canvas = live.getByRole("region", { name: /^Cluster View/ });
  await expect(canvas.getByRole("button", { name: "Full screen" })).toBeVisible();
  const before = await canvas.boundingBox();
  await canvas.getByRole("button", { name: "Full screen" }).click();
  await expect(canvas.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  const viewport = page.viewportSize()!;
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(viewport.width);
  await canvas.getByRole("button", { name: "Exit full screen" }).click();
  await expect(canvas.getByRole("button", { name: "Full screen" })).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())?.width).toBe(before!.width);
  expect(errors).toEqual([]);
});

test("sandbox: the traffic control adds the shop, overloads it, and names what's holding it back", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sandbox/");
  await page.getByRole("button", { name: /Add the shop/ }).click();
  await setSpeed(page, "5×");
  await expect(page.getByRole("combobox")).toHaveValue("default/shop-web", { timeout: 30_000 });
  await page.getByRole("button", { name: /^Presets/ }).click();
  await page.getByRole("button", { name: /^Launch day/ }).click();
  // No red banner: "Why?" opens the bottleneck in the sidebar, which says what's wrong.
  await page.getByRole("button", { name: /^Why:/ }).click({ timeout: 30_000 });
  await expect(page.getByText("It's what's slowing the traffic")).toBeVisible();
  await expect(page.locator("[aria-live=polite]").first()).toContainText(/errors/i);
  // The one-click spike doubles it.
  await page.getByRole("button", { name: /Spike/ }).click();
  await expect(page.getByRole("textbox", { name: "Requests per second" })).toHaveValue("2,000");
  await page.getByRole("button", { name: /^Challenges/ }).click();
  await page.getByRole("button", { name: /^Autopilot Medium/ }).click();
  await expect(page.getByText("Needs an HPA on shop-web and on shop-api.")).toBeVisible();
  await page.getByRole("button", { name: "Show me how" }).click();
  await expect(page.getByRole("button", { name: /kubectl autoscale deployment shop-web/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("sandbox: a card moves where it's dropped, and Tidy up puts it back", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sandbox/");
  await run(page, "kubectl create deployment web --image=nginx --replicas=2");
  const card = page.locator('g[data-kind="deployment"]').first();
  const node = page.locator('g[data-kind="node"]').first();
  await expect(card).toBeVisible();
  // Wait for the view to stop fitting itself around the new objects before aiming at the card.
  const settled = async () => {
    let a = (await card.boundingBox())!;
    for (;;) {
      await page.waitForTimeout(250);
      const b = (await card.boundingBox())!;
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5) return b;
      a = b;
    }
  };
  const before = await settled();
  const nodeBefore = (await node.boundingBox())!;
  await page.mouse.move(before.x + 30, before.y + 12);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(before.x + 30 - i * 25, before.y + 12 + i * 10);
  await page.mouse.up();
  await expect.poll(async () => Math.round((await card.boundingBox())!.x)).toBeLessThan(before.x - 150);
  // The card moved, not the view: the Node stayed where it was.
  expect(Math.abs((await node.boundingBox())!.x - nodeBefore.x)).toBeLessThan(2);
  await page.getByRole("button", { name: /Tidy up/ }).click();
  await expect.poll(async () => Math.round((await card.boundingBox())!.x)).toBe(Math.round(before.x));
  expect(errors).toEqual([]);
});

test("sandbox: a Deployment card scales from the canvas, through kubectl, until an HPA takes over", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sandbox/");
  await run(page, "kubectl create deployment web --image=nginx --replicas=2");
  const card = page.locator('g[data-kind="deployment"]').first();
  await card.hover();
  await page.getByRole("button", { name: "Scale up web" }).click();
  await expect(page.getByText("kubectl scale deployment web --replicas=3", { exact: true })).toBeVisible();
  await card.hover();
  await page.getByRole("button", { name: "Scale down web" }).click();
  await page.getByRole("button", { name: "Scale down web" }).click();
  await expect(page.getByText("kubectl scale deployment web --replicas=1", { exact: true })).toBeVisible();
  await run(page, "kubectl autoscale deployment web --cpu=70% --min=1 --max=5");
  await expect(page.getByRole("button", { name: "Scale up web" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("sandbox: the sidebar says what's wrong and fixes it, and Delete removes anything, a worker Node included", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sandbox/");
  await setSpeed(page, "5×");
  await run(page, "kubectl create deployment web --image=nginx:1.27 --replicas=2");
  await expect(page.locator('g[data-kind="deployment"]').first()).toContainText("2/2", { timeout: 30_000 });
  await run(page, "kubectl set image deployment/web nginx=nginx:typo");
  await page.locator('g[data-kind="deployment"]').first().click();
  await expect(page.getByText("Can't pull its image")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Roll back to the version that worked" }).click();
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText("kubectl rollout undo deployment/web");
  await expect(page.getByText("Can't pull its image")).toHaveCount(0, { timeout: 30_000 });
  // A worker Node: Delete asks once, then runs kubectl.
  await page.locator('g[data-kind="node"]', { hasText: "worker-2" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(/The Node leaves the cluster/)).toBeVisible();
  await page.getByRole("button", { name: "Really delete?" }).click();
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText("node \"worker-2\" deleted");
  await expect(page.locator('g[data-kind="node"]', { hasText: "worker-2" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("sandbox: a Pod dropped on a Node asks what to run, from what's in the cluster", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sandbox/");
  await setSpeed(page, "5×");
  await run(page, "kubectl create deployment web --image=nginx --replicas=2");
  // Drag the palette's Pod onto worker-2.
  const palette = page.getByRole("button", { name: "Add to the cluster" });
  if ((await palette.getAttribute("aria-expanded")) !== "true") await palette.click();
  const pod = page.locator("[data-palette-item]", { hasText: "choose what it runs" });
  const node = page.locator('g[data-kind="node"]', { hasText: "worker-2" });
  await pod.scrollIntoViewIfNeeded();
  const from = (await pod.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 10, { steps: 4 });
  const to = (await node.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + 12, { steps: 12 });
  await expect(page.getByText("→ worker-2")).toBeVisible();
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "What should this Pod run?" });
  await expect(dialog).toContainText("You dropped it on worker-2");
  await expect(dialog.getByRole("button", { name: /^Another web Pod/ })).toBeVisible();
  await dialog.getByRole("button", { name: /^A typo in the image name/ }).click();
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText("kubectl run typo --image=ngnix");
  await expect(page.locator('g[data-kind="pod"]', { hasText: "typo" })).toBeVisible();
  await page.locator('g[data-kind="pod"]', { hasText: "typo" }).click();
  await expect(page.getByText("Can't pull its image")).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

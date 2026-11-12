// Incidents and the Daily Incident, played through the UI, and the Sandbox's Building Blocks.

import { expect, test } from "@playwright/test";
import { run, setSpeed, watchErrors } from "./helpers";

test("incident: paged, fixed with kubectl, resolved, result saved", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await page.goto("/incidents/lost-endpoints/");
  const pager = page.getByRole("status").filter({ hasText: "shop-web is returning 503s" });
  // The outage shows: the pager reports failing requests.
  await expect(pager).toContainText("Paged", { timeout: 30_000 });
  await expect(pager).toContainText("100%");
  await run(page, `kubectl patch service shop-api -p '{"spec":{"selector":{"app":"shop-api"}}}'`);
  await setSpeed(page, "5×");
  await expect(page.getByText(/^Resolved in \d+:\d\d$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: "Share on X" })).toHaveAttribute("href", /x\.com\/intent\/post\?text=.*The%20website%20fails%20though%20the%20API%20Pods%20look%20fine/);
  await page.goto("/incidents/");
  await expect(page.getByRole("link", { name: /The website fails though the API Pods look fine/ })).toContainText(/best \d+:\d\d/);
  expect(errors).toEqual([]);
});

test("daily incident: today's outage loads with a number and a pager", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/daily/");
  await expect(page.getByText(/^Daily Incident #\d+/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: /Paged|Something just changed/ })).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("sandbox: building blocks deploy real manifests, by click or search", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await page.goto("/sandbox/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const add = page.getByRole("button", { name: "Add to the cluster" });
  if ((await add.getAttribute("aria-expanded")) !== "true") await add.click();
  await page.getByRole("textbox", { name: "Search things to add" }).fill("postgres");
  await expect(page.getByRole("button", { name: /PostgreSQL/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Redis cache/ })).toHaveCount(0);
  await page.getByRole("button", { name: /PostgreSQL/ }).click();
  const log = page.getByRole("log", { name: "Terminal output" });
  await expect(log).toContainText("kubectl apply -f postgres.yaml");
  await expect(log).toContainText("statefulset.apps/postgres created");
  // The note offers the manifest it applied, open in the Editor.
  await page.getByRole("button", { name: "Open postgres.yaml →" }).click();
  await expect(page.getByRole("combobox", { name: "File" })).toHaveValue("postgres.yaml");
  expect(errors).toEqual([]);
});

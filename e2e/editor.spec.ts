// nano, vi and vim in the sandbox terminal open the YAML editor tab, which then behaves like the
// real tool: nano's Ctrl+O / Ctrl+X prompts, vim's :w :wq :q :q! and ZZ. Leaving returns to the
// terminal with the cursor in its input, and the file changes only when saved.

import { expect, test, type Page } from "@playwright/test";
import { watchErrors } from "./helpers";

const input = (page: Page) => page.getByRole("textbox", { name: "Terminal input" });
const term = (page: Page) => page.getByRole("log", { name: "Terminal output" });
const editor = (page: Page) => page.getByRole("textbox", { name: "YAML editor" });

/** Types a command and presses Enter, without waiting for it to show in the log (nano and vi replace the log with the editor). */
async function send(page: Page, cmd: string) {
  await input(page).fill(cmd);
  await input(page).press("Enter");
}

/** Back at the prompt with the input focused, and `cat file` printing `text`. */
async function expectFile(page: Page, file: string, text: string | RegExp) {
  await expect(input(page)).toBeFocused();
  await send(page, `cat ${file}`);
  await expect(term(page)).toContainText(text);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/sandbox/");
  await expect(input(page)).toBeVisible();
});

test("nano: Ctrl+X on a modified buffer asks, Y then Enter saves and returns to the terminal", async ({ page }) => {
  const errors = watchErrors(page);
  await send(page, "nano pod.yaml");
  await expect(page.getByTestId("nano-bar")).toContainText("^O");
  await expect(page.getByTestId("nano-bar")).toContainText("Write Out");
  await expect(page.getByTestId("nano-bar")).toContainText("Exit");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("kind: Pod");
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("nano-prompt")).toContainText("Save modified buffer?");
  await expect(page.getByTestId("nano-prompt")).toContainText("Cancel");
  await page.keyboard.press("y");
  const name = page.getByRole("textbox", { name: "File name to write" });
  await expect(page.getByTestId("nano-prompt")).toContainText("File Name to Write:");
  await expect(name).toHaveValue("pod.yaml");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "pod.yaml", "kind: Pod");
  expect(errors).toEqual([]);
});

test("nano: Ctrl+X then N discards the buffer, and Ctrl+C cancels back to editing", async ({ page }) => {
  await send(page, "echo 'keep: me' > a.yaml");
  await send(page, "nano a.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("junk: 1");
  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("nano-prompt")).toBeVisible();
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("nano-prompt")).toHaveCount(0);
  await expect(page.getByTestId("nano-status")).toContainText("Cancelled");
  await expect(editor(page)).toContainText("junk: 1");
  await page.keyboard.press("Control+x");
  await page.keyboard.press("n");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "a.yaml", "keep: me");
  await expect(term(page)).not.toContainText("junk");
  // Opening it again shows the saved text, not the discarded edit.
  await send(page, "nano a.yaml");
  await expect(editor(page)).toContainText("keep: me");
  await expect(editor(page)).not.toContainText("junk");
});

test("vi: :wq saves and returns to the terminal", async ({ page }) => {
  const errors = watchErrors(page);
  await send(page, "vi v.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await expect(page.locator(".cm-vim-panel")).toContainText("INSERT");
  await page.keyboard.type("kind: Service");
  await page.keyboard.press("Escape");
  // Esc is vim's Esc: normal mode, still in the editor.
  await expect(page.locator(".cm-vim-panel")).toContainText("NORMAL");
  await expect(editor(page)).toBeVisible();
  await page.keyboard.type(":wq");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "v.yaml", "kind: Service");
  expect(errors).toEqual([]);
});

test("vi: :q on a modified buffer refuses with E37, :w then :q exits", async ({ page }) => {
  await send(page, "vim m.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("x: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await expect(page.getByText("E37: No write since last change (add ! to override)")).toBeVisible();
  await expect(editor(page)).toBeVisible();
  await page.keyboard.type(":w");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/"m\.yaml" 1L, 4B written/)).toBeVisible();
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "m.yaml", "x: 1");
});

test("vi: :q! discards, and ZZ saves and exits", async ({ page }) => {
  await send(page, "echo 'keep: me' > q.yaml");
  await send(page, "vi q.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("junk: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":q!");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "q.yaml", "keep: me");
  await expect(term(page)).not.toContainText("junk");
  await send(page, "vi z.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("zz: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.type("ZZ");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "z.yaml", "zz: 1");
});

test("the Editor tab opened by hand stays plain: no nano bar, no vim line, every keystroke is kept", async ({ page }) => {
  await page.getByRole("button", { name: "YAML editor", exact: true }).click();
  await expect(page.getByTestId("nano-bar")).toHaveCount(0);
  await expect(page.locator(".cm-vim-panel")).toHaveCount(0);
  await editor(page).click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("# typed\n");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await send(page, "cat manifest.yaml");
  await expect(term(page)).toContainText("# typed");
});

test("nano: Ctrl+O, Enter, Ctrl+X saves with no stray newline and leaves with no question", async ({ page }) => {
  await send(page, "nano s.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("a: 1");
  await page.keyboard.press("Control+o");
  await expect(page.getByTestId("nano-prompt")).toContainText("File Name to Write:");
  await expect(page.getByRole("textbox", { name: "File name to write" })).toHaveValue("s.yaml");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("nano-status")).toContainText("[ Wrote 1 line ]");
  await expect(editor(page)).toBeFocused();
  // The Enter went to the prompt, not into the buffer.
  await expect(page.locator(".cm-line")).toHaveCount(1);
  await page.keyboard.press("Control+x");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "s.yaml", "a: 1");
});

test("nano: Ctrl+O then Ctrl+C says Cancelled and stays; saving under another name makes it the file", async ({ page }) => {
  await send(page, "nano c.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("k: 1");
  await page.keyboard.press("Control+o");
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("nano-status")).toContainText("Cancelled");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Control+o");
  await page.getByRole("textbox", { name: "File name to write" }).fill("other.yaml");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("nano-title")).toContainText("other.yaml");
  await page.keyboard.press("Control+x");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "other.yaml", "k: 1");
});

test("nano: the file picker is hidden, and Ctrl+K / Ctrl+U cut, accumulate and paste lines", async ({ page }) => {
  await send(page, "echo one > l.yaml");
  await send(page, "echo two >> l.yaml");
  await send(page, "echo three >> l.yaml");
  await send(page, "nano l.yaml");
  await expect(editor(page)).toBeFocused();
  await expect(page.getByRole("combobox", { name: "File" })).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+k");
  await expect(editor(page)).not.toContainText("one");
  await expect(editor(page)).not.toContainText("two");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+u");
  await page.keyboard.press("Control+o");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+x");
  await expect(editor(page)).toHaveCount(0);
  await send(page, "cat l.yaml");
  await expect(term(page)).toContainText(/three\s+one\s+two/);
});

test("vi: :w! writes the file (not a file called !), then :q exits without E37", async ({ page }) => {
  await send(page, "vi f.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("force: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":w!");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/"f\.yaml" 1L, 8B written/)).toBeVisible();
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "f.yaml", "force: 1");
  await send(page, "ls");
  await expect(term(page)).not.toContainText(/^!$/m);
  await expect(term(page).getByText("f.yaml", { exact: false }).last()).toBeVisible();
});

test("vi: :wqa saves and exits, :qa! discards and exits", async ({ page }) => {
  await send(page, "vi p.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("keep: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":wqa");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "p.yaml", "keep: 1");
  await send(page, "vi p.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("junk: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":qa!");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveCount(0);
  await expectFile(page, "p.yaml", "keep: 1");
  await expect(term(page)).not.toContainText("junk");
});

test("a second nano while one has unsaved edits is refused and the edits stay", async ({ page }) => {
  await send(page, "nano a.yaml");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("mine: 1");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await send(page, "nano b.yaml");
  await expect(term(page)).toContainText("a.yaml has unsaved changes in the editor");
  await page.getByRole("button", { name: "YAML editor", exact: true }).click();
  await expect(editor(page)).toContainText("mine: 1");
  await expect(page.getByTestId("nano-title")).toContainText("a.yaml");
  await expect(page.getByTestId("nano-title")).toContainText("Modified");
});

// The Editor's store-level behaviour: how nano / vi / vim open a file, and what saving and leaving do to it.
// The keys themselves (Ctrl+X, :wq) need a browser and are covered by e2e/editor.spec.ts.

import { expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { SimStore, lineCount } from "./useSimulation";

function store() {
  const s = new SimStore();
  s.cluster = new Cluster({ seed: 1, systemPods: true });
  s.files = { "manifest.yaml": "a: 1\n" };
  return s;
}

test("each way of opening a file records its mode: nano, vi (vi and vim), or none", () => {
  const s = store();
  s.exec("nano a.yaml");
  expect(s.editorMode).toBe("nano");
  expect(s.editorFile).toBe("a.yaml");
  s.exec("vi b.yaml");
  expect(s.editorMode).toBe("vi");
  s.exec("vim c.yaml");
  expect(s.editorMode).toBe("vi");
  s.exec("kubectl create deployment web --image=nginx");
  s.exec("kubectl edit deployment web");
  expect(s.editorMode).toBe(null);
  s.exec("nano a.yaml");
  s.openFile("manifest.yaml");
  expect(s.editorMode).toBe(null);
});

test("plain mode writes through and exitEditor does nothing", () => {
  const s = store();
  s.openFile("manifest.yaml");
  const seq = s.termSeq;
  s.exitEditor(true);
  expect(s.termSeq).toBe(seq);
  expect(s.focusSeq).toBe(0);
  expect(s.editorDirty).toBe(false);
});

test("in nano or vi the file changes only on save", () => {
  const s = store();
  s.exec("vi x.yaml");
  expect(s.files["x.yaml"]).toBeUndefined();
  s.setBuffer("kind: Pod\n");
  expect(s.files["x.yaml"]).toBeUndefined();
  expect(s.editorDirty).toBe(true);
  expect(s.saveBuffer()).toEqual({ name: "x.yaml", lines: 1, bytes: 10 });
  expect(s.files["x.yaml"]).toBe("kind: Pod\n");
  expect(s.editorDirty).toBe(false);
});

test("exit without saving discards the buffer, returns to the terminal and asks for its focus once", () => {
  const s = store();
  s.exec("nano x.yaml");
  s.setBuffer("junk");
  const seq = s.termSeq;
  s.exitEditor(false);
  expect(s.files["x.yaml"]).toBeUndefined();
  expect(s.editorMode).toBe(null);
  expect(s.termSeq).toBe(seq + 1);
  expect(s.takeFocusRequest()).toBe(true);
  expect(s.takeFocusRequest()).toBe(false);
  // Opening the same file again shows what was saved, not the discarded text.
  s.exec("nano x.yaml");
  expect(s.buffer).toBe("");
});

test("exit with save writes first, and opening the file again shows the saved text", () => {
  const s = store();
  s.exec("vim x.yaml");
  s.setBuffer("a: b\nc: d");
  s.exitEditor(true);
  expect(s.files["x.yaml"]).toBe("a: b\nc: d");
  expect(s.exec("cat x.yaml")?.out).toBe("a: b\nc: d");
  s.exec("nano x.yaml");
  expect(s.buffer).toBe("a: b\nc: d");
  expect(s.editorDirty).toBe(false);
});

test("nano or vi on any file while the open one has unsaved changes is refused, and the open buffer survives", () => {
  const s = store();
  s.exec("nano x.yaml");
  s.setBuffer("junk");
  const r = s.exec("nano y.yaml");
  expect(r?.ok).toBe(false);
  expect(r?.out).toContain("x.yaml has unsaved changes");
  expect(s.editorFile).toBe("x.yaml");
  expect(s.buffer).toBe("junk");
  expect(s.editorMode).toBe("nano");
  expect(s.exec("vim x.yaml")?.ok).toBe(false);
  expect(s.buffer).toBe("junk");
  // Once it is saved, another file may be opened, and the saved one starts from what was saved.
  s.saveBuffer();
  expect(s.exec("nano y.yaml")?.ok).toBe(true);
  expect(s.editorFile).toBe("y.yaml");
  expect(s.exec("nano x.yaml")?.ok).toBe(true);
  expect(s.buffer).toBe("junk");
});

test("opening a file in nano or vi does not create it; the first save does", () => {
  const s = store();
  s.exec("nano new.yaml");
  expect("new.yaml" in s.files).toBe(false);
  s.exitEditor(false);
  expect("new.yaml" in s.files).toBe(false);
  s.exec("vi -c 'set ts=2' new.yaml");
  expect(s.editorFile).toBe("new.yaml");
  s.setBuffer("a: 1\n");
  s.saveBuffer();
  expect(s.files["new.yaml"]).toBe("a: 1\n");
  // The Editor tab and kubectl edit still create what they open.
  s.openFile("plain.yaml");
  expect(s.files["plain.yaml"]).toBe("");
});

test("saving under another name leaves the original as it was saved and makes the new name the file being edited", () => {
  const s = store();
  s.exec("nano x.yaml");
  s.setBuffer("z: 1\n");
  expect(s.saveBuffer("y.yaml").name).toBe("y.yaml");
  expect(s.files["y.yaml"]).toBe("z: 1\n");
  expect(s.files["x.yaml"]).toBeUndefined();
  expect(s.editorFile).toBe("y.yaml");
  expect(s.editorDirty).toBe(false);
  // A later save or exit refers to the new name.
  s.setBuffer("z: 2\n");
  expect(s.saveBuffer().name).toBe("y.yaml");
  expect(s.files["y.yaml"]).toBe("z: 2\n");
  s.setBuffer("z: 3\n");
  s.exitEditor(true);
  expect(s.files["y.yaml"]).toBe("z: 3\n");
  expect(s.files["x.yaml"]).toBeUndefined();
});

test("applying the buffer in nano or vi does not write the file; plain apply still does", () => {
  const s = store();
  const yaml = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ns-a\n";
  s.exec("nano x.yaml");
  s.setBuffer(yaml);
  expect(s.apply(yaml, undefined, false)?.ok).toBe(true);
  expect(s.files["x.yaml"]).toBeUndefined();
  expect(s.cluster!.get("Namespace", undefined, "ns-a")).toBeTruthy();
  s.openFile("p.yaml");
  s.apply(yaml.replace("ns-a", "ns-b"));
  expect(s.files["p.yaml"]).toContain("ns-b");
});

test("Start over resets the mode", () => {
  const s = store();
  s.exec("nano x.yaml");
  expect(s.editorMode).toBe("nano");
  s.reset();
  expect(s.editorMode).toBe(null);
});

test("lines are counted as nano and vim count them", () => {
  expect([lineCount(""), lineCount("a"), lineCount("a\n"), lineCount("a\nb"), lineCount("a\n\n")]).toEqual([0, 1, 1, 2, 2]);
});

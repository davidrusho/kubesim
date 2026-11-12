import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Splitter } from "./Splitter";
import { DOCK_SPLIT, FONT_DEFAULT, FONT_MAX, FONT_MIN, SIDE_SPLIT, clampFont, clampShare, loadFont, loadShare, parseShare, saveFont, saveShare } from "./split";

const fake = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("clamping a splitter", () => {
  test("the side column keeps at least 420px and the Cluster View at least 320px", () => {
    const total = 1400;
    expect(clampShare(0.1, total, SIDE_SPLIT.min1, SIDE_SPLIT.min2)).toBeCloseTo(420 / total, 5);
    expect(clampShare(0.95, total, SIDE_SPLIT.min1, SIDE_SPLIT.min2)).toBeCloseTo(1 - 320 / total, 5);
    expect(clampShare(0.5, total, SIDE_SPLIT.min1, SIDE_SPLIT.min2)).toBe(0.5);
  });
  test("when both minimums cannot fit, the split is even", () => {
    expect(clampShare(0.8, 600, SIDE_SPLIT.min1, SIDE_SPLIT.min2)).toBe(0.5);
  });
  test("the terminal keeps room too", () => {
    expect(clampShare(0.05, 800, DOCK_SPLIT.min1, DOCK_SPLIT.min2)).toBeCloseTo(DOCK_SPLIT.min2 / 800, 5);
  });
});

describe("persisting a splitter", () => {
  test("a saved share is read back; nothing, junk or an out-of-range value gives the default", () => {
    const s = fake();
    expect(loadShare(SIDE_SPLIT, s)).toBe(0.5);
    saveShare(SIDE_SPLIT, 0.62, s);
    expect(loadShare(SIDE_SPLIT, s)).toBe(0.62);
    for (const junk of ["abc", "", "NaN", "0", "1.5", "-2"]) expect(parseShare(junk, 0.5), junk).toBe(0.5);
  });
  test("storage that throws, or is missing, never breaks anything", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadShare(DOCK_SPLIT, broken)).toBe(0.6);
    expect(() => saveShare(DOCK_SPLIT, 0.7, broken)).not.toThrow();
    expect(loadShare(DOCK_SPLIT, null)).toBe(0.6);
  });
  test("the terminal's text size is kept between 11 and 16px and defaults to the current 12px", () => {
    const s = fake();
    expect(loadFont(s)).toBe(FONT_DEFAULT);
    expect(FONT_DEFAULT).toBe(12);
    saveFont(14, s);
    expect(loadFont(s)).toBe(14);
    expect(clampFont(3)).toBe(FONT_MIN);
    expect(clampFont(99)).toBe(FONT_MAX);
    s.m.set("kubesim.terminal.font.v1", "40");
    expect(loadFont(s)).toBe(FONT_DEFAULT);
  });
});

describe("the splitter itself", () => {
  const render = (orientation: "vertical" | "horizontal") => renderToStaticMarkup(createElement(Splitter, { orientation, label: "Resize", share: 0.5, total: 1000, onChange: () => {}, onCommit: () => {}, onReset: () => {} }));
  test("is a focusable separator with its orientation and value", () => {
    const v = render("vertical");
    expect(v).toContain('role="separator"');
    expect(v).toContain('aria-orientation="vertical"');
    expect(v).toContain('aria-valuenow="50"');
    expect(v).toContain('tabindex="0"');
    expect(render("horizontal")).toContain('aria-orientation="horizontal"');
  });
});

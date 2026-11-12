import { expect, test } from "bun:test";
import { hintTotal, loadUsage, usageSummary } from "./challengeUsage";

test("usage is summarised the way the debrief says it", () => {
  expect(usageSummary({ hints: {}, fixes: [] })).toBe("with no hints");
  expect(usageSummary({ hints: { 0: 1 }, fixes: [] })).toBe("with 1 hint");
  expect(usageSummary({ hints: { 0: 2, 1: 1 }, fixes: [] })).toBe("with 3 hints");
  expect(usageSummary({ hints: { 0: 2 }, fixes: [0] })).toBe("after peeking at the fix");
  expect(hintTotal({ hints: { 0: 2, 2: 3 }, fixes: [] })).toBe(5);
});

test("reading usage without browser storage gives an empty record, not an error", () => {
  expect(loadUsage("anything")).toEqual({ hints: {}, fixes: [] });
});

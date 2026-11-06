import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spinner, withSpinner } from "../src/ui/spinner.js";
import { setTerminalOverride } from "../src/ui/text.js";

let writes: string[];

beforeEach(() => {
  vi.useFakeTimers();
  writes = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s) => writes.push(String(s)) > 0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setTerminalOverride(null);
});

test("non-TTY stderr: no writes, withSpinner still returns the value", async () => {
  setTerminalOverride(false);
  const s = spinner("x", true);
  s.update("y");
  vi.advanceTimersByTime(500);
  s.stop();
  expect(await withSpinner("x", true, async () => 7)).toBe(7);
  expect(writes).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test("TTY stderr: animates frames, updates message, clears on stop", () => {
  setTerminalOverride(true);
  const s = spinner("loading", true);
  expect(writes[0]).toBe("\r⠋ loading");
  vi.advanceTimersByTime(80);
  expect(writes.at(-1)).toBe("\r⠙ loading");
  s.update("more");
  vi.advanceTimersByTime(80);
  expect(writes.at(-1)).toBe("\r⠹ more");
  s.stop();
  expect(writes.at(-1)).toBe("\r\x1b[2K");
  const n = writes.length;
  s.stop();
  vi.advanceTimersByTime(500);
  expect(writes).toHaveLength(n);
  expect(vi.getTimerCount()).toBe(0);
});

test("withSpinner stops the spinner and rethrows when fn rejects", async () => {
  setTerminalOverride(true);
  await expect(
    withSpinner("x", true, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(writes.at(-1)).toBe("\r\x1b[2K");
  expect(vi.getTimerCount()).toBe(0);
});

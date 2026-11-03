import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spinner, withSpinner } from "../src/ui/spinner.js";

function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  const stream = {
    isTTY,
    write: (s: string) => writes.push(s) > 0,
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("non-TTY stream: no writes, withSpinner still returns the value", async () => {
  const { stream, writes } = fakeStream(false);
  const s = spinner("x", { enabled: true, stream });
  s.update("y");
  vi.advanceTimersByTime(500);
  s.stop();
  expect(await withSpinner("x", { enabled: true, stream }, async () => 7)).toBe(7);
  expect(writes).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test("disabled: no writes and no timer", () => {
  const { stream, writes } = fakeStream(true);
  spinner("x", { enabled: false, stream }).stop();
  expect(writes).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test("TTY stream: animates frames, updates message, clears on stop", () => {
  const { stream, writes } = fakeStream(true);
  const s = spinner("loading", { enabled: true, stream });
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
  const { stream, writes } = fakeStream(true);
  await expect(
    withSpinner("x", { enabled: true, stream }, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(writes.at(-1)).toBe("\r\x1b[2K");
  expect(vi.getTimerCount()).toBe(0);
});

import { afterEach, expect, test, vi } from "vitest";
import {
  plain,
  renderMarkdown,
  safeLink,
  sanitizeControl,
  setTerminalOverride,
} from "../src/ui/text.js";

const fakeStream = (isTTY: boolean) => ({ isTTY }) as unknown as NodeJS.WriteStream;

afterEach(() => {
  setTerminalOverride(null);
  vi.unstubAllEnvs();
});

test("sanitizeControl strips escapes but keeps tabs and newlines", () => {
  expect(sanitizeControl("a\x1b[2Jb\tc")).toBe("a[2Jb\tc");
  expect(sanitizeControl("30:32.03\x1b[31m passage")).toBe("30:32.03[31m passage");
  expect(sanitizeControl("a\x9bb\nc")).toBe("ab\nc");
  expect(sanitizeControl(42)).toBe("42");
});

test("plain collapses whitespace-only blank lines", () => {
  expect(plain("a\n \n\t\n\nb")).toBe("a\n\nb");
});

test("plain keeps the indentation of the line after a blank run", () => {
  expect(plain("a\n\n\n  b")).toBe("a\n\n  b");
  expect(plain("a\n  \n\t\n    b")).toBe("a\n\n    b");
});

test("plain is linear on long space runs", () => {
  const start = performance.now();
  plain(`${" ".repeat(100_000)}x`);
  expect(performance.now() - start).toBeLessThan(50);
});

test("safeLink only links http(s) on a terminal", () => {
  expect(safeLink("javascript:alert(1)")).not.toContain("\x1b]8");
  expect(safeLink("https://x.io", "x", { stream: fakeStream(true) })).toBe(
    "\x1b]8;;https://x.io\x1b\\x\x1b]8;;\x1b\\",
  );
  expect(safeLink("https://x.io", "x", { stream: fakeStream(false) })).toBe("x");
  expect(safeLink("javascript:alert(1)", "x", { stream: fakeStream(true) })).toBe("x");
});

test("renderMarkdown strips escape bytes from untrusted markdown", async () => {
  const out = await renderMarkdown("# Hi\x1b]0;pwned\x07 there\n\nbody\x9b2J");
  expect(out).not.toContain("\x1b]0");
  expect(out).not.toContain("\x07");
  expect(out).not.toContain("\x9b");
});

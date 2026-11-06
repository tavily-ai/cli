import { afterEach, expect, test, vi } from "vitest";
import {
  domainOf,
  plain,
  renderMarkdown,
  safeLink,
  sanitizeControl,
  setTerminalOverride,
  snippet,
  table,
  tree,
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

test("plain collapses blank-line runs and trims", () => {
  expect(plain("a\n\n\n\nb")).toBe("a\n\nb");
  expect(plain("  a\n\nb \n")).toBe("a\n\nb");
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

test("snippet collapses whitespace and truncates", () => {
  const s = snippet(`Personal bests\n\n10,000m${" passage".repeat(120)}`, 600);
  expect(s).not.toContain("\n");
  expect(s).toHaveLength(603);
  expect(s.endsWith("...")).toBe(true);
  expect(snippet("x y", 0)).toBe("x y");
  expect(snippet("x   y", 10)).toBe("x y");
});

test("safeLink only links http(s) on a terminal", () => {
  expect(safeLink("javascript:alert(1)")).not.toContain("\x1b]8");
  expect(safeLink("https://x.io", "x", { stream: fakeStream(true) })).toBe(
    "\x1b]8;;https://x.io\x1b\\x\x1b]8;;\x1b\\",
  );
  expect(safeLink("https://x.io", "x", { stream: fakeStream(false) })).toBe("x");
  expect(safeLink("javascript:alert(1)", "x", { stream: fakeStream(true) })).toBe("x");
});

test("safeLink strips escape bytes from the target", () => {
  const out = safeLink("https://x.io/\x1b]8;;evil", "x", { stream: fakeStream(true) });
  expect(out).toBe("\x1b]8;;https://x.io/]8;;evil\x1b\\x\x1b]8;;\x1b\\");
});

test("terminal override wins over isTTY", () => {
  setTerminalOverride(true);
  expect(safeLink("https://x.io", "x")).toContain("\x1b]8;;https://x.io");
  setTerminalOverride(false);
  expect(safeLink("https://x.io", "x", { stream: fakeStream(true) })).toBe("x");
});

test("domainOf", () => {
  expect(domainOf("https://www.example.com/a?b=1")).toBe("www.example.com");
  expect(domainOf("not a url")).toBe("");
});

test("tree renders branches and nested children", () => {
  expect(
    tree("root", [
      { label: "a", children: ["a1", "a2"] },
      { label: "b", children: ["b1"] },
    ]),
  ).toBe(["root", "├── a", "│   ├── a1", "│   └── a2", "└── b", "    └── b1"].join("\n"));
});

test("table pads columns and draws a rule", () => {
  expect(
    table(
      ["Name", "N"],
      [
        ["alpha", "1"],
        ["b", "22"],
      ],
    ),
  ).toBe(["Name  N ", "───── ──", "alpha 1 ", "b     22"].join("\n"));
});

test("renderMarkdown renders headings bold and keeps link URLs", async () => {
  // chalk (inside marked-terminal) decides color support at first import, and there is no TTY here
  vi.stubEnv("FORCE_COLOR", "1");
  const out = await renderMarkdown("# Heading\n\n[site](https://example.com/page)");
  expect(out).toContain("Heading");
  expect(out).toContain("\x1b[1m");
  expect(out).toContain("https://example.com/page");
});

test("renderMarkdown strips escape bytes from untrusted markdown", async () => {
  const out = await renderMarkdown("# Hi\x1b]0;pwned\x07 there\n\nbody\x9b2J");
  expect(out).not.toContain("\x1b]0");
  expect(out).not.toContain("\x07");
  expect(out).not.toContain("\x9b");
});

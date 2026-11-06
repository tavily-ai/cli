import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { echoPages, emit, footer } from "../src/ui/render/emit.js";
import { printExtractResults } from "../src/ui/render/extract.js";
import { printMultiSearchResults, printSearchResults } from "../src/ui/render/search.js";
import { spinner, withSpinner } from "../src/ui/spinner.js";
import {
  plain,
  renderMarkdown,
  safeLink,
  sanitizeControl,
  setTerminalOverride,
} from "../src/ui/text.js";
import { captureOutput, visible } from "./helpers/capture.js";

const io = captureOutput();

const LONG_URL = `https://www.example.com/fb-answers/systems-analysis-symposium-2021-nasa?locale=ur_PK&ref=${"a".repeat(80)}`;
const PAGE = `# Title\n\nSee [the report](https://example.com/report-2021.pdf) for **details**.\n\n\n\n| Year | Value |\n|---|---|\n| 2021 | 30:32.03 |\n${"x".repeat(4000)}`;

const tmp = () => mkdtempSync(join(tmpdir(), "tvly-render-"));

// test_output.py::test_piped_search_prints_full_urls_and_snippets
test("piped search prints full URLs and snippets", async () => {
  setTerminalOverride(false);
  const content = `Personal bests\n\n10,000m 30:32.03\x1b[31m${" passage".repeat(120)}`;
  await printSearchResults(
    {
      answer: "She ran 30:32.03.",
      results: [{ title: "Tegla", url: LONG_URL, content, score: 0.9 }],
    },
    { json: false },
  );
  const lines = io.stdout().split("\n");
  expect(lines[0]).toBe("Answer: She ran 30:32.03.");
  expect(lines[1]).toBe("");
  expect(lines.slice(2, 4)).toEqual(["1. Tegla", LONG_URL]);
  expect(lines[4]?.startsWith("Personal bests 10,000m 30:32.03[31m passage")).toBe(true);
  expect(lines[4]).toHaveLength(603);
  expect(lines[4]?.endsWith("...")).toBe(true);
});

test("piped search: untitled results, no results, images, and maxChars 0", async () => {
  setTerminalOverride(false);
  await printSearchResults(
    { results: [{ url: "https://a.example", content: "word ".repeat(200) }] },
    { json: false, maxChars: 0 },
  );
  const lines = io.stdout().split("\n");
  expect(lines[0]).toBe("1. Untitled");
  expect(lines[2]).toBe("word ".repeat(200).trim());
  await printSearchResults(
    {
      results: [],
      images: [
        "https://i.example/1.png",
        { url: "https://i.example/2.png" },
        { description: "no url" },
      ],
    },
    { json: false },
  );
  expect(io.stdout()).toContain(
    'No results found.\nImage: https://i.example/1.png\nImage: https://i.example/2.png\nImage: {"description":"no url"}\n',
  );
});

// test_output.py::test_piped_extract_keeps_markdown_links_and_whole_page
test("piped extract keeps markdown links and the whole page", async () => {
  setTerminalOverride(false);
  await printExtractResults(
    {
      results: [{ url: "https://x.example/p", raw_content: PAGE }],
      failed_results: [{ url: "https://y.example", error: "timeout" }],
    },
    { json: false },
  );
  const out = io.stdout();
  expect(
    out.startsWith(
      "# https://x.example/p\n\n# Title\n\nSee [the report](https://example.com/report-2021.pdf)",
    ),
  ).toBe(true);
  expect(out).toContain("x".repeat(4000));
  expect(out.endsWith("Failed: https://y.example: timeout\n")).toBe(true);
});

test("echoPages writes # <url> blocks and (no content) for empty pages", () => {
  echoPages([{ url: "https://a.example/1", raw_content: "body" }, { url: "https://a.example/2" }]);
  expect(io.stdout()).toBe(
    "# https://a.example/1\n\nbody\n\n# https://a.example/2\n\n(no content)\n\n",
  );
});

// test_output.py::test_terminal_search_shows_full_url_on_one_line
test("terminal search shows the full URL on one line", async () => {
  setTerminalOverride(true);
  await printSearchResults(
    { results: [{ title: "T", url: LONG_URL, content: "c", score: 0.5 }] },
    { json: false },
  );
  const lines = visible(io.stdout()).split("\n");
  expect(lines[0]).toBe("1. T   score: 0.50");
  expect(lines[1]).toContain(LONG_URL);
  expect(lines[2]).toBe("   c");
  expect(visible(io.stdout())).toMatch(/─ 1 results ─/);
});

test("terminal search strips escape bytes from untrusted fields", async () => {
  setTerminalOverride(true);
  await printSearchResults(
    {
      answer: "ans\x1b[2Jwer",
      results: [{ title: "T\x1b]8;;evil\x07x", url: "https://a.example", content: "c\x1b[31m" }],
      images: ["https://i.example/\x1bimg"],
    },
    { json: false },
  );
  const text = visible(io.stdout());
  expect(text).not.toContain("\x1b");
  expect(text).toContain("Answer");
  expect(text).toContain("Images (1):");
});

test("terminal search with no results says so", async () => {
  setTerminalOverride(true);
  await printSearchResults({ results: [] }, { json: false });
  expect(visible(io.stdout())).toBe("No results found.\n");
});

test("terminal extract shows the first 3000 characters and the failures", async () => {
  setTerminalOverride(true);
  await printExtractResults(
    {
      results: [{ url: "https://x.example/p", raw_content: `${"y".repeat(5000)}` }],
      failed_results: [{ url: "https://z.example", error: "timeout" }],
      response_time: 1.5,
    },
    { json: false },
  );
  const text = visible(io.stdout());
  expect(text).toContain("  https://x.example/p\n  x.example (5,000 chars)");
  expect(text.match(/y/g)?.length).toBe(3000);
  expect(text).toContain("Failed extractions:\n  x https://z.example: timeout");
  expect(text).toMatch(/1 extracted, 1 failed \| 1\.50s/);
});

test("emit leaves an existing .tavily folder alone and creates other folders without .gitignore", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".tavily"));
  emit({}, { outputFile: join(dir, ".tavily", "a.json"), pretty: false });
  expect(existsSync(join(dir, ".tavily", ".gitignore"))).toBe(false);
  emit({}, { outputFile: join(dir, "out", "nested", "b.json"), pretty: false });
  expect(readFileSync(join(dir, "out", "nested", "b.json"), "utf8")).toBe("{}\n");
  expect(existsSync(join(dir, "out", "nested", ".gitignore"))).toBe(false);
});

test("emit without a file writes compact JSON with non-ASCII intact", () => {
  emit({ q: "café" }, { pretty: false });
  expect(io.stdout()).toBe('{"q":"café"}\n');
});

test("multi-search plain output: headers, results, and per-query errors", async () => {
  setTerminalOverride(false);
  await printMultiSearchResults(
    [
      { query: "one", results: [{ title: "T one", url: "https://a.example/one", content: "c" }] },
      { query: "two", error: "boom" },
      { query: "three", error: { code: "daily", message: "capped" } },
    ],
    { json: false, maxChars: 300 },
  );
  expect(io.stdout()).toBe(
    "=== [1/3] one\n1. T one\nhttps://a.example/one\nc\n\n=== [2/3] two\nerror: boom\n\n=== [3/3] three\nerror: capped\n\n",
  );
});

test("footer spans the terminal width, 80 columns when unknown", () => {
  const columns = process.stdout.columns;
  try {
    process.stdout.columns = undefined as unknown as number;
    footer(1, "URLs");
    process.stdout.columns = 120;
    footer(1, "URLs");
  } finally {
    process.stdout.columns = columns;
  }
  const rules = visible(io.stdout()).split("\n").filter(Boolean);
  expect(rules.map((r) => r.length)).toEqual([80, 120]);
});

describe("text helpers", () => {
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
});

describe("spinner", () => {
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
});

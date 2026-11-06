import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import { afterEach, expect, test, vi } from "vitest";
import type { Json } from "../src/core/tavily-client.js";
import { setTerminalOverride } from "../src/ui/text.js";
import { captureOutput } from "./helpers/capture.js";
import { runProgram, stubClient } from "./helpers/program.js";
import { runCli } from "./helpers/run-cli.js";

const io = captureOutput();
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8"),
) as Json;

const capError = () =>
  new TavilyKeylessLimitError({
    message: "Keyless limit reached",
    capType: "keyless_cap",
    retryAfter: 60,
    bonusEligible: false,
    continuationPaths: [{ type: "signup", url: "https://tavily.com/signup" }],
  });

/** Port of test_output.py's FakeClient: one result titled `T <query>`. */
function fakeClient() {
  const search = vi.fn(async (body: Json) => ({
    query: body.query,
    results: [{ title: `T ${body.query}`, url: `https://a.example/${body.query}`, content: "c" }],
  }));
  return { search, client: stubClient({ search }) };
}

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

test("search --json posts only the query and prints the response pretty-printed", async () => {
  const search = vi.fn(async () => fixture);
  expect(await runProgram(["search", "q", "--json"], stubClient({ search }))).toBe(0);
  expect(search).toHaveBeenCalledWith({ query: "q" });
  expect(io.stdout()).toBe(`${JSON.stringify(fixture, null, 2)}\n`);
});

test("generated flags reach the request body in snake_case", async () => {
  const search = vi.fn(async () => fixture);
  await runProgram(
    [
      "search",
      "q",
      "--json",
      "--depth",
      "fast",
      "--max-results",
      "3",
      "--include-answer",
      "--include-domains",
      "a.com, b.com",
      "--safe-search",
      "--chunks-per-source",
      "2",
    ],
    stubClient({ search }),
  );
  expect(search).toHaveBeenCalledWith({
    query: "q",
    search_depth: "fast",
    max_results: 3,
    include_answer: "basic",
    include_domains: ["a.com", "b.com"],
    safe_search: true,
    chunks_per_source: 2,
  });
});

test("a keyless cap hit exits 3 with the JSON envelope", async () => {
  const client = stubClient({
    search: async () => {
      throw capError();
    },
  });
  expect(await runProgram(["search", "q", "--json"], client)).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual({
    error: {
      code: "keyless_cap",
      message: "Keyless limit reached",
      window: null,
      retry_after_seconds: 60,
      next_actions: [{ type: "signup", url: "https://tavily.com/signup" }],
    },
  });
});

test("an API error exits 4", async () => {
  const client = stubClient({
    search: async () => {
      throw new Error("boom");
    },
  });
  expect(await runProgram(["search", "q", "--json"], client)).toBe(4);
  expect(JSON.parse(io.stdout())).toEqual({ error: "boom" });
});

test("usage errors exit 2", async () => {
  const { client } = fakeClient();
  expect(await runProgram(["search"], client)).toBe(2);
  expect(io.stderr()).toContain(
    "QUERY is required. Pass a query string or use '-' to read from stdin.",
  );
  expect(await runProgram(["search", "  ", ""], client)).toBe(2);
  expect(await runProgram(["search", "a", "b", "c", "d", "e", "f"], client)).toBe(2);
  expect(io.stderr()).toContain("At most 5 queries per command, got 6.");
  expect(await runProgram(["search", "q", "--bogus"], client)).toBe(2);
  expect(await runProgram(["search", "q", "--max-results", "21"], client)).toBe(2);
  expect(io.stderr()).toContain("maximum 20");
  expect(await runProgram(["search", "q", "--depth", "deep"], client)).toBe(2);
  expect(io.stderr()).toContain("Allowed choices");
  expect(await runProgram(["search", "q", "--max-chars", "-1"], client)).toBe(2);
});

test("- reads one query from stdin", async () => {
  const { search, client } = fakeClient();
  setTerminalOverride(false);
  await runProgram(["search", "-"], client, { stdin: "  from stdin \n" });
  expect(search).toHaveBeenCalledWith({ query: "from stdin" });
  expect(await runProgram(["search", "-"], client, { stdin: " \n" })).toBe(2);
});

test("--max-chars defaults to 600 shared across queries and can be set", async () => {
  setTerminalOverride(false);
  const long = "w ".repeat(1000);
  const client = stubClient({
    search: async (body) => ({
      query: body.query,
      results: [{ title: "t", url: "u", content: long }],
    }),
  });
  await runProgram(["search", "q"], client);
  expect(io.stdout().split("\n")[2]).toHaveLength(603);
  await runProgram(["search", "q", "--max-chars", "10"], client);
  expect(io.stdout()).toContain("\nw w w w w ...\n");
});

// test_output.py::test_multi_query_runs_each_with_shared_options
test("multi-query runs each query with the shared options", async () => {
  setTerminalOverride(false);
  const { search, client } = fakeClient();
  expect(await runProgram(["search", "one", "two", "--depth", "advanced"], client)).toBe(0);
  expect(search.mock.calls.map(([b]) => b.query).sort()).toEqual(["one", "two"]);
  for (const [body] of search.mock.calls) expect(body.search_depth).toBe("advanced");
  const lines = io.stdout().split("\n");
  expect(lines[0]).toBe("=== [1/2] one");
  expect(lines[1]).toBe("1. T one");
  expect(lines).toContain("=== [2/2] two");
});

// test_output.py::test_multi_query_keeps_keyless_cap_details
test("multi-query keeps keyless cap details", async () => {
  const client = stubClient({
    search: async (body) => {
      if (body.query === "capped") throw capError();
      return { query: body.query, results: [] };
    },
  });
  expect(await runProgram(["search", "ok", "capped", "--json"], client)).toBe(0);
  const list = JSON.parse(io.stdout()) as Array<{ query: string; error?: Json }>;
  expect(list).toHaveLength(2);
  expect(list[0]).toEqual({ query: "ok", results: [] });
  expect(list[1]?.query).toBe("capped");
  expect(list[1]?.error?.code).toBe("keyless_cap");
  expect(list[1]?.error?.retry_after_seconds).toBe(60);
  expect(list[1]?.error?.next_actions).toEqual([
    { type: "signup", url: "https://tavily.com/signup" },
  ]);
});

test("multi-query where every query hits the cap exits 3 and mentions tvly login", async () => {
  setTerminalOverride(false);
  const client = stubClient({
    search: async () => {
      throw capError();
    },
  });
  expect(await runProgram(["search", "capped", "capped"], client)).toBe(3);
  expect(io.stdout() + io.stderr()).toContain("tvly login");
});

test("multi-query where every query hits a plan limit (432) exits 3", async () => {
  const client = stubClient({
    search: async () => {
      throw new TavilyRequestError({ status: 432, body: null, message: "Plan limit exceeded" });
    },
  });
  expect(await runProgram(["search", "a", "b", "--json"], client)).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual([
    { query: "a", error: "Plan limit exceeded" },
    { query: "b", error: "Plan limit exceeded" },
  ]);
});

test("multi-query where every query fails otherwise exits 4", async () => {
  const client = stubClient({
    search: async () => {
      throw new Error("boom");
    },
  });
  expect(await runProgram(["search", "a", "b", "--json"], client)).toBe(4);
  expect(JSON.parse(io.stdout())).toEqual([
    { query: "a", error: "boom" },
    { query: "b", error: "boom" },
  ]);
});

// test_output.py::test_bare_output_saves_under_tavily_folder
test("bare -o saves under .tavily and still prints when piped", async () => {
  setTerminalOverride(false);
  const dir = mkdtempSync(join(tmpdir(), "tvly-search-"));
  process.chdir(dir);
  const { client } = fakeClient();
  expect(await runProgram(["search", "Rust 2024 edition", "-o"], client)).toBe(0);
  const saved = readdirSync(join(dir, ".tavily")).filter((f) =>
    /^search-rust-2024-edition-.*\.json$/.test(f),
  );
  expect(saved).toHaveLength(1);
  const body = JSON.parse(readFileSync(join(dir, ".tavily", saved[0] ?? ""), "utf8"));
  expect(body.results.length).toBeGreaterThan(0);
  expect(readFileSync(join(dir, ".tavily", ".gitignore"), "utf8")).toBe("*\n");
  expect(io.stdout()).toContain("1. T Rust 2024 edition");
});

test("-o at a terminal only saves", async () => {
  setTerminalOverride(true);
  const dir = mkdtempSync(join(tmpdir(), "tvly-search-"));
  process.chdir(dir);
  const { client } = fakeClient();
  await runProgram(["search", "q", "-o", "out.json"], client);
  expect(io.stdout()).toBe("");
  expect(io.stderr()).toContain("Output saved to out.json");
  expect(existsSync(join(dir, "out.json"))).toBe(true);
  expect(existsSync(join(dir, ".tavily"))).toBe(false);
});

test("human mode writes no spinner frames to stdout", async () => {
  setTerminalOverride(true);
  const client = stubClient({
    search: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return fixture;
    },
  });
  expect(await runProgram(["search", "q"], client)).toBe(0);
  expect(io.stdout()).toContain("Rust 2024 edition");
  expect(io.stdout()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  expect(io.stderr()).toContain("Searching...");
});

test("JSON mode shows no spinner", async () => {
  setTerminalOverride(true);
  await runProgram(["search", "q", "--json"], stubClient({ search: async () => fixture }));
  expect(io.stderr()).toBe("");
});

test("dist/cli.js search --help lists the flags in order", async () => {
  vi.restoreAllMocks();
  const { stdout, code } = await runCli(["search", "--help"]);
  expect(code).toBe(0);
  const flags = [...stdout.matchAll(/^ {2}(?:-\w, )?(--[a-z-]+)/gm)].map((m) => m[1]);
  expect(flags).toEqual([
    "--depth",
    "--max-results",
    "--topic",
    "--time-range",
    "--start-date",
    "--end-date",
    "--include-domains",
    "--exclude-domains",
    "--country",
    "--include-answer",
    "--include-raw-content",
    "--include-images",
    "--include-image-descriptions",
    "--chunks-per-source",
    "--auto-parameters",
    "--cache-fallback",
    "--days",
    "--exact-match",
    "--fetch-timeout",
    "--filter-by-language",
    "--filter-by-published-date",
    "--include-domains-mode",
    "--include-favicon",
    "--include-published-date",
    "--include-usage",
    "--language",
    "--max-age-hours",
    "--safe-search",
    "--max-chars",
    "--output",
    "--client-name",
    "--help",
    // Global Options
    "--version",
    "--status",
    "--json",
  ]);
  expect(stdout).toContain("ultra-fast");
  const viaHelp = await runCli(["help", "search"]);
  expect(viaHelp.code).toBe(0);
  expect(viaHelp.stdout).toBe(stdout);
});

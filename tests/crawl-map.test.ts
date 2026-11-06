import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Json } from "../src/core/tavily-client.js";
import { setTerminalOverride } from "../src/ui/text.js";
import { captureOutput, visible } from "./helpers/capture.js";
import { clientFactory, runProgram, stubClient } from "./helpers/program.js";

const io = captureOutput();
const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Json;
const crawlFixture = load("crawl");
const mapFixture = load("map");
const tmp = () => mkdtempSync(join(tmpdir(), "tvly-crawl-map-"));

afterEach(() => vi.unstubAllEnvs());

test.each([
  ["crawl", "https://a.example"],
  ["map", "https://a.example"],
  ["research", "q"],
])("%s without a key exits 3 with only the requires-a-key message", async (cmd, arg) => {
  const home = tmp();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TAVILY_API_KEY", "");
  const actual = await vi.importActual<typeof import("../src/core/client-factory.js")>(
    "../src/core/client-factory.js",
  );
  clientFactory.getKeyedClient.mockImplementationOnce(actual.getKeyedClient);
  const code = await runProgram([cmd, arg], stubClient({}));
  expect(code).toBe(3);
  expect(io.stdout()).toBe("");
  const stderr = visible(io.stderr());
  expect(stderr).toContain(`The ${cmd} command requires a Tavily API key.`);
  expect(stderr).not.toContain("No Tavily API key found");
});

test("--no-external sends false, --allow-external sends true, omission sends nothing", async () => {
  const map = vi.fn(async () => mapFixture);
  const client = stubClient({ map });
  await runProgram(["map", "https://a.example", "--json", "--no-external"], client);
  await runProgram(["map", "https://a.example", "--json", "--allow-external"], client);
  await runProgram(["map", "https://a.example", "--json"], client);
  expect(map.mock.calls).toEqual([
    [{ url: "https://a.example", allow_external: false }],
    [{ url: "https://a.example", allow_external: true }],
    [{ url: "https://a.example" }],
  ]);
});

test("every crawl option reaches the request body", async () => {
  const crawl = vi.fn(async () => crawlFixture);
  await runProgram(
    [
      "crawl",
      "https://a.example",
      "--json",
      "--max-depth",
      "2",
      "--max-breadth",
      "5",
      "--limit",
      "9",
      "--instructions",
      "docs",
      "--chunks-per-source",
      "3",
      "--extract-depth",
      "advanced",
      "--format",
      "text",
      "--select-paths",
      "/docs, /api",
      "--exclude-paths",
      "/old",
      "--select-domains",
      "a\\.example",
      "--exclude-domains",
      "b\\.example",
      "--include-images",
      "--timeout",
      "30.5",
    ],
    stubClient({ crawl }),
  );
  expect(crawl).toHaveBeenCalledWith({
    url: "https://a.example",
    max_depth: 2,
    max_breadth: 5,
    limit: 9,
    instructions: "docs",
    chunks_per_source: 3,
    extract_depth: "advanced",
    format: "text",
    select_paths: ["/docs", "/api"],
    exclude_paths: ["/old"],
    select_domains: ["a\\.example"],
    exclude_domains: ["b\\.example"],
    include_images: true,
    timeout: 30.5,
  });
});

test("crawl --output-dir writes one file per page with content and reports on stderr", async () => {
  const dir = join(tmp(), "pages");
  const crawl = vi.fn(async () => crawlFixture);
  expect(
    await runProgram(["crawl", "https://a.example", "--output-dir", dir], stubClient({ crawl })),
  ).toBe(0);
  expect(readdirSync(dir).sort()).toEqual(["a.example.md", "a.example_docs_intro.md"]);
  expect(readFileSync(join(dir, "a.example.md"), "utf8")).toBe(
    "# https://a.example/\n\nHome page text\n",
  );
  // The empty-content page is skipped and not counted.
  expect(io.stderr()).toContain(`Saved 2 pages to ${dir}/`);
  expect(io.stdout()).toBe("");
});

test("crawl --output-dir still honours --json and -o", async () => {
  const base = tmp();
  const dir = join(base, "pages");
  const file = join(base, "crawl.json");
  const crawl = vi.fn(async () => crawlFixture);
  await runProgram(
    ["crawl", "https://a.example", "--output-dir", dir, "--json"],
    stubClient({ crawl }),
  );
  expect(JSON.parse(io.stdout())).toEqual(crawlFixture);
  expect(readdirSync(dir)).toHaveLength(2);

  await runProgram(
    ["crawl", "https://a.example", "--output-dir", dir, "-o", file],
    stubClient({ crawl }),
  );
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(crawlFixture);
});

test("crawl --output-dir gives colliding slugs distinct files", async () => {
  const dir = join(tmp(), "pages");
  const data = {
    results: [
      { url: "https://a.example/list?page=1", raw_content: "one" },
      { url: "https://a.example/list?page=2", raw_content: "two" },
      { url: "https://a.example/docs/a_b", raw_content: "three" },
      { url: "https://a.example/docs/a:b", raw_content: "four" },
      { url: "https://a.example/docs/a;b", raw_content: "five" },
    ],
  };
  await runProgram(
    ["crawl", "https://a.example", "--output-dir", dir],
    stubClient({ crawl: async () => data }),
  );
  expect(readdirSync(dir).sort()).toEqual([
    "a.example_docs_a_b-2.md",
    "a.example_docs_a_b-3.md",
    "a.example_docs_a_b.md",
    "a.example_list_page_1.md",
    "a.example_list_page_2.md",
  ]);
  expect(readFileSync(join(dir, "a.example_docs_a_b-3.md"), "utf8")).toContain("five");
  expect(io.stderr()).toContain(`Saved 5 pages to ${dir}/`);
});

test("terminal map output is a tree rooted at the base URL", async () => {
  setTerminalOverride(true);
  const map = vi.fn(async () => mapFixture);
  await runProgram(["map", "https://a.example"], stubClient({ map }));
  const text = visible(io.stdout());
  const lines = text.split("\n");
  expect(lines[0]).toBe("https://a.example");
  expect(lines[1]).toBe("├── https://a.example/1");
  expect(lines[2]).toBe("└── https://a.example/2");
  expect(text).toContain("2 URLs | 0.80s");
});

test("terminal crawl output is a tree of paths with char counts and a preview", async () => {
  setTerminalOverride(true);
  const crawl = vi.fn(async () => crawlFixture);
  await runProgram(["crawl", "https://a.example"], stubClient({ crawl }));
  const text = visible(io.stdout());
  expect(text.split("\n")[0]).toBe("https://a.example");
  expect(text).toContain("├── /docs/intro/  (27 chars)");
  expect(text).toContain("│   └── # Intro");
  expect(text).toContain("└── /empty  (0 chars)");
  expect(text).toContain("3 pages | 1.50s");
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const hostilePage = {
  url: "https://a.example/\x1b[31m[bold]red\x07",
  raw_content: "\x1b]0;title\x07[bold]body\x1b[2J",
};
const hostileBase = "https://a.example/\x1b]8;;evil\x07[bold]x";

test.each([false, true])(
  "crawl and map output carry no raw control bytes (terminal=%s)",
  async (terminal) => {
    setTerminalOverride(terminal);
    await runProgram(
      ["crawl", "https://a.example"],
      stubClient({ crawl: async () => ({ base_url: hostileBase, results: [hostilePage] }) }),
    );
    await runProgram(
      ["map", "https://a.example"],
      stubClient({ map: async () => ({ base_url: hostileBase, results: [hostilePage.url] }) }),
    );
    // Legitimate colour and hyperlink sequences are stripped first; anything left is attacker bytes.
    const text = terminal ? visible(io.stdout()) : io.stdout();
    expect(text).toContain("[bold]");
    expect(CONTROL.test(text)).toBe(false);
  },
);

test("crawl --output-dir keeps hostile URLs inside the target directory", async () => {
  const dir = join(tmp(), "pages");
  const data = {
    results: [
      { url: "../../x", raw_content: "one" },
      { url: "https://a.example/../../etc/passwd", raw_content: "two" },
    ],
  };
  await runProgram(
    ["crawl", "https://a.example", "--output-dir", dir],
    stubClient({ crawl: async () => data }),
  );
  const files = readdirSync(dir).sort();
  expect(files).toEqual([".._.._x.md", "a.example_etc_passwd.md"]);
  for (const f of files) expect(resolve(dir, f).startsWith(`${resolve(dir)}${sep}`)).toBe(true);
});

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TavilyKeylessLimitError } from "@tavily/core";
import { afterEach, expect, test, vi } from "vitest";
import type { Json } from "../src/core/tavily-client.js";
import { setTerminalOverride } from "../src/ui/text.js";
import { captureOutput } from "./helpers/capture.js";
import { runProgram, stubClient } from "./helpers/program.js";

const io = captureOutput();
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/extract.json", import.meta.url), "utf8"),
) as Json;

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

test("extract --json posts the URLs and prints the response pretty-printed", async () => {
  const extract = vi.fn(async () => fixture);
  expect(
    await runProgram(
      ["extract", "https://a.example", "https://b.example", "--json"],
      stubClient({ extract }),
    ),
  ).toBe(0);
  expect(extract).toHaveBeenCalledWith({ urls: ["https://a.example", "https://b.example"] });
  expect(io.stdout()).toBe(`${JSON.stringify(fixture, null, 2)}\n`);
});

test("every extract option reaches the request body", async () => {
  const extract = vi.fn(async () => fixture);
  await runProgram(
    [
      "extract",
      "https://a.example",
      "--json",
      "--query",
      "q",
      "--chunks-per-source",
      "2",
      "--extract-depth",
      "advanced",
      "--format",
      "text",
      "--include-images",
      "--timeout",
      "12.5",
    ],
    stubClient({ extract }),
  );
  expect(extract).toHaveBeenCalledWith({
    urls: ["https://a.example"],
    query: "q",
    chunks_per_source: 2,
    extract_depth: "advanced",
    format: "text",
    include_images: true,
    timeout: 12.5,
  });
});

test("more than 20 URLs exits 2", async () => {
  const extract = vi.fn(async () => fixture);
  const urls = Array.from({ length: 21 }, (_, i) => `https://u${i}.example`);
  expect(await runProgram(["extract", ...urls], stubClient({ extract }))).toBe(2);
  expect(io.stderr()).toContain("Maximum 20 URLs per request.");
  expect(extract).not.toHaveBeenCalled();
});

test("usage errors exit 2", async () => {
  const client = stubClient({ extract: async () => fixture });
  expect(await runProgram(["extract"], client)).toBe(2);
  expect(await runProgram(["extract", "https://a.example", "--format", "pdf"], client)).toBe(2);
  expect(await runProgram(["extract", "https://a.example", "--timeout", "soon"], client)).toBe(2);
  expect(await runProgram(["extract", "https://a.example", "--bogus"], client)).toBe(2);
});

test("a keyless cap hit exits 3 with the JSON envelope", async () => {
  const client = stubClient({
    extract: async () => {
      throw new TavilyKeylessLimitError({
        message: "capped",
        capType: "daily",
        retryAfter: 10,
        bonusEligible: false,
        continuationPaths: [],
      });
    },
  });
  expect(await runProgram(["extract", "https://a.example", "--json"], client)).toBe(3);
  expect(JSON.parse(io.stdout()).error.code).toBe("daily");
});

test("plain extract prints pages whole and the failures", async () => {
  setTerminalOverride(false);
  await runProgram(
    ["extract", "https://example.com/page"],
    stubClient({ extract: async () => fixture }),
  );
  expect(io.stdout()).toBe(
    "# https://example.com/page\n\n# Page\n\nSome [linked](https://example.com/other) text.\n\nFailed: https://broken.example: timeout\n",
  );
});

test("bare -o names the file after the first URL's host", async () => {
  setTerminalOverride(false);
  const dir = mkdtempSync(join(tmpdir(), "tvly-extract-"));
  process.chdir(dir);
  await runProgram(
    ["extract", "https://docs.example.com/x", "-o"],
    stubClient({ extract: async () => fixture }),
  );
  const saved = readdirSync(join(dir, ".tavily")).filter((f) => f.endsWith(".json"));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatch(/^extract-docs-example-com-/);
  expect(io.stdout()).toBe("");
});

test("human mode shows the extracting spinner on stderr only", async () => {
  setTerminalOverride(true);
  const client = stubClient({
    extract: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return fixture;
    },
  });
  await runProgram(["extract", "https://a.example", "https://b.example"], client);
  expect(io.stderr()).toContain("Extracting 2 URLs...");
  expect(io.stdout()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

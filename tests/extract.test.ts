import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Json } from "../src/core/tavily-client.js";
import { setTerminalOverride } from "../src/ui/text.js";
import { captureOutput } from "./helpers/capture.js";
import { clientHost, runProgram } from "./helpers/program.js";

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
      clientHost({ extract }),
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
    clientHost({ extract }),
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
  expect(await runProgram(["extract", ...urls], clientHost({ extract }))).toBe(2);
  expect(io.stderr()).toContain("Maximum 20 URLs per request.");
  expect(extract).not.toHaveBeenCalled();
});

test("usage errors exit 2", async () => {
  const client = clientHost({ extract: async () => fixture });
  expect(await runProgram(["extract"], client)).toBe(2);
  expect(await runProgram(["extract", "https://a.example", "--format", "pdf"], client)).toBe(2);
  expect(await runProgram(["extract", "https://a.example", "--timeout", "soon"], client)).toBe(2);
  expect(await runProgram(["extract", "https://a.example", "--bogus"], client)).toBe(2);
});

test("bare -o names the file after the first URL's host", async () => {
  setTerminalOverride(false);
  const dir = mkdtempSync(join(tmpdir(), "tvly-extract-"));
  process.chdir(dir);
  await runProgram(
    ["extract", "https://docs.example.com/x", "-o"],
    clientHost({ extract: async () => fixture }),
  );
  const saved = readdirSync(join(dir, ".tavily")).filter((f) => f.endsWith(".json"));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatch(/^extract-docs-example-com-/);
  expect(io.stdout()).toBe("");
});

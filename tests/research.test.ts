// First, so its client-factory mock is registered before research.js is imported below.
import "./helpers/program.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { sseDataLines } from "../src/core/sse.js";
import type { Json } from "../src/core/tavily-client.js";
import { setTerminalOverride } from "../src/ui/text.js";
import { captureOutput, visible } from "./helpers/capture.js";
import { runProgram, stubClient } from "./helpers/program.js";

const io = captureOutput();
const tmp = () => mkdtempSync(join(tmpdir(), "tvly-research-"));
const FIXTURE = readFileSync(new URL("./fixtures/research-stream.sse", import.meta.url), "utf8");
const COMPLETED = { status: "completed", content: "# Hi", sources: [] };

/** The fixture as the client yields it: one string per SSE `data:` payload. */
async function* fixtureChunks(): AsyncIterable<string> {
  yield FIXTURE;
}
const streamClient = (research = vi.fn()) =>
  stubClient({
    researchStream: async (body) => {
      research(body);
      return sseDataLines(fixtureChunks());
    },
  });

/** research() starts r1 as pending; getResearch() answers from `statuses` in turn, then repeats the last. */
function pendingClient(...statuses: Json[]) {
  const research = vi.fn(async (_body: Json) => ({ request_id: "r1", status: "pending" }));
  let i = 0;
  const getResearch = vi.fn(
    async (_id: string) => statuses[Math.min(i++, statuses.length - 1)] ?? {},
  );
  return { client: stubClient({ research, getResearch }), research, getResearch };
}

afterEach(() => {
  vi.useRealTimers();
});

test("bare `research` prints the group help and exits 0", async () => {
  expect(await runProgram(["research"], stubClient({}))).toBe(0);
  expect(io.stdout()).toContain("Usage: tvly research [options] [command]");
  expect(io.stdout()).toContain("tvly research status <id>");
});

test("research <query> polls until completed and prints the completed payload", async () => {
  vi.useFakeTimers();
  const { client, research, getResearch } = pendingClient({ status: "pending" }, COMPLETED);
  const done = runProgram(["research", "what is x", "--poll-interval", "0", "--json"], client);
  // --poll-interval 0 is clamped to 1 s between polls.
  await vi.advanceTimersByTimeAsync(999);
  expect(getResearch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await done).toBe(0);
  expect(research).toHaveBeenCalledWith({ input: "what is x" });
  expect(getResearch).toHaveBeenCalledTimes(2);
  expect(getResearch).toHaveBeenCalledWith("r1");
  expect(JSON.parse(io.stdout())).toEqual(COMPLETED);
});

test("--no-wait --json prints the request id and status", async () => {
  const { client, getResearch } = pendingClient();
  expect(await runProgram(["research", "q", "--no-wait", "--json"], client)).toBe(0);
  expect(io.stdout()).toBe('{"request_id":"r1","status":"pending"}\n');
  expect(getResearch).not.toHaveBeenCalled();
});

test("--timeout 0 --json emits the timeout payload", async () => {
  const { client, getResearch } = pendingClient();
  expect(await runProgram(["research", "q", "--timeout", "0", "--json"], client)).toBe(0);
  expect(io.stdout()).toBe('{"request_id":"r1","status":"timeout"}\n');
  expect(getResearch).not.toHaveBeenCalled();
});

test("human polling ticks every second, polls every poll_interval, and times out with a resume hint", async () => {
  vi.useFakeTimers();
  const { client, getResearch } = pendingClient({ status: "in_progress" });
  const done = runProgram(["research", "q", "--poll-interval", "3", "--timeout", "5"], client);
  await vi.advanceTimersByTimeAsync(2999);
  expect(getResearch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(getResearch).toHaveBeenCalledTimes(2);
  // Five 1 s ticks reach --timeout 5.
  await vi.advanceTimersByTimeAsync(2000);
  expect(await done).toBe(0);
  expect(getResearch).toHaveBeenCalledTimes(2);
  expect(visible(io.stderr())).toContain("Timed out after 5s. Resume with: tvly research poll r1");
  expect(io.stdout()).toBe("");
});

test("a first response that is already complete is printed without polling", async () => {
  setTerminalOverride(false);
  const research = vi.fn(async () => ({
    status: "completed",
    content: "See [source](https://s.example).",
    sources: [{ title: "S", url: "https://s.example" }],
  }));
  expect(await runProgram(["research", "q"], stubClient({ research }))).toBe(0);
  // test_output.py::test_piped_map_crawl_and_research (research half)
  expect(io.stdout()).toBe(
    "See [source](https://s.example).\n\nSources:\n1. S https://s.example\n",
  );
});

test("a response with neither a result nor a request id is an API error", async () => {
  const research = vi.fn(async () => ({ status: "pending" }));
  expect(await runProgram(["research", "q", "--json"], stubClient({ research }))).toBe(4);
  expect(JSON.parse(io.stdout()).error).toContain("Unexpected API response");
});

test("a non-completed result prints its status and error", async () => {
  setTerminalOverride(false);
  const research = vi.fn(async () => ({ status: "failed", error: "boom\x1b[2J" }));
  await runProgram(["research", "q"], stubClient({ research }));
  expect(io.stdout()).toBe("Status: failed\nError: boom[2J\n");
});

test("terminal report: heading, markdown, sources table, and footer", async () => {
  setTerminalOverride(true);
  const research = vi.fn(async () => ({
    status: "completed",
    content: "Body text",
    sources: [{ title: "Alpha", url: "https://a.example" }],
    response_time: 2.5,
  }));
  await runProgram(["research", "q"], stubClient({ research }));
  const text = visible(io.stdout());
  expect(text).toContain("Research Report");
  expect(text).toContain("Body text");
  expect(text).toMatch(/#\s+Title\s+URL/);
  expect(text).toMatch(/1\s+Alpha\s+https:\/\/a\.example/);
  expect(text).toContain("1 sources | 2.50s");
});

test("every run option reaches the request body; -o saves the result", async () => {
  const dir = tmp();
  const schemaFile = join(dir, "schema.json");
  writeFileSync(schemaFile, '{"type":"object"}');
  const out = join(dir, "r.json");
  const research = vi.fn(async (_body: Json) => COMPLETED);
  await runProgram(
    [
      "research",
      "run",
      "q",
      "--model",
      "pro",
      "--citation-format",
      "apa",
      "--output-schema",
      schemaFile,
      "-o",
      out,
    ],
    stubClient({ research }),
  );
  expect(research).toHaveBeenCalledWith({
    input: "q",
    model: "pro",
    citation_format: "apa",
    output_schema: { type: "object" },
  });
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(COMPLETED);
});

test("--output-schema that is missing or not JSON is a usage error", async () => {
  const research = vi.fn(async () => COMPLETED);
  const missing = join(tmp(), "nope.json");
  expect(
    await runProgram(["research", "q", "--output-schema", missing], stubClient({ research })),
  ).toBe(2);
  expect(io.stderr()).toContain("--output-schema must be a path to a JSON file:");
  const bad = join(tmp(), "bad.json");
  writeFileSync(bad, "{not json");
  expect(
    await runProgram(["research", "q", "--output-schema", bad], stubClient({ research })),
  ).toBe(2);
  expect(research).not.toHaveBeenCalled();
});

test("query from stdin; an empty query is a usage error", async () => {
  const research = vi.fn(async (_body: Json) => COMPLETED);
  await runProgram(["research", "-", "--json"], stubClient({ research }), {
    stdin: "  from stdin \n",
  });
  expect(research).toHaveBeenCalledWith({ input: "from stdin" });
  expect(await runProgram(["research", "-"], stubClient({ research }), { stdin: " " })).toBe(2);
  expect(io.stderr()).toContain("QUERY is required");
  // stdin is capped at 100,000 characters.
  await runProgram(["research", "-", "--json"], stubClient({ research }), {
    stdin: "x".repeat(200_000),
  });
  expect(research).toHaveBeenLastCalledWith({ input: "x".repeat(100_000) });
});

test("`research status` with no id researches the word status", async () => {
  const research = vi.fn(async (_body: Json) => COMPLETED);
  await runProgram(["--json", "research", "status"], stubClient({ research }));
  expect(research).toHaveBeenCalledWith({ input: "status" });
  // A leading option skips the rewrite; commander's default command still routes to run.
  await runProgram(["research", "--json", "q"], stubClient({ research }));
  expect(research).toHaveBeenLastCalledWith({ input: "q" });
});

test("stream JSON mode re-emits each SSE event as one JSON line", async () => {
  const research = vi.fn();
  expect(await runProgram(["research", "q", "--stream", "--json"], streamClient(research))).toBe(0);
  expect(research).toHaveBeenCalledWith({ input: "q" });
  const lines = io.stdout().trimEnd().split("\n");
  expect(lines).toHaveLength(7);
  expect(lines.map((l) => (JSON.parse(l) as Json).id)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  expect(lines[5]).toContain("\\u001b[31m");
});

test("stream human mode shows steps on stderr and renders the report", async () => {
  setTerminalOverride(false);
  expect(await runProgram(["research", "q", "--stream"], streamClient())).toBe(0);
  const steps = visible(io.stderr());
  expect(steps).toBe("  Planning\n  WebSearch: rust async\n  Found 2 sources\n");
  expect(io.stdout()).toBe(
    "# Report\n\nRust async is [31mfast[0m.\n\nSources:\n1. A https://a.example\n2. B https://b.example\n",
  );
});

test("status --json prints the response; human status shows request, status, and hints", async () => {
  const getResearch = vi.fn(async (_id: string) => ({ status: "completed", content: "x" }));
  await runProgram(["research", "status", "abc", "--json"], stubClient({ getResearch }));
  expect(getResearch).toHaveBeenCalledWith("abc");
  expect(io.stdout()).toBe('{"status":"completed","content":"x"}\n');

  const failed = vi.fn(async () => ({ status: "failed", error: "bad" }));
  await runProgram(["research", "status", "id\x1b[2J"], stubClient({ getResearch: failed }));
  const text = visible(io.stdout());
  expect(text).toContain("  Request:  id[2J\n");
  expect(text).toContain("  Status:   failed\n");
  expect(text).toContain("  Error: bad\n");
});

test("poll waits for the result; its timeout has no resume hint", async () => {
  vi.useFakeTimers();
  const { client, getResearch } = pendingClient({ status: "pending" }, COMPLETED);
  const done = runProgram(["research", "poll", "r1", "--poll-interval", "0", "--json"], client);
  await vi.advanceTimersByTimeAsync(1000);
  await done;
  expect(getResearch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(io.stdout())).toEqual(COMPLETED);

  const stuck = pendingClient({ status: "pending" });
  const timedOut = runProgram(["research", "poll", "r1", "--timeout", "2"], stuck.client);
  await vi.advanceTimersByTimeAsync(2000);
  await timedOut;
  expect(visible(io.stderr())).toContain("Timed out after 2s.\n");
  expect(io.stderr()).not.toContain("Resume with");
});

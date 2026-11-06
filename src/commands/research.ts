/** tvly research — deep research via the Tavily API (async: run/status/poll, or a live stream). */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { getKeyedClient } from "../core/client-factory.js";
import type { Json, TavilyClientLike } from "../core/tavily-client.js";
import { messageOf } from "../errors.js";
import { emit, resolveOutput } from "../ui/render/emit.js";
import { printResearchResult } from "../ui/render/research.js";
import { spinner, withSpinner } from "../ui/spinner.js";
import { sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";
import { resolveJson } from "./options.js";
import { handleApiError, readQueryArg, runWithApiErrors } from "./shared.js";

export interface PollOptions {
  pollInterval: number;
  timeout: number;
  output?: string;
  clientName?: string;
}

export interface RunOptions extends PollOptions {
  model?: string;
  /** false for `--no-wait` */
  wait: boolean;
  stream?: boolean;
  outputSchema?: string;
  citationFormat?: string;
}

const SUBCOMMANDS = new Set(["run", "status", "poll"]);
const NEED_ID = new Set(["status", "poll"]);

/**
 * Python's ResearchGroup routing: a first positional that is not a subcommand is a query for
 * `run`, and so is `status`/`poll` with no following positional and no help flag. `run` always
 * stays the subcommand (`run run` researches the word "run"). No args shows the group help, as
 * Click's `no_args_is_help` did.
 */
export function normalizeResearchArgs(args: string[]): string[] {
  const [first, next] = args;
  if (first === undefined) return ["--help"];
  if (first.startsWith("-")) return args;
  if (!SUBCOMMANDS.has(first)) return ["run", ...args];
  if (NEED_ID.has(first)) {
    const hasPositional = next !== undefined && !next.startsWith("-");
    const hasHelp = args.includes("--help") || args.includes("-h");
    if (!hasPositional && !hasHelp) return ["run", ...args];
  }
  return args;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isDone = (r: Json) => r.status === "completed" || r.status === "failed";

async function connect(cmd: Command, label: string, clientName: string | undefined) {
  const json = resolveJson(cmd);
  return { json, client: await getKeyedClient(label, { json, clientName }) };
}

/**
 * Poll every `pollInterval` seconds (at least 1) until the task completes or fails; undefined once
 * `timeout` seconds of wall time pass. Ticks every second so human mode's elapsed-time spinner stays
 * current; the spinner stops before any API error reaches the caller's `runWithApiErrors`.
 */
async function waitForResult(
  client: TavilyClientLike,
  requestId: string,
  opts: { json: boolean; pollInterval: number; timeout: number; label: string },
): Promise<Json | undefined> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  const message = () =>
    colors.aqua(`${opts.label}... ${Math.floor((Date.now() - start) / 1000)}s elapsed`);
  const live = spinner(message(), !opts.json);
  try {
    let nextPoll = start;
    while (Date.now() < deadline) {
      live.update(message());
      if (Date.now() >= nextPoll) {
        const response = await client.getResearch(requestId);
        if (isDone(response)) return response;
        nextPoll = Date.now() + Math.max(1, opts.pollInterval) * 1000;
      }
      await sleep(1000);
    }
    return undefined;
  } finally {
    live.stop();
  }
}

/** Print the finished task, or the timeout notice (followed by `hint` in human mode). */
async function finishWait(
  response: Json | undefined,
  requestId: string,
  opts: { json: boolean; outputFile: string | undefined; timeout: number },
  hint = "",
): Promise<void> {
  const { json, outputFile } = opts;
  if (response) return printResearchResult(response, { json, outputFile });
  if (json) emit({ request_id: requestId, status: "timeout" }, { outputFile, pretty: false });
  else err(colors.yellow(`Timed out after ${opts.timeout}s.${hint}`));
}

type StreamEvent = {
  choices?: Array<{ delta?: StreamDelta }>;
};
type StreamDelta = {
  content?: string;
  sources?: Json[];
  tool_calls?: {
    type?: string;
    tool_call?: Array<{ name?: string; arguments?: string }>;
    tool_response?: Array<{ name?: string; sources?: unknown[] }>;
  };
};

/** Each SSE payload that parses as JSON; blank and non-JSON payloads (like `[DONE]`) are skipped. */
async function* streamEvents(payloads: AsyncIterable<string>): AsyncIterable<unknown> {
  for await (const payload of payloads) {
    if (!payload.trim()) continue;
    try {
      yield JSON.parse(payload);
    } catch {
      // not JSON
    }
  }
}

/** Show tool-call steps on stderr as they change, then render the joined content as a report. */
async function renderStream(events: AsyncIterable<unknown>, outputFile: string | undefined) {
  const parts: string[] = [];
  let sources: Json[] = [];
  let currentStep: string | undefined;
  for await (const event of events) {
    const delta = (event as StreamEvent | null)?.choices?.[0]?.delta ?? {};
    const toolCalls = delta.tool_calls ?? {};
    if (toolCalls.type === "tool_call") {
      for (const tc of toolCalls.tool_call ?? []) {
        const name = tc.name ?? "";
        const step = tc.arguments ? `${name}: ${tc.arguments}` : name;
        if (step !== currentStep) {
          currentStep = step;
          err(`  ${colors.dim(sanitizeControl(step))}`);
        }
      }
    }
    if (toolCalls.type === "tool_response") {
      for (const tr of toolCalls.tool_response ?? []) {
        const count = tr.sources?.length ?? 0;
        if (tr.name === "WebSearch" && count) err(`  ${colors.dim(`Found ${count} sources`)}`);
      }
    }
    if (delta.content) parts.push(delta.content);
    if (delta.sources?.length) sources = delta.sources;
  }
  await printResearchResult(
    { status: "completed", content: parts.join(""), sources },
    { json: false, outputFile },
  );
}

export async function run(
  query: string | undefined,
  opts: RunOptions,
  cmd: Command,
): Promise<void> {
  const input = readQueryArg(query, cmd);
  const outputFile = resolveOutput(opts.output, "research", input);

  const body: Json = { input };
  if (opts.model !== undefined) body.model = opts.model;
  if (opts.outputSchema !== undefined) {
    try {
      body.output_schema = JSON.parse(readFileSync(opts.outputSchema, "utf8"));
    } catch (e) {
      cmd.error(`error: --output-schema must be a path to a JSON file: ${messageOf(e)}`);
    }
  }
  if (opts.citationFormat !== undefined) body.citation_format = opts.citationFormat;

  const { json, client } = await connect(cmd, "research", opts.clientName);

  if (opts.stream) {
    await runWithApiErrors(json, async () => {
      const events = streamEvents(await client.researchStream(body));
      if (!json) return renderStream(events, outputFile);
      // One JSON line per event: valid NDJSON with control bytes escaped by JSON.stringify.
      for await (const event of events) out(JSON.stringify(event));
    });
    return;
  }

  const result = await runWithApiErrors(json, () =>
    withSpinner("Starting research...", !json, () => client.research(body)),
  );
  // A synchronous result (the MCP endpoint returns one) needs no polling.
  if (isDone(result) || result.content) {
    await printResearchResult(result, { json, outputFile });
    return;
  }

  const requestId = result.request_id;
  if (typeof requestId !== "string" || !requestId) {
    handleApiError(new Error(`Unexpected API response: ${JSON.stringify(result)}`), json);
  }

  if (opts.wait === false) {
    emit(
      { request_id: requestId, status: result.status ?? "pending" },
      { outputFile, pretty: false },
    );
    return;
  }

  const response = await runWithApiErrors(json, () =>
    waitForResult(client, requestId, {
      json,
      pollInterval: opts.pollInterval,
      timeout: opts.timeout,
      label: "Researching",
    }),
  );
  const hint = ` Resume with: tvly research poll ${sanitizeControl(requestId)}`;
  await finishWait(response, requestId, { json, outputFile, timeout: opts.timeout }, hint);
}

const STATUS_COLORS: Record<string, (s: string) => string> = {
  completed: colors.green,
  failed: colors.pink,
};

export async function status(
  requestId: string,
  opts: { clientName?: string },
  cmd: Command,
): Promise<void> {
  const { json, client } = await connect(cmd, "research status", opts.clientName);
  const response = await runWithApiErrors(json, () => client.getResearch(requestId));
  if (json) {
    emit(response, { pretty: false });
    return;
  }
  const s = String(response.status ?? "unknown");
  const paint = STATUS_COLORS[s] ?? colors.yellow;
  const safeId = sanitizeControl(requestId);
  out(`  ${colors.bold("Request:")}  ${safeId}`);
  out(`  ${colors.bold("Status:")}   ${paint(sanitizeControl(s))}`);
  if (s === "completed")
    out(`  ${colors.dim(`Run 'tvly research poll ${safeId}' to view results.`)}`);
  else if (s === "failed") {
    out(`  ${colors.pink("Error:")} ${sanitizeControl(response.error ?? "Unknown error")}`);
  }
}

export async function poll(requestId: string, opts: PollOptions, cmd: Command): Promise<void> {
  const outputFile = resolveOutput(opts.output, "research", requestId);
  const { json, client } = await connect(cmd, "research poll", opts.clientName);
  const label = `Polling research ${sanitizeControl(requestId.slice(0, 8))}`;
  const response = await runWithApiErrors(json, () =>
    waitForResult(client, requestId, {
      json,
      pollInterval: opts.pollInterval,
      timeout: opts.timeout,
      label,
    }),
  );
  await finishWait(response, requestId, { json, outputFile, timeout: opts.timeout });
}

/** tvly search — web search via the Tavily API; up to 5 queries run in parallel. */
import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import { type Command, InvalidArgumentError, Option } from "commander";
import { getClientOrKeyless } from "../core/client-factory.js";
import { applySearchFlags, searchBodyFromOptions } from "../core/search-flags.js";
import type { Json } from "../core/tavily-client.js";
import { ExitError } from "../errors.js";
import { resolveOutput } from "../ui/output-file.js";
import { printMultiSearchResults, printSearchResults } from "../ui/render.js";
import { withSpinner } from "../ui/spinner.js";
import {
  addClientNameOption,
  addOutputOption,
  keylessCapError,
  LIMIT_STATUSES,
  parseNumberArg,
  printKeylessCapHit,
  readQueryArg,
  resolveJson,
  runWithApiErrors,
} from "./shared.js";

const MAX_QUERIES = 5;
const DEFAULT_CHARS = 600;

interface SearchOptions extends Record<string, unknown> {
  maxChars?: number;
  output?: string;
  clientName?: string;
}

/** The generated catalog flags, then the fixed ones; loaded only when `search` runs or shows help. */
export function configure(cmd: Command): void {
  applySearchFlags(cmd);
  cmd.addOption(
    new Option(
      "--max-chars <n>",
      "Characters of each result's content to print (default 600, shared across queries: 300 each for 2, 200 for 3); 0 prints it whole. --json and -o files keep it whole.",
    ).argParser((raw: string) => parseNumberArg(raw, { integer: true, minimum: 0 })),
  );
  addOutputOption(cmd);
  addClientNameOption(cmd);
}

function readQueries(args: string[]): string[] {
  const queries =
    args.length === 1 && args[0] === "-" ? [readQueryArg("-")] : args.filter((q) => q.trim());
  if (queries.length === 0) {
    throw new InvalidArgumentError(
      "QUERY is required. Pass a query string or use '-' to read from stdin.",
    );
  }
  if (queries.length > MAX_QUERIES) {
    throw new InvalidArgumentError(
      `At most ${MAX_QUERIES} queries per command, got ${queries.length}.`,
    );
  }
  return queries;
}

export async function run(args: string[], opts: SearchOptions, cmd: Command): Promise<void> {
  const json = resolveJson(cmd);
  let queries: string[];
  try {
    queries = readQueries(args);
  } catch (e) {
    if (e instanceof InvalidArgumentError) cmd.error(`error: ${e.message}`);
    throw e;
  }
  const outputFile = resolveOutput(opts.output, "search", queries[0]);
  // One search's worth of text per command, however many queries it holds.
  const maxChars = opts.maxChars ?? Math.floor(DEFAULT_CHARS / queries.length);
  const body = searchBodyFromOptions(opts);
  const spin = { enabled: !json };

  if (queries.length === 1) {
    const response = await runWithApiErrors(json, async () => {
      const client = await getClientOrKeyless(opts.clientName);
      return withSpinner("Searching...", spin, () => client.search({ query: queries[0], ...body }));
    });
    await printSearchResults(response, { json, outputFile, maxChars });
    return;
  }

  const client = await runWithApiErrors(json, () => getClientOrKeyless(opts.clientName));
  const capHits: TavilyKeylessLimitError[] = [];
  let limitHit = false;
  const responses = await withSpinner("Searching...", spin, () =>
    Promise.all(
      queries.map(async (query): Promise<Json> => {
        try {
          return await client.search({ query, ...body });
        } catch (e) {
          // One failed query must not lose the others' results.
          if (e instanceof TavilyKeylessLimitError) {
            capHits.push(e);
            return { query, error: keylessCapError(e) };
          }
          if (e instanceof TavilyRequestError && LIMIT_STATUSES.has(e.status)) limitHit = true;
          return { query, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    ),
  );
  await printMultiSearchResults(responses, { json, outputFile, maxChars });
  const [firstCap] = capHits;
  if (firstCap && !json) printKeylessCapHit(firstCap);
  // Usage limits exit 3 on every credential type, as a single query does.
  if (responses.every((r) => "error" in r)) {
    throw new ExitError(capHits.length > 0 || limitHit ? 3 : 4);
  }
}

/** tvly extract — extract content from URLs via the Tavily API. */
import type { Command } from "commander";
import { getClientOrKeyless } from "../core/client-factory.js";
import type { Json } from "../core/tavily-client.js";
import { resolveOutput } from "../ui/output-file.js";
import { printExtractResults } from "../ui/render.js";
import { withSpinner } from "../ui/spinner.js";
import { domainOf } from "../ui/text.js";
import { resolveJson, runWithApiErrors } from "./shared.js";

const MAX_URLS = 20;

export interface ExtractDeps {
  getClientOrKeyless?: typeof getClientOrKeyless;
}

interface ExtractOptions {
  query?: string;
  chunksPerSource?: number;
  extractDepth?: string;
  format?: string;
  includeImages?: boolean;
  timeout?: number;
  output?: string;
  clientName?: string;
}

export async function run(
  urls: string[],
  opts: ExtractOptions,
  cmd: Command,
  deps: ExtractDeps = {},
): Promise<void> {
  const json = resolveJson(cmd);
  if (urls.length > MAX_URLS) cmd.error(`error: Maximum ${MAX_URLS} URLs per request.`);
  const outputFile = resolveOutput(opts.output, "extract", domainOf(urls[0] ?? ""));

  const body: Json = { urls };
  if (opts.query !== undefined) body.query = opts.query;
  if (opts.chunksPerSource !== undefined) body.chunks_per_source = opts.chunksPerSource;
  if (opts.extractDepth !== undefined) body.extract_depth = opts.extractDepth;
  if (opts.format !== undefined) body.format = opts.format;
  if (opts.includeImages) body.include_images = true;
  if (opts.timeout !== undefined) body.timeout = opts.timeout;

  const resolveClient = deps.getClientOrKeyless ?? getClientOrKeyless;
  const response = await runWithApiErrors(json, async () => {
    const { client } = await resolveClient({ clientName: opts.clientName });
    const label = `Extracting ${urls.length} URL${urls.length > 1 ? "s" : ""}...`;
    return withSpinner(label, { enabled: !json }, () => client.extract(body));
  });
  await printExtractResults(response, { json, outputFile });
}

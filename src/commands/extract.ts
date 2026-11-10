/** tvly extract — extract content from URLs via the Tavily API. */
import type { Command } from "commander";
import type { Host } from "../host.js";
import { resolveOutput } from "../ui/render/emit.js";
import { printExtractResults } from "../ui/render/extract.js";
import { domainOf } from "../ui/text.js";
import { invoke } from "./invoke.js";
import { resolveJson } from "./options.js";
import { definedSnake } from "./shared.js";

const MAX_URLS = 20;

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
  host: Host,
): Promise<void> {
  const json = resolveJson(cmd);
  if (urls.length > MAX_URLS) cmd.error(`error: Maximum ${MAX_URLS} URLs per request.`);
  const outputFile = resolveOutput(opts.output, "extract", domainOf(urls[0] ?? ""));

  const body = {
    urls,
    ...definedSnake(opts, [
      "query",
      "chunksPerSource",
      "extractDepth",
      "format",
      "includeImages",
      "timeout",
    ]),
  };

  const label = `Extracting ${urls.length} URL${urls.length > 1 ? "s" : ""}...`;
  const response = await invoke(
    cmd,
    host,
    { label, keyed: false, clientName: opts.clientName },
    (client) => client.extract(body),
  );
  await printExtractResults(response, { json, outputFile });
}

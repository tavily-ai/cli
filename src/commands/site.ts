/** tvly crawl and tvly map — walk a website via the Tavily API (both need an API key). */
import type { Command } from "commander";
import type { Context } from "../context.js";
import { printCrawlResults, printMapResults } from "../ui/render/crawl.js";
import { resolveOutput } from "../ui/render/emit.js";
import { hostOf } from "../ui/text.js";
import { invoke } from "./invoke.js";
import { resolveJson } from "./options.js";
import { definedSnake, splitCsv } from "./shared.js";

/** The options crawl and map share. */
interface SiteOptions {
  maxDepth?: number;
  maxBreadth?: number;
  limit?: number;
  instructions?: string;
  selectPaths?: string;
  excludePaths?: string;
  selectDomains?: string;
  excludeDomains?: string;
  /** `--allow-external` */
  allowExternal?: boolean;
  /** false for `--no-external` */
  external?: boolean;
  timeout?: number;
  output?: string;
  clientName?: string;
}

interface CrawlOptions extends SiteOptions {
  chunksPerSource?: number;
  extractDepth?: string;
  format?: string;
  includeImages?: boolean;
  outputDir?: string;
}

/** The shared options as the API's request body (unset ones are left out). */
function siteBody(url: string, opts: SiteOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    url,
    ...definedSnake(opts, ["maxDepth", "maxBreadth", "limit", "instructions"]),
  };
  const lists = {
    select_paths: splitCsv(opts.selectPaths),
    exclude_paths: splitCsv(opts.excludePaths),
    select_domains: splitCsv(opts.selectDomains),
    exclude_domains: splitCsv(opts.excludeDomains),
  };
  for (const [key, value] of Object.entries(lists)) if (value) body[key] = value;
  const allowExternal = opts.external === false ? false : opts.allowExternal;
  if (allowExternal !== undefined) body.allow_external = allowExternal;
  return { ...body, ...definedSnake(opts, ["timeout"]) };
}

export async function runCrawl(
  url: string,
  opts: CrawlOptions,
  cmd: Command,
  ctx: Context,
): Promise<void> {
  const json = resolveJson(cmd);
  const outputFile = resolveOutput(opts.output, "crawl", hostOf(url));
  const body = {
    ...siteBody(url, opts),
    ...definedSnake(opts, ["chunksPerSource", "extractDepth", "format", "includeImages"]),
  };
  const response = await invoke(
    cmd,
    ctx,
    { label: `Crawling ${url}...`, keyed: "crawl", clientName: opts.clientName },
    (client) => client.crawl(body),
  );
  await printCrawlResults(response, { json, outputFile, outputDir: opts.outputDir });
}

export async function runMap(
  url: string,
  opts: SiteOptions,
  cmd: Command,
  ctx: Context,
): Promise<void> {
  const json = resolveJson(cmd);
  const outputFile = resolveOutput(opts.output, "map", hostOf(url));
  const response = await invoke(
    cmd,
    ctx,
    { label: `Mapping ${url}...`, keyed: "map", clientName: opts.clientName },
    (client) => client.map(siteBody(url, opts)),
  );
  await printMapResults(response, { json, outputFile });
}

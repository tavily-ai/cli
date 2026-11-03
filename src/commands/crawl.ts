/** tvly crawl — crawl a website via the Tavily API (needs an API key). */
import type { Command } from "commander";
import { getClient, requireApiKeyFriendly } from "../core/client-factory.js";
import { resolveOutput } from "../ui/output-file.js";
import { printCrawlResults } from "../ui/render.js";
import { withSpinner } from "../ui/spinner.js";
import { hostOf } from "../ui/text.js";
import { resolveJson, runWithApiErrors, type SiteOptions, siteBody } from "./shared.js";

export interface CrawlDeps {
  requireApiKeyFriendly?: typeof requireApiKeyFriendly;
  getClient?: typeof getClient;
}

interface CrawlOptions extends SiteOptions {
  chunksPerSource?: number;
  extractDepth?: string;
  format?: string;
  includeImages?: boolean;
  output?: string;
  outputDir?: string;
  clientName?: string;
}

export async function run(
  url: string,
  opts: CrawlOptions,
  cmd: Command,
  deps: CrawlDeps = {},
): Promise<void> {
  const json = resolveJson(cmd);
  const outputFile = resolveOutput(opts.output, "crawl", hostOf(url));

  await (deps.requireApiKeyFriendly ?? requireApiKeyFriendly)("crawl", { json });
  const client = await (deps.getClient ?? getClient)({
    json,
    ...(opts.clientName ? { clientName: opts.clientName } : {}),
  });

  const body = siteBody(url, opts);
  if (opts.chunksPerSource !== undefined) body.chunks_per_source = opts.chunksPerSource;
  if (opts.extractDepth !== undefined) body.extract_depth = opts.extractDepth;
  if (opts.format !== undefined) body.format = opts.format;
  if (opts.includeImages) body.include_images = true;

  const response = await runWithApiErrors(json, () =>
    withSpinner(`Crawling ${url}...`, { enabled: !json }, () => client.crawl(body)),
  );
  await printCrawlResults(response, { json, outputFile, outputDir: opts.outputDir });
}

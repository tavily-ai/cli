/** tvly map — discover the URLs on a website via the Tavily API (needs an API key). */
import type { Command } from "commander";
import { getKeyedClient } from "../core/client-factory.js";
import { resolveOutput } from "../ui/output-file.js";
import { printMapResults } from "../ui/render.js";
import { withSpinner } from "../ui/spinner.js";
import { hostOf } from "../ui/text.js";
import { resolveJson, runWithApiErrors, type SiteOptions, siteBody } from "./shared.js";

interface MapOptions extends SiteOptions {
  output?: string;
  clientName?: string;
}

export async function run(url: string, opts: MapOptions, cmd: Command): Promise<void> {
  const json = resolveJson(cmd);
  const outputFile = resolveOutput(opts.output, "map", hostOf(url));
  const client = await getKeyedClient("map", { json, clientName: opts.clientName });
  const response = await runWithApiErrors(json, () =>
    withSpinner(`Mapping ${url}...`, { enabled: !json }, () => client.map(siteBody(url, opts))),
  );
  await printMapResults(response, { json, outputFile });
}

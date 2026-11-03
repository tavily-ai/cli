import { CommanderError } from "commander";
import { type CrawlDeps, run as runCrawl } from "../../src/commands/crawl.js";
import { type ExtractDeps, run as runExtract } from "../../src/commands/extract.js";
import { type MapDeps, run as runMap } from "../../src/commands/map.js";
import {
  type ResearchDeps,
  poll as researchPoll,
  run as researchRun,
  status as researchStatus,
} from "../../src/commands/research.js";
import { run as runSearch, type SearchDeps } from "../../src/commands/search.js";
import type { TavilyClientLike } from "../../src/core/tavily-client.js";
import { ExitError } from "../../src/errors.js";
import { buildProgram } from "../../src/program.js";

/** A client whose methods are the given functions; every other method throws. */
export function stubClient(methods: Partial<TavilyClientLike>): TavilyClientLike {
  const missing = async () => {
    throw new Error("unexpected call");
  };
  return {
    search: methods.search ?? missing,
    extract: methods.extract ?? missing,
    crawl: methods.crawl ?? missing,
    map: methods.map ?? missing,
    research: methods.research ?? missing,
    researchStream: methods.researchStream ?? missing,
    getResearch: methods.getResearch ?? missing,
  };
}

/** Run the real command tree in-process with `client`, returning the exit code `cli.ts` would set. */
export async function runProgram(
  argv: string[],
  client: TavilyClientLike,
  extra: Partial<SearchDeps & ExtractDeps & CrawlDeps & MapDeps & ResearchDeps> = {},
): Promise<number> {
  const deps = {
    requireApiKeyFriendly: async () => "tvly-test",
    getClient: async () => client,
    getClientOrKeyless: async () => ({ client, keyless: false }),
    ...extra,
  };
  const program = buildProgram();
  for (const sub of program.commands) {
    if (sub.name() === "search") sub.action((a, o, c) => runSearch(a, o, c, deps));
    if (sub.name() === "extract") sub.action((a, o, c) => runExtract(a, o, c, deps));
    if (sub.name() === "crawl") sub.action((a, o, c) => runCrawl(a, o, c, deps));
    if (sub.name() === "map") sub.action((a, o, c) => runMap(a, o, c, deps));
    if (sub.name() === "research") {
      for (const r of sub.commands) {
        if (r.name() === "run") r.action((a, o, c) => researchRun(a, o, c, deps));
        if (r.name() === "status") r.action((a, o, c) => researchStatus(a, o, c, deps));
        if (r.name() === "poll") r.action((a, o, c) => researchPoll(a, o, c, deps));
      }
    }
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
}

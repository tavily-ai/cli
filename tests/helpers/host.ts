import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TavilyClientLike } from "../../src/core/tavily-client.js";
import type { Host } from "../../src/host.js";
import { fakeExec } from "./exec.js";

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

export const NOW = 1_700_000_000_000;

/**
 * A machine for tests: a fresh empty home (also the cwd), no environment, Linux, no TTYs, a
 * fixed clock, no network, an `Exec` that finds everything and succeeds silently, prompts that
 * take their default, and a client that rejects every call.
 */
export function fakeHost(over: Partial<Host> = {}): Host {
  const home = over.home ?? mkdtempSync(join(tmpdir(), "tvly-home-"));
  return {
    home,
    cwd: home,
    argv: ["node", "tvly"],
    env: {},
    platform: "linux",
    stdinIsTTY: false,
    stderrIsTTY: false,
    now: () => NOW,
    fetch: () => {
      throw new Error("unexpected fetch");
    },
    exec: fakeExec(),
    confirm: async (_question, defaultYes = true) => defaultYes,
    openUrl: () => {},
    resolveClient: async () => stubClient({}),
    ...over,
  };
}

/** A host whose resolved client is `stubClient(methods)`, with a key set so keyed commands run. */
export function clientHost(methods: Partial<TavilyClientLike>, over: Partial<Host> = {}): Host {
  const client = stubClient(methods);
  return fakeHost({
    env: { TAVILY_API_KEY: "tvly-test" },
    resolveClient: async () => client,
    ...over,
  });
}

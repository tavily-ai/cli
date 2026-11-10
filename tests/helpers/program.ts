import { CommanderError } from "commander";
import { vi } from "vitest";
import type { TavilyClientLike } from "../../src/core/tavily-client.js";
import { ExitError } from "../../src/errors.js";
import { buildProgram } from "../../src/program.js";

/** What `runProgram` feeds the commands through the `node:fs` mock: stdin text. */
const fake = vi.hoisted(() => ({ stdin: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) =>
    file === 0
      ? fake.stdin
      : (fs.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

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

// biome-ignore lint/suspicious/noExplicitAny: commander passes each action its own argument list
type Action = (...args: any[]) => void | Promise<void>;

/**
 * Run the real command tree in-process with `client` as every resolved client, returning the exit
 * code `cli.ts` would set. The commands resolve the credential for real, so a key is set unless
 * the test chose one (`vi.stubEnv("TAVILY_API_KEY", "")` for the keyless and no-key cases).
 * `actions` replaces command actions by name (`"init"`, or `"setup mcp"` for a subcommand), for
 * commands that take injected deps.
 */
export async function runProgram(
  argv: string[],
  client: TavilyClientLike = stubClient({}),
  opts: { stdin?: string; actions?: Record<string, Action> } = {},
): Promise<number> {
  fake.stdin = opts.stdin ?? "";
  const key = process.env.TAVILY_API_KEY;
  if (key === undefined) process.env.TAVILY_API_KEY = "tvly-test";
  const program = buildProgram({ resolveClient: async () => client });
  for (const sub of program.commands) {
    for (const cmd of [sub, ...sub.commands]) {
      const name = cmd === sub ? sub.name() : `${sub.name()} ${cmd.name()}`;
      const action = opts.actions?.[name];
      if (action) cmd.action(action);
    }
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  } finally {
    if (key === undefined) delete process.env.TAVILY_API_KEY;
  }
}

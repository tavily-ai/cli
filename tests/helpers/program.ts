import { CommanderError } from "commander";
import { vi } from "vitest";
import type { TavilyClientLike } from "../../src/core/tavily-client.js";
import { ExitError } from "../../src/errors.js";
import { buildProgram } from "../../src/program.js";

/** What `runProgram` feeds the commands: the client both factories return, and stdin text. */
const fake = vi.hoisted(() => ({ client: undefined as unknown as TavilyClientLike, stdin: "" }));

type Factory = typeof import("../../src/core/client-factory.js");

/** Both factories resolve to the client passed to `runProgram`; tests override them per call. */
const factory = vi.hoisted(() => ({
  getKeyedClient: vi.fn<Factory["getKeyedClient"]>(async () => fake.client),
  getClientOrKeyless: vi.fn<Factory["getClientOrKeyless"]>(async () => fake.client),
}));
export const clientFactory = factory;

vi.mock("../../src/core/client-factory.js", () => factory);
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

/** Run the real command tree in-process with `client`, returning the exit code `cli.ts` would set. */
export async function runProgram(
  argv: string[],
  client: TavilyClientLike,
  opts: { stdin?: string } = {},
): Promise<number> {
  fake.client = client;
  fake.stdin = opts.stdin ?? "";
  try {
    await buildProgram().parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
}

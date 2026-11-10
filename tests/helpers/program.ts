import { CommanderError } from "commander";
import { vi } from "vitest";
import { ExitError } from "../../src/errors.js";
import type { Host } from "../../src/host.js";
import { buildProgram } from "../../src/program.js";
import { fakeHost } from "./host.js";

export { clientHost, fakeHost, stubClient } from "./host.js";

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

/** Run the real command tree in-process against `host`, returning the exit code `cli.ts` would set. */
export async function runProgram(
  argv: string[],
  host: Host = fakeHost(),
  opts: { stdin?: string } = {},
): Promise<number> {
  fake.stdin = opts.stdin ?? "";
  try {
    await buildProgram(host).parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
}

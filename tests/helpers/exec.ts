import type { Exec, ExecOptions, ExecResult } from "../../src/util/exec.js";

export interface ExecCall {
  bin: string;
  args: string[];
  opts: ExecOptions;
}

export interface FakeExec extends Exec {
  calls: ExecCall[];
}

/** Scripts a fake run's result from its bin and args; undefined is ok with empty output. */
export type ExecScript = (bin: string, args: string[]) => Partial<ExecResult> | undefined;

/** A complete `ExecResult`: ok with empty output unless overridden. */
export function execResult(over: Partial<ExecResult> = {}): ExecResult {
  return { ok: true, stdout: "", stderr: "", failure: null, ...over };
}

/**
 * An `Exec` that records every run in `calls`. `which` finds everything under /usr/bin unless
 * given; `run` scripts each result from the bin and args (default: ok with empty output).
 * `runAsync` goes through `run`, so both are recorded and scripted alike.
 */
export function fakeExec(
  opts: { which?: (name: string) => string | null; run?: ExecScript } = {},
): FakeExec {
  const calls: ExecCall[] = [];
  const fake: FakeExec = {
    calls,
    which: opts.which ?? ((name) => `/usr/bin/${name}`),
    run(bin, args, o) {
      calls.push({ bin, args, opts: o });
      return execResult(opts.run?.(bin, args));
    },
    runAsync: async (bin, args, o) => fake.run(bin, args, o),
  };
  return fake;
}

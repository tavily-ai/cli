import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  env?: Record<string, string>;
  /** Start from an empty environment (PATH only), so no TAVILY_* or HOME leaks in from this one. */
  isolated?: boolean;
  /** A module to `node --import` before the CLI, such as fetch-redirect.mjs. */
  preload?: string;
}

export function runCli(args: string[], opts: RunOptions = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const preload = opts.preload ? ["--import", opts.preload] : [];
    const base = opts.isolated ? { PATH: process.env.PATH ?? "" } : process.env;
    const child = spawn(process.execPath, [...preload, CLI, ...args], {
      env: { ...base, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end();
  });
}

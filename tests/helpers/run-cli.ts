import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  env?: Record<string, string>;
  /** Start from a minimal environment, so no TAVILY_* or HOME leaks in from this one. */
  isolated?: boolean;
  /** A module to `node --import` before the CLI, such as fetch-redirect.mjs. */
  preload?: string;
}

// What `isolated` keeps: PATH, plus what Windows needs for sockets, temp files and PowerShell.
const KEPT = ["PATH", "PATHEXT", "SystemRoot", "windir", "ComSpec", "TEMP", "TMP"];

function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of KEPT) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function runCli(args: string[], opts: RunOptions = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    // --import takes a URL: a bare `C:\...` path is rejected on Windows.
    const preload = opts.preload ? ["--import", pathToFileURL(opts.preload).href] : [];
    const base = opts.isolated ? minimalEnv() : process.env;
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

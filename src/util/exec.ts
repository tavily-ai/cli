/** Finding and running other programs: every subprocess the CLI waits on goes through `Exec`. */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** null on exit 0; else "timed out", the spawn error, the last output line, or the signal / exit code. */
  failure: string | null;
}

export interface ExecOptions {
  /** No timeout when absent (only for a streamed, interruptible run). */
  timeoutMs?: number;
  /** Stream output to the user's terminal instead of capturing it; `"stderr"` sends the child's
   * stdout there too, keeping this process's stdout for its own result. Outputs are "" then. */
  inherit?: true | "stderr";
}

export interface Exec {
  which(name: string): string | null;
  run(bin: string, args: string[], opts: ExecOptions): ExecResult;
}

interface RealDeps {
  spawn: typeof spawnSync;
  exists: (p: string) => boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  execPath: string;
}

const MAX_BUFFER = 16 * 1024 * 1024;
const SHIM = /\.(cmd|bat)$/i;

/**
 * First executable match for `name` on PATH (honoring PATHEXT on Windows), or null. The `_npx`
 * cache entry that `npx @tavily/cli` prepends for its own run is not the user's PATH and is skipped.
 */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv, win: boolean): string | null {
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (dir.replace(/\\/g, "/").includes("/_npx/")) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function failureOf(r: SpawnSyncReturns<string>): string | null {
  if (r.error) {
    return (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timed out" : r.error.message;
  }
  if (r.status === 0) return null;
  const last = (r.stderr || r.stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .pop();
  return last ?? (r.status === null ? `signal ${r.signal}` : `exit code ${r.status}`);
}

/** The real `Exec` over `deps`; `exec` below is the one the CLI uses. */
export function createExec(deps: RealDeps): Exec {
  const win = deps.platform === "win32";
  return {
    which: (name) => whichOnPath(name, deps.env, win),
    run(bin, args, opts) {
      let file = bin;
      let argv = args;
      let shell = false;
      // Windows: a .cmd shim needs the shell (spawning it directly throws EINVAL on Node
      // 20.12.2+), which re-parses the command line. npm's own shims run through node and
      // npm-cli.js / npx-cli.js instead, so arguments holding spaces survive.
      if (win && SHIM.test(bin)) {
        const name = path.win32.basename(bin).replace(SHIM, "").toLowerCase();
        const cli = path.win32.join(
          path.win32.dirname(deps.execPath),
          "node_modules",
          "npm",
          "bin",
          `${name}-cli.js`,
        );
        if ((name === "npm" || name === "npx") && deps.exists(cli)) {
          file = deps.execPath;
          argv = [cli, ...args];
        } else {
          file = `"${bin}"`;
          shell = true;
        }
      }
      const r = deps.spawn(file, argv, {
        stdio:
          opts.inherit === "stderr"
            ? ["ignore", 2, 2]
            : opts.inherit
              ? "inherit"
              : ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: opts.timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        shell,
      });
      const failure = failureOf(r);
      return { ok: failure === null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", failure };
    },
  };
}

export const exec: Exec = createExec({
  spawn: spawnSync,
  exists: existsSync,
  env: process.env,
  platform: process.platform,
  execPath: process.execPath,
});

/** Finding and running other programs: every subprocess the CLI waits on goes through `Exec`. */
import {
  type ChildProcess,
  type ExecFileException,
  execFile,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
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
  /** `run` without blocking the event loop (so spinners keep drawing); output is always captured. */
  runAsync(bin: string, args: string[], opts: Pick<ExecOptions, "timeoutMs">): Promise<ExecResult>;
}

type ExecFileFn = (
  file: string,
  args: string[],
  opts: {
    encoding: "utf8";
    timeout: number | undefined;
    maxBuffer: number;
    windowsHide: boolean;
    shell: boolean;
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => ChildProcess;

interface RealDeps {
  spawn: typeof spawnSync;
  execFile: ExecFileFn;
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

/** How a child ended, from either spawnSync's return or execFile's callback. */
interface Outcome {
  status: number | null;
  signal: string | null;
  error?: Error | undefined;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function fromSync(r: SpawnSyncReturns<string>): Outcome {
  return {
    status: r.status,
    signal: r.signal,
    error: r.error,
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** execFile reports a nonzero exit as a numeric `code`, a spawn or maxBuffer error as a string
 * `code`, and its own timeout kill as `killed`. */
function fromAsync(e: ExecFileException | null, stdout: string, stderr: string): Outcome {
  const code = e?.code;
  return {
    status: !e ? 0 : typeof code === "number" ? code : null,
    signal: e?.signal ?? null,
    error: typeof code === "string" ? (e as Error) : undefined,
    timedOut: e?.killed === true && typeof code !== "string",
    stdout: stdout ?? "",
    stderr: stderr ?? "",
  };
}

function result(o: Outcome): ExecResult {
  const failure = failureOf(o);
  return { ok: failure === null, stdout: o.stdout, stderr: o.stderr, failure };
}

function failureOf(o: Outcome): string | null {
  if (o.timedOut) return "timed out";
  if (o.error) return o.error.message;
  if (o.status === 0) return null;
  const last = (o.stderr || o.stdout)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .pop();
  return last ?? (o.status === null ? `signal ${o.signal}` : `exit code ${o.status}`);
}

/** The real `Exec` over `deps`; `exec` below is the one the CLI uses. */
export function createExec(deps: RealDeps): Exec {
  const win = deps.platform === "win32";

  /**
   * Windows: a .cmd shim needs the shell (spawning it directly throws EINVAL on Node 20.12.2+),
   * which re-parses the command line. npm's own shims run through node and npm-cli.js /
   * npx-cli.js instead, so arguments holding spaces survive.
   */
  function resolve(bin: string, args: string[]): { file: string; argv: string[]; shell: boolean } {
    if (!win || !SHIM.test(bin)) return { file: bin, argv: args, shell: false };
    const name = path.win32.basename(bin).replace(SHIM, "").toLowerCase();
    const cli = path.win32.join(
      path.win32.dirname(deps.execPath),
      "node_modules",
      "npm",
      "bin",
      `${name}-cli.js`,
    );
    if ((name === "npm" || name === "npx") && deps.exists(cli)) {
      return { file: deps.execPath, argv: [cli, ...args], shell: false };
    }
    return { file: `"${bin}"`, argv: args, shell: true };
  }

  return {
    which: (name) => whichOnPath(name, deps.env, win),
    run(bin, args, opts) {
      const { file, argv, shell } = resolve(bin, args);
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
      return result(fromSync(r));
    },
    runAsync(bin, args, opts) {
      const { file, argv, shell } = resolve(bin, args);
      return new Promise((done) => {
        const child = deps.execFile(
          file,
          argv,
          {
            encoding: "utf8",
            timeout: opts.timeoutMs,
            maxBuffer: MAX_BUFFER,
            windowsHide: true,
            shell,
          },
          (e, stdout, stderr) => done(result(fromAsync(e, stdout, stderr))),
        );
        // Like run's ignored stdin: a child that reads stdin sees EOF instead of waiting.
        child.stdin?.end();
      });
    },
  };
}

export const exec: Exec = createExec({
  spawn: spawnSync,
  execFile: execFile as ExecFileFn,
  exists: existsSync,
  env: process.env,
  platform: process.platform,
  execPath: process.execPath,
});

/** Finding and running other programs: PATH lookup and package-manager runs. */
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<string | Buffer>;

/** First executable match for `name` on PATH (honoring PATHEXT on Windows), or null. */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const win = process.platform === "win32";
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
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

/**
 * Run a package manager with piped output, a 5-minute timeout and a 16 MB buffer. With `shell`
 * (a Windows .cmd shim) `file` is quoted; the arguments must hold no spaces or quotes.
 */
export function runManager(
  spawnImpl: SpawnFn,
  file: string,
  args: string[],
  shell: boolean,
): SpawnSyncReturns<string | Buffer> {
  return spawnImpl(shell ? `"${file}"` : file, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    shell,
  });
}

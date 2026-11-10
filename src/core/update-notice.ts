/**
 * A passive once-a-day check for a newer release, printed on stderr after the command's own
 * output. The registry request runs concurrently with the command and is raced against a short
 * timer at the end, so it never delays the command and never installs anything.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Host } from "../host.js";
import { colors, err } from "../ui/theme.js";
import { isNewer } from "../util/semver.js";
import { VERSION } from "../version.js";
import { detectInstall, fetchLatestVersion } from "./install-detect.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RACE_MS = 1500;
const SKIP_FLAGS = new Set(["--version", "--help", "-V", "-h"]);
// Both already report the installed and latest versions themselves.
const SKIP_COMMANDS = new Set(["update", "init"]);

interface State {
  checked_at: number;
  latest: string | null;
}

const noop = async () => {};

function readState(file: string): State | null {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<State> | null;
    if (typeof data?.checked_at !== "number") return null;
    return {
      checked_at: data.checked_at,
      latest: typeof data.latest === "string" ? data.latest : null,
    };
  } catch {
    return null;
  }
}

function writeState(file: string, state: State): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state)}\n`);
  } catch {}
}

/**
 * Decide whether to check, start the registry request when the cached answer is older than a day,
 * and return `finish`, which prints the notice (if any) once the command's output is complete.
 */
export function startUpdateCheck(
  host: Pick<Host, "home" | "env" | "argv" | "fetch" | "now" | "stderrIsTTY" | "exec">,
): () => Promise<void> {
  try {
    const { env, now } = host;
    const args = host.argv.slice(2);
    const command = args.find((a) => !a.startsWith("-")) ?? "";
    if (
      env.CI ||
      env.NO_UPDATE_NOTIFIER ||
      !host.stderrIsTTY ||
      args.includes("--json") ||
      args.some((a) => SKIP_FLAGS.has(a)) ||
      SKIP_COMMANDS.has(command) ||
      // `/_npx/` is matched before any package-manager spawn, so skipping `npm root -g` keeps this cheap.
      detectInstall(host, () => null).method === "npx"
    ) {
      return noop;
    }

    const current = VERSION;
    // Not configPaths(): config.ts would pull proper-lockfile into the entry chunk.
    const file = path.join(host.home, ".tavily", "update-check.json");
    const notify = (latest: string | null) => {
      try {
        if (latest === null || !isNewer(latest, current)) return;
        err();
        err(
          colors.dim(`Tavily CLI update available: ${current} -> ${latest}. Run \`tvly update\`.`),
        );
      } catch {}
    };

    const state = readState(file);
    if (state && now() - state.checked_at < CHECK_INTERVAL_MS) {
      return async () => notify(state.latest);
    }

    // The race is the only timeout: whatever is still in flight at finish is aborted, so a slow
    // registry never keeps the process alive after the command's output.
    const controller = new AbortController();
    const pending = fetchLatestVersion(host.fetch, controller.signal).catch(() => null);
    return async () => {
      let timer: NodeJS.Timeout | undefined;
      const latest = await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          timer = setTimeout(resolve, RACE_MS, null);
        }),
      ]);
      clearTimeout(timer);
      controller.abort();
      writeState(file, { checked_at: now(), latest });
      notify(latest);
    };
  } catch {
    return noop;
  }
}

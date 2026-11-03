/** Work out which package manager owns the running CLI, and how to upgrade it. */
import * as childProcess from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { compareVersions } from "../util/semver.js";
import { whichOnPath } from "./skills.js";

export const NPM_LATEST_URL = "https://registry.npmjs.org/@tavily/cli/latest";
const PACKAGE_SPEC = "@tavily/cli@latest";

export type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "npx" | "source" | "unknown";

export interface InstallInfo {
  method: InstallMethod;
  command: string[] | null;
  blockedReason: string | null;
}

export interface DetectOptions {
  argv1?: string;
  realpath?: (p: string) => string;
  npmRootGlobal?: () => string | null;
  env?: NodeJS.ProcessEnv;
  which?: (name: string) => string | null;
}

const MANAGER_COMMANDS: Record<"npm" | "pnpm" | "yarn" | "bun", string[]> = {
  npm: ["npm", "install", "-g", PACKAGE_SPEC],
  pnpm: ["pnpm", "add", "-g", PACKAGE_SPEC],
  yarn: ["yarn", "global", "add", PACKAGE_SPEC],
  bun: ["bun", "add", "-g", PACKAGE_SPEC],
};

const SOURCE_REASON =
  "This is a source or direct-URL installation. Update it from its original source.";
const NPX_REASON =
  "This CLI is running from an npx cache and cannot update itself in place. " +
  "Exit and rerun `npx @tavily/cli@latest` instead.";
const UNKNOWN_REASON =
  "Could not determine how Tavily CLI was installed. Update it with the original package manager.";

/** Forward slashes and lower case, so Windows and POSIX paths match with one set of rules. */
const normalize = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

const blocked = (method: InstallMethod, reason: string): InstallInfo => ({
  method,
  command: null,
  blockedReason: reason,
});

/**
 * Run `npm root -g` through npm's resolved PATH entry. Windows needs `shell: true` for the .cmd
 * shim, and a bare name there would also find an `npm.cmd` planted in the current directory.
 */
export function npmRootGlobalDefault(deps: {
  which: (name: string) => string | null;
  spawnSync?: typeof childProcess.spawnSync;
  platform?: NodeJS.Platform;
}): string | null {
  const npm = deps.which("npm");
  if (!npm) return null;
  const win = (deps.platform ?? process.platform) === "win32";
  try {
    const r = (deps.spawnSync ?? childProcess.spawnSync)(win ? `"${npm}"` : npm, ["root", "-g"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      shell: win,
    });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout).trim() || null;
  } catch {
    return null;
  }
}

/** Walk up from a file to the directory holding the nearest package.json, or null if there is none. */
function packageDir(file: string): string | null {
  if (!path.isAbsolute(file)) return null;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

function safeRealpath(p: string, realpath: (p: string) => string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

export function detectInstall(opts: DetectOptions = {}): InstallInfo {
  const env = opts.env ?? process.env;
  const raw = opts.argv1 ?? process.argv[1] ?? "";
  const real = safeRealpath(raw, opts.realpath ?? realpathSync);
  const normReal = normalize(real);
  const normRaw = normalize(raw);
  const which = opts.which ?? ((name: string) => whichOnPath(name, env));

  if (normReal.includes("/_npx/")) return blocked("npx", NPX_REASON);

  // A checkout, or an `npm link` symlink pointing at one.
  const inNodeModules = (p: string) => p.split("/").includes("node_modules");
  const linked = normRaw !== normReal && normRaw.includes("node_modules/@tavily/cli");
  const pkgDir = packageDir(real);
  if (linked || !inNodeModules(pkgDir === null ? normReal : normalize(pkgDir))) {
    return blocked("source", SOURCE_REASON);
  }

  const pnpmHome = env.PNPM_HOME ? normalize(env.PNPM_HOME).replace(/\/+$/, "") : null;
  let method: InstallMethod = "unknown";
  if (normReal.includes("/pnpm/global/") || (pnpmHome && normReal.startsWith(`${pnpmHome}/`))) {
    method = "pnpm";
  } else if (normReal.includes("/.yarn/global/") || normReal.includes("/yarn/global/")) {
    method = "yarn";
  } else if (normReal.includes("/.bun/install/global/")) {
    method = "bun";
  } else {
    const root = (opts.npmRootGlobal ?? (() => npmRootGlobalDefault({ which })))();
    if (root) {
      const normRoot = normalize(root).replace(/\/+$/, "");
      if (normReal.startsWith(`${normRoot}/`)) method = "npm";
    }
  }

  if (method === "unknown") return blocked("unknown", UNKNOWN_REASON);
  const manager = which(method);
  if (!manager) {
    return blocked(
      method,
      `This installation is managed by ${method}, but ${method} is not available on PATH.`,
    );
  }
  // The resolved path, not the bare name: see npmRootGlobalDefault.
  const [, ...args] = MANAGER_COMMANDS[method as keyof typeof MANAGER_COMMANDS];
  return { method, command: [manager, ...args], blockedReason: null };
}

/** The latest published Tavily CLI version, from the npm registry. */
export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  let data: unknown;
  try {
    const response = await fetchImpl(NPM_LATEST_URL, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch {
    throw new Error("Could not check npm for Tavily CLI updates.");
  }
  const version = (data as { version?: unknown } | null)?.version;
  try {
    if (typeof version !== "string") throw new Error();
    compareVersions(version, version);
  } catch {
    throw new Error("npm returned an invalid Tavily CLI version.");
  }
  return version as string;
}

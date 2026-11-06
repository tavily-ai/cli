/** Work out which package manager owns the running CLI, and how to upgrade it. */
import * as childProcess from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { compareVersions } from "../util/semver.js";
import { whichOnPath } from "./skills.js";

const NPM_LATEST_URL = "https://registry.npmjs.org/@tavily/cli/latest";
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

export type GlobalManager = "npm" | "pnpm" | "yarn" | "bun";

export const MANAGER_COMMANDS: Record<GlobalManager, string[]> = {
  npm: ["npm", "install", "-g", PACKAGE_SPEC],
  pnpm: ["pnpm", "add", "-g", PACKAGE_SPEC],
  yarn: ["yarn", "global", "add", PACKAGE_SPEC],
  bun: ["bun", "add", "-g", PACKAGE_SPEC],
};

/** How to run the CLI without a global install, per package manager. */
export const MANAGER_RUNNERS: Record<GlobalManager, string> = {
  npm: "npx @tavily/cli",
  pnpm: "pnpm dlx @tavily/cli",
  yarn: "yarn dlx @tavily/cli",
  bun: "bunx @tavily/cli",
};

/** The command that prints each manager's global bin directory (npm prints its prefix). */
const BIN_COMMANDS: Record<GlobalManager, string[]> = {
  npm: ["prefix", "-g"],
  pnpm: ["bin", "-g"],
  yarn: ["global", "bin"],
  bun: ["pm", "bin", "-g"],
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

interface ManagerDeps {
  which: (name: string) => string | null;
  spawnSync?: typeof childProcess.spawnSync;
  platform?: NodeJS.Platform;
}

/** Run `npm root -g` through npm's resolved PATH entry. */
export function npmRootGlobalDefault(deps: ManagerDeps): string | null {
  return managerOutput("npm", ["root", "-g"], deps);
}

/** The manager's global bin directory, where `tvly` lands after a global install. */
export function globalBinDir(manager: GlobalManager, deps: ManagerDeps): string | null {
  const out = managerOutput(manager, BIN_COMMANDS[manager], deps);
  if (!out) return null;
  return manager === "npm" && (deps.platform ?? process.platform) !== "win32" ? `${out}/bin` : out;
}

/**
 * Run a package manager through its resolved PATH entry and return trimmed stdout. Windows needs
 * `shell: true` for the .cmd shim, and a bare name there would also find a planted `npm.cmd` in
 * the current directory.
 */
function managerOutput(manager: string, args: string[], deps: ManagerDeps): string | null {
  const bin = deps.which(manager);
  if (!bin) return null;
  const win = (deps.platform ?? process.platform) === "win32";
  try {
    const r = (deps.spawnSync ?? childProcess.spawnSync)(win ? `"${bin}"` : bin, args, {
      encoding: "utf8",
      timeout: 15_000,
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

/** Which package manager launched this run (Firecrawl's heuristic, plus yarn). */
export function detectPackageManager(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  versions: NodeJS.ProcessVersions = process.versions,
): GlobalManager {
  // Install and runner paths identify the manager without lifecycle metadata.
  const entry = (argv[1] ?? "").replaceAll("\\", "/");
  if (/bunx[-/]|\/\.bun\//.test(entry)) return "bun";
  if (/\/pnpm\/(dlx|global)\//.test(entry)) return "pnpm";
  const hint = `${env.npm_config_user_agent ?? ""} ${env.npm_execpath ?? ""}`;
  if (/\bpnpm\b/i.test(hint)) return "pnpm";
  if (/\byarn\b/i.test(hint)) return "yarn";
  if (/\bbun\b/i.test(hint)) return "bun";
  if (versions.bun) return "bun";
  return "npm";
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
  const [, ...args] = MANAGER_COMMANDS[method as GlobalManager];
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

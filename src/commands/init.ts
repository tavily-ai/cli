/** tvly init — install tvly globally, authenticate, install Tavily skills, and verify. */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { getClientOrKeyless } from "../core/client-factory.js";
import {
  type ConfigOptions,
  getApiKey,
  hasStoredOauth,
  isOauthToken,
  saveApiKey,
  saveOauthSession,
} from "../core/config.js";
import {
  detectPackageManager,
  type GlobalManager,
  globalBinDir,
  MANAGER_COMMANDS,
  MANAGER_RUNNERS,
} from "../core/install-detect.js";
import { looksHeadless, runBrowserLogin } from "../core/oauth.js";
import {
  detectAgents,
  installAgentSkills,
  SKILLS_REPO,
  type SkillsInstallResult,
  whichOnPath,
} from "../core/skills.js";
import type { TavilyClientLike } from "../core/tavily-client.js";
import { ExitError } from "../errors.js";
import { sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";
import { VERSION } from "../version.js";
import { resolveJson } from "./shared.js";

export interface InitDeps extends ConfigOptions {
  login?: typeof runBrowserLogin;
  openImpl?: (url: string) => void;
  installSkills?: (agents: string[]) => Promise<SkillsInstallResult>;
  which?: (name: string) => string | null;
  stdinIsTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  client?: TavilyClientLike;
  spawnImpl?: typeof spawnSync;
  platform?: NodeJS.Platform;
}

export interface InitOptions {
  agent?: string[];
  all?: boolean;
  yes?: boolean;
  skipAuth?: boolean;
  skipSkills?: boolean;
  skipInstall?: boolean;
  apiKey?: string;
  browser?: boolean;
}

interface InitResult {
  ok: boolean;
  version: string;
  mode: string;
  auth: { authenticated: boolean; method: string };
  skills: { source: string; agents: string[]; restart_required: boolean; skipped: boolean };
  verification: { cli: boolean; auth: boolean; live_search: boolean };
  install: { global: boolean; manager: string | null; on_path: boolean; path_updated: boolean };
  error?: { stage: string; message: string };
}

async function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n]: `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function run(opts: InitOptions, cmd: Command, deps: InitDeps = {}): Promise<void> {
  const json = resolveJson(cmd);
  const requested = [...new Set((opts.agent ?? []).map((name) => name.toLowerCase()))];
  if (opts.all && requested.length) cmd.error("error: Use either --all or --agent, not both.");
  if (opts.skipAuth && opts.apiKey) {
    cmd.error("error: Use either --skip-auth or --api-key, not both.");
  }

  const which = deps.which ?? defaultWhich(deps.env ?? process.env);
  const step = await installStep(opts, json, which, deps);

  const agents = await selectAgents(requested, opts, json, deps);
  const result = emptyResult(agents);
  result.install = step.install;
  result.skills.skipped = opts.skipSkills === true || agents.length === 0;

  try {
    const auth = await ensureAuth(opts, deps);
    result.auth = auth;
    result.mode = auth.authenticated ? "authenticated" : "keyless";
    result.verification.auth = auth.authenticated;
  } catch (e) {
    return fail(result, "auth", messageOf(e), 3, json);
  }

  if (!result.skills.skipped) {
    try {
      const install = deps.installSkills ?? ((names) => installAgentSkills(names, deps));
      result.skills.restart_required = (await install(agents)).restartRequired;
    } catch (e) {
      return fail(result, "skills", messageOf(e), 1, json);
    }
  }

  result.verification.cli = result.install.on_path || result.install.global;
  if (!result.verification.cli && !opts.skipInstall && !step.failed) {
    return fail(result, "cli", "tvly is not available on PATH.", 1, json);
  }

  try {
    result.verification.live_search = await verifyLiveSearch(deps);
  } catch (e) {
    return fail(result, "live_search", messageOf(e), 4, json);
  }
  if (!result.verification.live_search) {
    return fail(result, "live_search", "Tavily search returned no result payload.", 4, json);
  }

  if (step.failed) {
    return fail(result, "install", INSTALL_INCOMPLETE, 1, json, step.pathNote);
  }
  result.ok = true;
  printResult(result, json, step.pathNote);
}

const INSTALL_INCOMPLETE =
  "Setup incomplete: global CLI installation failed. Other completed steps are preserved.";

/** `which` over the user's PATH, without the npx cache entry npx prepends for this run. */
function defaultWhich(env: NodeJS.ProcessEnv): (name: string) => string | null {
  const PATH = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => !dir.replace(/\\/g, "/").includes("/_npx/"))
    .join(path.delimiter);
  return (name) => whichOnPath(name, { ...env, PATH });
}

interface InstallStep {
  install: InitResult["install"];
  failed: boolean;
  pathNote: string | null;
}

/** Step 1 (Firecrawl's flow): install tvly globally unless it already resolves on PATH. */
async function installStep(
  opts: InitOptions,
  json: boolean,
  which: (name: string) => string | null,
  deps: InitDeps,
): Promise<InstallStep> {
  const onPath = () => which("tvly") !== null;
  const step: InstallStep = {
    install: { global: false, manager: null, on_path: onPath(), path_updated: false },
    failed: false,
    pathNote: null,
  };
  if (opts.skipInstall || step.install.on_path) return step;

  const interactive = !json && !opts.yes && (deps.stdinIsTTY ?? process.stdin.isTTY === true);
  if (interactive && !(await (deps.confirm ?? promptConfirm)("Install tvly globally?"))) {
    return step;
  }

  const manager = detectPackageManager(deps.env ?? process.env);
  const platform = deps.platform ?? process.platform;
  const win = platform === "win32";
  step.install.manager = manager;
  const [name, ...args] = MANAGER_COMMANDS[manager];
  const bin = which(name as string);
  const r = bin
    ? (deps.spawnImpl ?? spawnSync)(win ? `"${bin}"` : bin, args, {
        stdio: json ? ["ignore", 2, 2] : "inherit",
        shell: win,
      })
    : null;
  if (r?.status !== 0) {
    err(`Failed to install @tavily/cli globally using ${manager}.`);
    err(`Retry: ${MANAGER_COMMANDS[manager].join(" ")}`);
    err(`You can run without a global install: ${MANAGER_RUNNERS[manager]} <command>`);
    step.failed = true;
    return step;
  }
  step.install.global = true;
  step.install.on_path = onPath();
  if (!step.install.on_path) {
    step.pathNote = await fixPath(manager, interactive, which, deps, platform);
    step.install.path_updated = step.pathNote !== null;
  }
  return step;
}

/** Shell rc file for a PATH export, as Firecrawl picks it. */
function rcFileForShell(shell: string, platform: NodeJS.Platform): string {
  if (shell.includes("zsh")) return "~/.zshrc";
  if (shell.includes("fish")) return "~/.config/fish/config.fish";
  if (shell.includes("bash")) return platform === "darwin" ? "~/.bash_profile" : "~/.bashrc";
  return "~/.profile";
}

/**
 * tvly installed but its bin dir is not on PATH. Offer to append it to the shell rc file, or
 * print the exact fix. Returns the summary line when the rc file was updated.
 */
async function fixPath(
  manager: GlobalManager,
  interactive: boolean,
  which: (name: string) => string | null,
  deps: InitDeps,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const bin = globalBinDir(manager, {
    which,
    platform,
    ...(deps.spawnImpl ? { spawnSync: deps.spawnImpl } : {}),
  });
  err("");
  err(`tvly was installed but isn't on your PATH yet.`);
  if (bin && platform === "win32") {
    err("Add this directory to your PATH, then open a new terminal:");
    err(`  ${bin}`);
  } else if (bin) {
    const rc = rcFileForShell((deps.env ?? process.env).SHELL ?? "", platform);
    const line = rc.includes("fish") ? `fish_add_path ${bin}` : `export PATH="${bin}:$PATH"`;
    const question = `Add ${bin} to PATH in ${rc}?`;
    if (interactive && (await (deps.confirm ?? promptConfirm)(question))) {
      const file = path.join(deps.home ?? homedir(), rc.slice(2));
      if (!existsSync(file) || !readFileSync(file, "utf8").includes(line)) {
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `\n# Added by tvly init\n${line}\n`);
      }
      err("Restart your terminal, then run tvly.");
      return `Added ${bin} to PATH in ${rc}`;
    }
    err("Add it to your shell, then restart your terminal:");
    err(`  echo '${line}' >> ${rc}`);
  } else {
    err(`Add your ${manager} global bin directory to PATH.`);
  }
  err(`Until then you can still run: ${MANAGER_RUNNERS[manager]} <command>`);
  return null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function selectAgents(
  requested: string[],
  opts: InitOptions,
  json: boolean,
  deps: InitDeps,
): Promise<string[]> {
  if (opts.skipSkills) return [];
  if (requested.length) return requested;

  const detected: string[] = detectAgents(deps);
  const isTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true;
  if (!detected.length || opts.all || opts.yes || json || !isTTY) return detected;

  const ok = await (deps.confirm ?? promptConfirm)(
    `Install Tavily skills for detected agents (${detected.join(", ")})?`,
  );
  return ok ? detected : [];
}

async function ensureAuth(
  opts: InitOptions,
  deps: InitDeps,
): Promise<{ authenticated: boolean; method: string }> {
  const config: ConfigOptions = {
    ...(deps.home !== undefined ? { home: deps.home } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  if (opts.apiKey) await saveApiKey(opts.apiKey, config);
  const key = await getApiKey(config);
  if (key) return { authenticated: true, method: authMethod(key, config) };
  if (opts.skipAuth) return { authenticated: false, method: "none" };

  const isTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true;
  if (opts.browser === undefined && !isTTY) {
    throw new Error(
      "No Tavily credential found. Use --api-key, --browser, --no-browser, or --skip-auth in non-interactive runs.",
    );
  }

  const openBrowser = opts.browser ?? !looksHeadless(deps.env);
  const session = await (deps.login ?? runBrowserLogin)({
    openBrowser,
    onStatus: (url: string) => err(`Open this URL to authenticate: ${sanitizeControl(url)}`),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.openImpl ? { openImpl: deps.openImpl } : {}),
  });
  await saveOauthSession(session, config);
  return { authenticated: true, method: "oauth" };
}

function authMethod(key: string, config: ConfigOptions): string {
  if ((config.env ?? process.env).TAVILY_API_KEY) return "env";
  if (isOauthToken(key)) return hasStoredOauth(config) ? "oauth" : "oauth_legacy";
  return "api_key";
}

async function verifyLiveSearch(deps: InitDeps): Promise<boolean> {
  const client =
    deps.client ?? (await getClientOrKeyless({ clientName: "tavily-cli-init" })).client;
  const response = await client.search({ query: "Tavily Search API", max_results: 1 });
  return Array.isArray((response as { results?: unknown } | null)?.results);
}

function emptyResult(agents: string[]): InitResult {
  return {
    ok: false,
    version: VERSION,
    mode: "unknown",
    auth: { authenticated: false, method: "none" },
    skills: { source: SKILLS_REPO, agents, restart_required: false, skipped: false },
    verification: { cli: false, auth: false, live_search: false },
    install: { global: false, manager: null, on_path: false, path_updated: false },
  };
}

function fail(
  result: InitResult,
  stage: string,
  message: string,
  code: number,
  json: boolean,
  pathNote: string | null = null,
): never {
  result.error = { stage, message };
  printResult(result, json, pathNote);
  throw new ExitError(code);
}

function printResult(result: InitResult, json: boolean, pathNote: string | null = null): void {
  if (json) {
    out(JSON.stringify(result));
    return;
  }
  out();
  if (!result.ok) {
    const message = sanitizeControl(result.error?.message ?? "Initialization failed.");
    out(`  ${colors.pink("> Setup failed:")} ${message}`);
    out();
    return;
  }
  out(`  ${colors.green("> Tavily is ready")}`);

  const { auth, skills } = result;
  if (auth.authenticated) out(`    ${colors.green("✓")} Authenticated via ${auth.method}`);
  else out(`    ${colors.yellow("•")} Keyless mode`);

  if (skills.skipped) out(`    ${colors.dim("• Skills skipped")}`);
  else out(`    ${colors.green("✓")} Tavily skills ready for ${skills.agents.join(", ")}`);
  out(`    ${colors.green("✓")} Live search verified`);
  if (result.install.global) {
    out(`    ${colors.green("✓")} tvly installed globally (${result.install.manager})`);
  }
  if (pathNote) out(`    ${colors.green("✓")} ${pathNote}`);

  if (skills.restart_required) {
    out();
    out(`    ${colors.dim(`Restart ${skills.agents.join(", ")} to load newly installed skills.`)}`);
  }

  out();
  out("  Try:");
  out(`    ${colors.green('tvly search "latest AI news"')}`);
  out(`    ${colors.green("tvly extract https://example.com")}`);
  out(`    ${colors.green('tvly research "your topic"')}`);
  out();
}

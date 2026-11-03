/** tvly init — authenticate, install Tavily skills, and verify a working CLI. */
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
}

export interface InitOptions {
  agent?: string[];
  all?: boolean;
  yes?: boolean;
  skipAuth?: boolean;
  skipSkills?: boolean;
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

  const agents = await selectAgents(requested, opts, json, deps);
  const result = emptyResult(agents);
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

  const which = deps.which ?? ((name) => whichOnPath(name, deps.env));
  result.verification.cli = which("tvly") !== null;
  if (!result.verification.cli) {
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

  result.ok = true;
  printResult(result, json);
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
  };
}

function fail(
  result: InitResult,
  stage: string,
  message: string,
  code: number,
  json: boolean,
): never {
  result.error = { stage, message };
  printResult(result, json);
  throw new ExitError(code);
}

function printResult(result: InitResult, json: boolean): void {
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

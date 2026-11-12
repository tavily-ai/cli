/** tvly init — install tvly globally, authenticate, install Tavily skills and workflows, and verify. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { intro, log, outro, spinner } from "@clack/prompts";
import type { Command } from "commander";
import { authMethod, getApiKey, saveApiKey, saveOauthSession } from "../core/config.js";
import {
  detectPackageManager,
  type GlobalManager,
  globalBinDir,
  MANAGER_COMMANDS,
  MANAGER_RUNNERS,
} from "../core/install-detect.js";
import { installMcp, MCP_AUTH_NOTE, type McpSetupResult } from "../core/mcp-setup.js";
import { looksHeadless, runBrowserLogin } from "../core/oauth.js";
import { detectAgents, installAgentSkills, SKILLS_REPO, WORKFLOWS_REPO } from "../core/skills.js";
import { ExitError, messageOf } from "../errors.js";
import type { Host } from "../host.js";
import type { Choice } from "../ui/prompts.js";
import { sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";
import { VERSION } from "../version.js";
import type { LoginHooks } from "./auth.js";
import { resolveJson } from "./options.js";

export interface InitOptions {
  agent?: string[];
  yes?: boolean;
  skipAuth?: boolean;
  skipSkills?: boolean;
  skipWorkflows?: boolean;
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
  workflows: { source: string; agents: string[]; restart_required: boolean; skipped: boolean };
  mcp: { agents: string[]; skipped: boolean };
  verification: { cli: boolean; auth: boolean; live_search: boolean };
  install: { global: boolean; manager: string | null; on_path: boolean; path_updated: boolean };
  error?: { stage: string; message: string };
}

export async function run(
  opts: InitOptions,
  cmd: Command,
  host: Host,
  hooks: LoginHooks = {},
): Promise<void> {
  const json = resolveJson(cmd);
  const requested = [...new Set((opts.agent ?? []).map((name) => name.toLowerCase()))];
  if (opts.skipAuth && opts.apiKey) {
    cmd.error("error: Use either --skip-auth or --api-key, not both.");
  }
  const interactive = host.stdinIsTTY && !json && !opts.yes;
  if (interactive) intro("tvly init", { output });

  const cli = await installStep(opts, json, host);
  const result = emptyResult();
  result.install = cli.install;
  let mcpSetup: McpSetupResult | null = null;

  try {
    const auth = await ensureAuth(opts, interactive, host, hooks);
    result.auth = auth;
    result.mode = auth.authenticated ? "authenticated" : "keyless";
    result.verification.auth = auth.authenticated;
  } catch (e) {
    if (e instanceof ExitError) throw e;
    return fail(result, "auth", messageOf(e), 3, json);
  }

  const picked = await plan(requested, opts, interactive, host);
  const agents = picked.agents.join(", ");
  for (const stage of ["skills", "workflows"] as const) {
    if (!picked[stage]) continue;
    const part = result[stage];
    part.agents = picked.agents;
    part.skipped = false;
    const { label } = BUNDLES[stage];
    try {
      const installed = await step(interactive, `Installing ${label}`, `${label} → ${agents}`, () =>
        installAgentSkills(part.source, picked.agents, host),
      );
      part.restart_required = installed.restartRequired;
    } catch (e) {
      return fail(result, stage, messageOf(e), 1, json);
    }
  }
  if (picked.mcp) {
    const { label } = BUNDLES.mcp;
    try {
      mcpSetup = await step(interactive, `Adding the ${label}`, `${label} → ${agents}`, () =>
        installMcp(picked.agents, false, host),
      );
      result.mcp = { agents: mcpSetup.configured, skipped: mcpSetup.configured.length === 0 };
    } catch (e) {
      return fail(result, "mcp", messageOf(e), 1, json);
    }
  }

  result.verification.cli = result.install.on_path || result.install.global;
  if (!result.verification.cli && !opts.skipInstall && !cli.failed) {
    return fail(result, "cli", "tvly is not available on PATH.", 1, json);
  }

  try {
    await step(interactive, "Verifying live search", "Live search verified", async () => {
      if (!(await verifyLiveSearch(host))) {
        throw new Error("Tavily search returned no result payload.");
      }
    });
    result.verification.live_search = true;
  } catch (e) {
    return fail(result, "live_search", messageOf(e), 4, json);
  }

  if (cli.failed) {
    return fail(result, "install", INSTALL_INCOMPLETE, 1, json, cli.pathNote);
  }
  result.ok = true;
  if (interactive) outro("Setup complete", { output });
  printResult(result, json, cli.pathNote, mcpSetup);
}

/** Prompts and spinners draw on stderr; stdout stays for the summary and --json. */
const output = process.stderr;

type Bundle = "skills" | "workflows" | "mcp";

const BUNDLES: Record<Bundle, Choice<Bundle>> = {
  skills: { value: "skills", label: "Tavily skills", hint: "search, extract, crawl, research" },
  workflows: { value: "workflows", label: "Official workflows" },
  mcp: { value: "mcp", label: "MCP server", hint: "hosted, signs in with OAuth" },
};

/** Run `fn` under a spinner when interactive: `label` while it runs, `done` or the error after. */
async function step<T>(
  interactive: boolean,
  label: string,
  done: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!interactive) return fn();
  const s = spinner({ output });
  s.start(label);
  try {
    const value = await fn();
    s.stop(done);
    return value;
  } catch (e) {
    s.error(messageOf(e));
    throw e;
  }
}

/**
 * Which agents get which bundles. Defaults (taken by --yes, non-TTY runs, and pre-checked in the
 * pickers): every detected agent, or the --agent list; skills and MCP, not workflows.
 * --skip-skills leaves coding agents alone entirely: no skills, workflows, or MCP.
 */
async function plan(
  requested: string[],
  opts: InitOptions,
  interactive: boolean,
  host: Host,
): Promise<{ agents: string[]; skills: boolean; workflows: boolean; mcp: boolean }> {
  const none = { agents: [], skills: false, workflows: false, mcp: false };
  if (opts.skipSkills) return none;
  const candidates = requested.length ? requested : detectAgents(host);
  if (!candidates.length) {
    if (interactive) {
      log.warn("No coding agents found. Skills and MCP need Claude Code, Cursor, or Codex.", {
        output,
      });
    }
    return none;
  }
  const agents =
    interactive && !requested.length
      ? await host.prompt.multiselect(
          "Set up which agents?",
          candidates.map((a) => ({ value: a, label: a })),
          candidates,
        )
      : candidates;
  if (!agents.length) return none;

  const choices = [BUNDLES.skills, ...(opts.skipWorkflows ? [] : [BUNDLES.workflows]), BUNDLES.mcp];
  const defaults = choices.map((c) => c.value).filter((v) => v !== "workflows");
  const bundles = interactive
    ? await host.prompt.multiselect("What should I install?", choices, defaults)
    : defaults;
  return {
    agents,
    skills: bundles.includes("skills"),
    workflows: bundles.includes("workflows"),
    mcp: bundles.includes("mcp"),
  };
}

const INSTALL_INCOMPLETE =
  "Setup incomplete: global CLI installation failed. Other completed steps are preserved.";

interface InstallStep {
  install: InitResult["install"];
  failed: boolean;
  pathNote: string | null;
}

/** Step 1 (Firecrawl's flow): install tvly globally unless it already resolves on PATH. */
async function installStep(opts: InitOptions, json: boolean, host: Host): Promise<InstallStep> {
  const onPath = () => host.exec.which("tvly") !== null;
  const step: InstallStep = {
    install: { global: false, manager: null, on_path: onPath(), path_updated: false },
    failed: false,
    pathNote: null,
  };
  if (opts.skipInstall || step.install.on_path) return step;

  const interactive = !json && !opts.yes && host.stdinIsTTY;
  if (interactive && !(await host.prompt.confirm("Install tvly globally?"))) return step;

  const manager = detectPackageManager(host);
  step.install.manager = manager;
  const [name, ...args] = MANAGER_COMMANDS[manager];
  const bin = host.exec.which(name as string);
  // The install streams to the terminal; a --json run keeps stdout for the result.
  if (!bin || !host.exec.run(bin, args, { inherit: json ? "stderr" : true }).ok) {
    err(`Failed to install @tavily/cli globally using ${manager}.`);
    err(`Retry: ${MANAGER_COMMANDS[manager].join(" ")}`);
    err(`You can run without a global install: ${MANAGER_RUNNERS[manager]} <command>`);
    step.failed = true;
    return step;
  }
  step.install.global = true;
  step.install.on_path = onPath();
  if (!step.install.on_path) {
    step.pathNote = await fixPath(manager, interactive, host);
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
  host: Host,
): Promise<string | null> {
  const bin = globalBinDir(manager, host);
  err("");
  err(`tvly was installed but isn't on your PATH yet.`);
  if (bin && host.platform === "win32") {
    err("Add this directory to your PATH, then open a new terminal:");
    err(`  ${bin}`);
  } else if (bin) {
    const rc = rcFileForShell(host.env.SHELL ?? "", host.platform);
    const line = rc.includes("fish") ? `fish_add_path ${bin}` : `export PATH="${bin}:$PATH"`;
    const question = `Add ${bin} to PATH in ${rc}?`;
    if (interactive && (await host.prompt.confirm(question))) {
      const file = path.join(host.home, rc.slice(2));
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

async function ensureAuth(
  opts: InitOptions,
  interactive: boolean,
  host: Host,
  hooks: LoginHooks,
): Promise<{ authenticated: boolean; method: string }> {
  if (opts.apiKey) await saveApiKey(opts.apiKey, host);
  const key = await getApiKey(host);
  if (key) return { authenticated: true, method: authMethod(key, host) };
  if (opts.skipAuth) return { authenticated: false, method: "none" };

  // --browser / --no-browser already chose browser login, so only ask when neither was given.
  if (interactive && opts.browser === undefined) {
    const method = await host.prompt.select(
      "How do you want to sign in?",
      [
        { value: "browser", label: "Browser login", hint: "recommended" },
        { value: "key", label: "Paste an API key" },
        { value: "keyless", label: "Continue without a key", hint: "rate-limited" },
      ],
      "browser",
    );
    if (method === "key") {
      await saveApiKey((await host.prompt.password("API key")).trim(), host);
      return { authenticated: true, method: "api_key" };
    }
    if (method === "keyless") return { authenticated: false, method: "none" };
  }

  if (opts.browser === undefined && !host.stdinIsTTY) {
    throw new Error(
      "No Tavily credential found. Use --api-key, --browser, --no-browser, or --skip-auth in non-interactive runs.",
    );
  }

  const openBrowser = opts.browser ?? !looksHeadless(host.env, host.platform);
  const session = await (hooks.login ?? runBrowserLogin)({
    openBrowser,
    onStatus: (url: string) => err(`Open this URL to authenticate: ${sanitizeControl(url)}`),
    fetchImpl: host.fetch,
    openImpl: host.openUrl,
  });
  await saveOauthSession(session, host);
  return { authenticated: true, method: "oauth" };
}

async function verifyLiveSearch(host: Host): Promise<boolean> {
  const client = await host.resolveClient(await getApiKey(host), "tavily-cli-init");
  const response = await client.search({ query: "Tavily Search API", max_results: 1 });
  return Array.isArray((response as { results?: unknown } | null)?.results);
}

function emptyResult(): InitResult {
  return {
    ok: false,
    version: VERSION,
    mode: "unknown",
    auth: { authenticated: false, method: "none" },
    skills: { source: SKILLS_REPO, agents: [], restart_required: false, skipped: true },
    workflows: { source: WORKFLOWS_REPO, agents: [], restart_required: false, skipped: true },
    mcp: { agents: [], skipped: true },
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

function printResult(
  result: InitResult,
  json: boolean,
  pathNote: string | null = null,
  mcp: McpSetupResult | null = null,
): void {
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

  const { auth, skills, workflows } = result;
  if (auth.authenticated) out(`    ${colors.green("✓")} Authenticated via ${auth.method}`);
  else out(`    ${colors.yellow("•")} Keyless mode`);

  if (skills.skipped) out(`    ${colors.dim("• Skills skipped")}`);
  else out(`    ${colors.green("✓")} Tavily skills ready for ${skills.agents.join(", ")}`);
  if (workflows.skipped) out(`    ${colors.dim("• Workflows skipped")}`);
  else out(`    ${colors.green("✓")} Tavily workflows ready for ${workflows.agents.join(", ")}`);
  if (mcp) {
    if (mcp.configured.length) {
      out(`    ${colors.green("✓")} Tavily MCP server ready for ${mcp.configured.join(", ")}`);
    }
    for (const { agent, reason } of mcp.skipped) {
      out(`    ${colors.dim(`• MCP skipped for ${agent} (${sanitizeControl(reason)})`)}`);
    }
  }
  out(`    ${colors.green("✓")} Live search verified`);
  if (result.install.global) {
    out(`    ${colors.green("✓")} tvly installed globally (${result.install.manager})`);
  }
  if (pathNote) out(`    ${colors.green("✓")} ${pathNote}`);

  if (skills.restart_required || workflows.restart_required) {
    const restart = skills.restart_required ? skills.agents : workflows.agents;
    out();
    out(`    ${colors.dim(`Restart ${restart.join(", ")} to load newly installed skills.`)}`);
  }
  if (mcp?.configured.length) {
    out();
    out(`    ${colors.dim(MCP_AUTH_NOTE[mcp.auth])}`);
  }

  out();
  out("  Try:");
  out(`    ${colors.green('tvly search "latest AI news"')}`);
  out(`    ${colors.green("tvly extract https://example.com")}`);
  out(`    ${colors.green('tvly research "your topic"')}`);
  out(`    Or ask your agent: "search for the latest AI news"`);
  if (result.mcp.skipped) {
    out();
    out("  Add the hosted Tavily MCP server to your agents:");
    out(`    ${colors.green("tvly setup mcp")}`);
  }
  out();
}

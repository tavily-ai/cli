/** tvly init — install tvly globally, authenticate, install Tavily skills and workflows, and verify. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { authMethod, getApiKey, saveApiKey, saveOauthSession } from "../core/config.js";
import {
  detectPackageManager,
  type GlobalManager,
  globalBinDir,
  MANAGER_RUNNERS,
  managerCommand,
} from "../core/install-detect.js";
import { installMcp, MCP_AUTH_NOTE, type McpSetupResult } from "../core/mcp-setup.js";
import { looksHeadless, runBrowserLogin } from "../core/oauth.js";
import { detectAgents, installAgentSkills, SKILLS_REPO, WORKFLOWS_REPO } from "../core/skills.js";
import { ExitError, messageOf } from "../errors.js";
import type { Host } from "../host.js";
import { sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";
import { VERSION } from "../version.js";
import type { LoginHooks } from "./auth.js";
import { resolveJson } from "./options.js";

export interface InitOptions {
  agent?: string[];
  all?: boolean;
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
  if (opts.all && requested.length) cmd.error("error: Use either --all or --agent, not both.");
  if (opts.skipAuth && opts.apiKey) {
    cmd.error("error: Use either --skip-auth or --api-key, not both.");
  }

  const step = await installStep(opts, json, host);

  const { agents, skills, workflows, mcp } = await selectAgents(requested, opts, json, host);
  const result = emptyResult(skills ? agents : [], workflows ? agents : []);
  result.install = step.install;
  let mcpSetup: McpSetupResult | null = null;

  try {
    const auth = await ensureAuth(opts, host, hooks);
    result.auth = auth;
    result.mode = auth.authenticated ? "authenticated" : "keyless";
    result.verification.auth = auth.authenticated;
  } catch (e) {
    return fail(result, "auth", messageOf(e), 3, json);
  }

  for (const stage of ["skills", "workflows"] as const) {
    const part = result[stage];
    if (part.skipped) continue;
    try {
      const installed = await installAgentSkills(part.source, part.agents, host);
      part.restart_required = installed.restartRequired;
    } catch (e) {
      return fail(result, stage, messageOf(e), 1, json);
    }
  }
  if (mcp) {
    try {
      mcpSetup = await installMcp(agents, false, host);
      result.mcp = { agents: mcpSetup.configured, skipped: mcpSetup.configured.length === 0 };
    } catch (e) {
      return fail(result, "mcp", messageOf(e), 1, json);
    }
  }

  result.verification.cli = result.install.on_path || result.install.global;
  if (!result.verification.cli && !opts.skipInstall && !step.failed) {
    return fail(result, "cli", "tvly is not available on PATH.", 1, json);
  }

  try {
    result.verification.live_search = await verifyLiveSearch(host);
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
  printResult(result, json, step.pathNote, mcpSetup);
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
  if (interactive && !(await host.confirm("Install tvly globally?"))) return step;

  const manager = detectPackageManager(host);
  step.install.manager = manager;
  const command = managerCommand(manager, host.env);
  const [name, ...args] = command;
  const bin = host.exec.which(name as string);
  // The install streams to the terminal; a --json run keeps stdout for the result.
  if (!bin || !host.exec.run(bin, args, { inherit: json ? "stderr" : true }).ok) {
    err(`Failed to install @tavily/cli globally using ${manager}.`);
    err(`Retry: ${command.join(" ")}`);
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
    if (interactive && (await host.confirm(question))) {
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

async function selectAgents(
  requested: string[],
  opts: InitOptions,
  json: boolean,
  host: Host,
): Promise<{ agents: string[]; skills: boolean; workflows: boolean; mcp: boolean }> {
  const agents: string[] = requested.length ? requested : detectAgents(host);

  const interactive = agents.length > 0 && !opts.yes && !json && host.stdinIsTTY;
  const ask = interactive && !requested.length && !opts.all;
  const skills =
    !opts.skipSkills &&
    (!ask ||
      (await host.confirm(`Install Tavily skills for detected agents (${agents.join(", ")})?`)));
  const workflows =
    !opts.skipSkills &&
    !opts.skipWorkflows &&
    (!ask || (await host.confirm(`Install the Tavily official workflows (${WORKFLOWS_REPO})?`)));
  // MCP is opt-in: only an explicit yes at the prompt configures it.
  const mcp =
    interactive &&
    (await host.confirm(
      `Add the Tavily MCP server to ${agents.join(", ")} (hosted, signs in with OAuth)?`,
      false,
    ));
  return { agents, skills, workflows, mcp };
}

async function ensureAuth(
  opts: InitOptions,
  host: Host,
  hooks: LoginHooks,
): Promise<{ authenticated: boolean; method: string }> {
  if (opts.apiKey) await saveApiKey(opts.apiKey, host);
  const key = await getApiKey(host);
  if (key) return { authenticated: true, method: authMethod(key, host) };
  if (opts.skipAuth) return { authenticated: false, method: "none" };

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

function emptyResult(skillsAgents: string[], workflowsAgents: string[]): InitResult {
  return {
    ok: false,
    version: VERSION,
    mode: "unknown",
    auth: { authenticated: false, method: "none" },
    skills: {
      source: SKILLS_REPO,
      agents: skillsAgents,
      restart_required: false,
      skipped: skillsAgents.length === 0,
    },
    workflows: {
      source: WORKFLOWS_REPO,
      agents: workflowsAgents,
      restart_required: false,
      skipped: workflowsAgents.length === 0,
    },
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
  if (result.mcp.skipped) {
    out();
    out("  Add the hosted Tavily MCP server to your agents:");
    out(`    ${colors.green("tvly setup mcp")}`);
  }
  out();
}

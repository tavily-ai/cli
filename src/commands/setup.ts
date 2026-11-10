/** tvly setup mcp — add the hosted Tavily MCP server to coding agents. */
import type { Command } from "commander";
import { AGENT_NAMES } from "../core/agent-names.js";
import { installMcp, MCP_AUTH_NOTE, type McpSetupResult } from "../core/mcp-setup.js";
import { detectAgents, type SkillsDeps } from "../core/skills.js";
import { ExitError } from "../errors.js";
import { sanitizeControl } from "../ui/text.js";
import { colors, out } from "../ui/theme.js";
import { resolveJson } from "./options.js";

export interface McpOptions {
  agent?: string[];
  keyless?: boolean;
}

export interface McpDeps extends SkillsDeps {
  installMcp?: typeof installMcp;
}

export async function runMcp(opts: McpOptions, cmd: Command, deps: McpDeps = {}): Promise<void> {
  const json = resolveJson(cmd);
  const { installMcp: install = installMcp, ...setupDeps } = deps;
  const requested = opts.agent ?? [];
  const agents = requested.includes("all")
    ? [...AGENT_NAMES]
    : requested.length
      ? [...new Set(requested)]
      : detectAgents(setupDeps);
  const result = await install(agents, { keyless: opts.keyless === true, ...setupDeps });
  const ok = agents.length === 0 || result.configured.length > 0;
  printMcp(result, ok, json);
  if (!ok) throw new ExitError(1);
}

function printMcp(result: McpSetupResult, ok: boolean, json: boolean): void {
  if (json) {
    out(JSON.stringify({ ok, ...result }));
    return;
  }
  for (const agent of result.configured) {
    out(`  ${colors.green("✓")} ${agent}: Tavily MCP server added`);
  }
  for (const { agent, reason } of result.skipped) {
    out(`  ${colors.dim("•")} ${agent}: skipped (${sanitizeControl(reason)})`);
  }
  if (result.configured.length) out(`  ${colors.dim(MCP_AUTH_NOTE[result.auth])}`);
  else if (!result.skipped.length) {
    out(`  ${colors.dim("No supported agents detected. Use --agent <name> or --agent all.")}`);
  }
}

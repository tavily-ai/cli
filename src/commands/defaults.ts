/** tvly set-default / unset-default — toggle agents' built-in web search. */
import { type Command, InvalidArgumentError } from "commander";
import {
  claudeSettingsPath,
  codexConfigPath,
  type PathContext,
  setClaudeDefault,
  setCodexDefault,
  unsetClaudeDefault,
  unsetCodexDefault,
} from "../core/agent-defaults.js";
import type { Host } from "../host.js";
import { colors, out } from "../ui/theme.js";
import { resolveJson } from "./options.js";

type Agent = "claude" | "codex";

export interface DefaultsOptions {
  claude?: boolean;
  codex?: boolean;
  project?: boolean;
}

type DefaultsHost = Pick<Host, "home" | "env" | "cwd" | "stdinIsTTY" | "confirm">;

interface Mode {
  verb: string;
  actions: Record<Agent, (path: string) => boolean>;
  changedMessage: string;
  unchangedMessage: string;
  codexNote?: string;
}

const TARGETS: Record<Agent, { label: string; path: (ctx: PathContext) => string }> = {
  claude: { label: "Claude Code", path: claudeSettingsPath },
  codex: { label: "Codex", path: codexConfigPath },
};

const SET: Mode = {
  verb: "Make Tavily the default web tool",
  actions: { claude: setClaudeDefault, codex: setCodexDefault },
  changedMessage: "built-in web search disabled",
  unchangedMessage: "built-in web search already disabled",
  codexNote: "Codex only reads project config in projects you have marked as trusted.",
};

const UNSET: Mode = {
  verb: "Restore built-in web search",
  actions: { claude: unsetClaudeDefault, codex: unsetCodexDefault },
  changedMessage: "built-in web search restored",
  unchangedMessage: "nothing to undo",
};

async function selectTargets(
  opts: DefaultsOptions,
  mode: Mode,
  json: boolean,
  cmd: Command,
  host: DefaultsHost,
): Promise<Agent[]> {
  if (opts.claude || opts.codex) {
    return (["claude", "codex"] as const).filter((agent) => opts[agent]);
  }
  if (json || !host.stdinIsTTY) {
    return cmd.error("error: Pass --claude and/or --codex in non-interactive runs.");
  }
  const selected: Agent[] = [];
  for (const agent of ["claude", "codex"] as const) {
    const scope = opts.project ? " in this project" : "";
    if (await host.confirm(`${mode.verb} for ${TARGETS[agent].label}${scope}?`)) {
      selected.push(agent);
    }
  }
  return selected;
}

async function execute(
  opts: DefaultsOptions,
  cmd: Command,
  host: DefaultsHost,
  mode: Mode,
): Promise<void> {
  const json = resolveJson(cmd);
  const project = opts.project === true;
  const targets = await selectTargets(opts, mode, json, cmd, host);

  const results = [];
  try {
    for (const agent of targets) {
      const { label, path: pathFor } = TARGETS[agent];
      const path = pathFor({ ...host, project });
      const changed = mode.actions[agent](path);
      results.push({ agent, label, scope: project ? "project" : "global", path, changed });
    }
  } catch (e) {
    if (e instanceof InvalidArgumentError) cmd.error(`error: ${e.message}`);
    throw e;
  }

  if (json) {
    out(JSON.stringify({ ok: true, results }));
    return;
  }
  if (results.length === 0) {
    out(`  ${colors.dim("Nothing selected.")}`);
    return;
  }
  for (const r of results) {
    const message = r.changed ? mode.changedMessage : mode.unchangedMessage;
    const mark = r.changed ? colors.green("✓") : colors.dim("•");
    out(`  ${mark} ${r.label}: ${message} ${colors.dim(`(${r.path})`)}`);
  }
  if (results.some((r) => r.changed)) {
    out(`  ${colors.dim("Restart the agent for the change to take effect.")}`);
  }
  if (project && mode.codexNote && results.some((r) => r.agent === "codex" && r.changed)) {
    out(`  ${colors.dim(mode.codexNote)}`);
  }
}

export const runSetDefault = (
  opts: DefaultsOptions,
  cmd: Command,
  host: DefaultsHost,
): Promise<void> => execute(opts, cmd, host, SET);

export const runUnsetDefault = (
  opts: DefaultsOptions,
  cmd: Command,
  host: DefaultsHost,
): Promise<void> => execute(opts, cmd, host, UNSET);

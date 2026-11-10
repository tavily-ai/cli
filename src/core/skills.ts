/**
 * Install Tavily's maintained agent skills with the skills.sh CLI (`npx skills`).
 *
 * Installs track the latest published skills and are counted on skills.sh.
 */

import type { SpawnSyncReturns } from "node:child_process";
import * as childProcess from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { failureOf, runManager, type SpawnFn, whichOnPath } from "../util/process.js";
import type { AGENT_NAMES } from "./agent-names.js";

export const SKILLS_REPO = "tavily-ai/skills";
export const WORKFLOWS_REPO = "tavily-ai/official-workflows";
// Exact versions: npx runs whatever these resolve to with the user's permissions.
const NPX_SKILLS_PACKAGE = "skills@1.7.4";
export const NPX_ADD_MCP_PACKAGE = "add-mcp@1.14.0";

export type AgentName = (typeof AGENT_NAMES)[number];

export interface SkillsInstallResult {
  agents: string[];
  restartRequired: boolean;
}

interface SkillsOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SkillsDeps extends SkillsOptions {
  which?: (name: string) => string | null;
  spawnImpl?: SpawnFn;
  platform?: NodeJS.Platform;
  execPath?: string;
  existsSync?: (p: string) => boolean;
}

/** Each supported agent's configuration directory under the current user's home. */
function agentRoots(opts: SkillsOptions = {}): Record<AgentName, string> {
  const root = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  return {
    "claude-code": env.CLAUDE_CONFIG_DIR || path.join(root, ".claude"),
    codex: env.CODEX_HOME || path.join(root, ".codex"),
    cursor: path.join(root, ".cursor"),
  };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Detect supported agents from their existing configuration directories. */
export function detectAgents(opts: SkillsOptions = {}): AgentName[] {
  return (Object.entries(agentRoots(opts)) as [AgentName, string][])
    .filter(([, dir]) => isDir(dir))
    .map(([name]) => name);
}

/**
 * Run npx with `args`, without a shell where possible so the arguments reach the package as
 * given. Null when npx is not on PATH.
 */
export function runNpx(args: string[], deps: SkillsDeps): SpawnSyncReturns<string | Buffer> | null {
  const which = deps.which ?? ((name: string) => whichOnPath(name, deps.env));
  const npx = which("npx");
  if (!npx) return null;
  const spawnImpl = deps.spawnImpl ?? childProcess.spawnSync;
  // Windows: spawning a .cmd with shell:false throws EINVAL on Node 20.12.2+,
  // so run npm's npx-cli.js through node; fall back to the shell for the .cmd.
  const win = (deps.platform ?? process.platform) === "win32";
  const execPath = deps.execPath ?? process.execPath;
  const npxCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return win && (deps.existsSync ?? existsSync)(npxCli)
    ? runManager(spawnImpl, execPath, [npxCli, ...args], false)
    : runManager(spawnImpl, npx, args, win);
}

/** Install every skill in a skills repo (Tavily skills or workflows) for the selected agents. */
export async function installAgentSkills(
  repo: string,
  agents: string[],
  deps: SkillsDeps = {},
): Promise<SkillsInstallResult> {
  // npx writes to the shared directory, or straight into an agent's own
  // directory when that agent is the only target.
  const roots = agentRoots(deps) as Record<string, string>;
  const skillDirs = [
    path.join(deps.home ?? homedir(), ".agents", "skills"),
    ...agents.flatMap((name) => (roots[name] ? [path.join(roots[name], "skills")] : [])),
  ];
  const before = snapshotSkills(skillDirs);

  // Keep every argument free of quotes and spaces: on Windows npx is a .cmd
  // shim, so the command line is re-parsed by cmd.exe.
  const args = [
    "--yes",
    NPX_SKILLS_PACKAGE,
    "add",
    repo,
    "--skill",
    "*",
    "--global",
    "--agent",
    ...agents,
    "--yes",
  ];
  const completed = runNpx(args, deps);
  if (!completed) {
    throw new Error(
      "Installing Tavily skills requires Node.js (npx). Install Node.js, or rerun with --skip-skills.",
    );
  }
  const failure = failureOf(completed);
  if (failure) throw new Error(`npx skills failed: ${failure}`);

  return { agents, restartRequired: !isDeepStrictEqual(snapshotSkills(skillDirs), before) };
}

/**
 * Each skill directory under the skills dirs (a symlinked one counts, so a new agent link shows)
 * and the content of every regular file inside it, keyed by full path.
 */
function snapshotSkills(skillDirs: string[]): Map<string, Buffer | null> {
  const snapshot = new Map<string, Buffer | null>();
  const addFiles = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) addFiles(full);
      else if (entry.isFile()) snapshot.set(full, readFileSync(full));
    }
  };
  for (const skillDir of skillDirs.filter(isDir)) {
    for (const name of readdirSync(skillDir)) {
      const full = path.join(skillDir, name);
      if (!isDir(full)) continue;
      snapshot.set(full, null);
      addFiles(full);
    }
  }
  return snapshot;
}

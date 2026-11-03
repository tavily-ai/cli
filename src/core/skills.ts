/**
 * Install Tavily's maintained agent skills with the skills.sh CLI (`npx skills`).
 *
 * Installs track the latest published skills and are counted on skills.sh.
 */
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const SKILLS_REPO = "tavily-ai/skills";
// Exact version: npx runs whatever this resolves to with the user's permissions.
export const NPX_SKILLS_PACKAGE = "skills@1.7.4";
export const NPX_TIMEOUT_MS = 300_000;

export type AgentName = "claude-code" | "codex" | "cursor";

export interface AgentSpec {
  marker: string;
  skillsDir: string;
}

export interface SkillsInstallResult {
  agents: string[];
  restartRequired: boolean;
}

export interface SkillsOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SkillsDeps extends SkillsOptions {
  which?: (name: string) => string | null;
  spawnImpl?: typeof childProcess.spawnSync;
  platform?: NodeJS.Platform;
  execPath?: string;
  existsSync?: (p: string) => boolean;
}

/** Return supported agent locations rooted at the current user's home. */
export function agentSpecs(opts: SkillsOptions = {}): Record<AgentName, AgentSpec> {
  const root = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const claudeRoot = env.CLAUDE_CONFIG_DIR || path.join(root, ".claude");
  const codexRoot = env.CODEX_HOME || path.join(root, ".codex");
  const cursorRoot = path.join(root, ".cursor");
  return {
    "claude-code": { marker: claudeRoot, skillsDir: path.join(claudeRoot, "skills") },
    codex: { marker: codexRoot, skillsDir: path.join(codexRoot, "skills") },
    cursor: { marker: cursorRoot, skillsDir: path.join(cursorRoot, "skills") },
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
  return (Object.entries(agentSpecs(opts)) as [AgentName, AgentSpec][])
    .filter(([, spec]) => isDir(spec.marker))
    .map(([name]) => name);
}

/** First executable match for `name` on PATH (honoring PATHEXT on Windows), or null. */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const win = process.platform === "win32";
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

/** Install every skill in the Tavily skills repo for the selected agents. */
export async function installAgentSkills(
  agents: string[],
  deps: SkillsDeps = {},
): Promise<SkillsInstallResult> {
  const which = deps.which ?? ((name: string) => whichOnPath(name, deps.env));
  const spawnImpl = deps.spawnImpl ?? childProcess.spawnSync;
  const npx = which("npx");
  if (!npx) {
    throw new Error(
      "Installing Tavily skills requires Node.js (npx). Install Node.js, or rerun with --skip-skills.",
    );
  }

  // npx writes to the shared directory, or straight into an agent's own
  // directory when that agent is the only target.
  const specs = agentSpecs(deps) as Record<string, AgentSpec>;
  const skillDirs = [
    path.join(deps.home ?? homedir(), ".agents", "skills"),
    ...agents.flatMap((name) => (specs[name] ? [specs[name].skillsDir] : [])),
  ];
  const before = snapshotSkills(skillDirs);

  // Keep every argument free of quotes and spaces: on Windows npx is a .cmd
  // shim, so the command line is re-parsed by cmd.exe.
  const args = [
    "--yes",
    NPX_SKILLS_PACKAGE,
    "add",
    SKILLS_REPO,
    "--skill",
    "*",
    "--global",
    "--agent",
    ...agents,
    "--yes",
  ];
  // Windows: spawning a .cmd with shell:false throws EINVAL on Node 20.12.2+,
  // so run npm's npx-cli.js through node; fall back to the shell for the .cmd.
  let command = npx;
  let spawnArgs = args;
  let shell = false;
  if ((deps.platform ?? process.platform) === "win32") {
    const execPath = deps.execPath ?? process.execPath;
    const npxCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
    if ((deps.existsSync ?? existsSync)(npxCli)) {
      command = execPath;
      spawnArgs = [npxCli, ...args];
    } else {
      command = `"${npx}"`;
      shell = true;
    }
  }
  const completed = spawnImpl(command, spawnArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: NPX_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    shell,
  });
  if (completed.error) {
    if ((completed.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error("npx skills timed out while installing Tavily skills.");
    }
    throw new Error(`npx skills failed: ${completed.error.message}`);
  }
  if (completed.status !== 0) {
    const text = String(completed.stderr || completed.stdout || "").trim();
    const last = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .pop();
    const fallback =
      completed.status === null ? `signal ${completed.signal}` : `exit code ${completed.status}`;
    throw new Error(`npx skills failed: ${last ?? fallback}`);
  }

  return { agents, restartRequired: !isDeepStrictEqual(snapshotSkills(skillDirs), before) };
}

/** Digest every directory directly under each skills dir, keyed by path so a new agent link counts. */
export function snapshotSkills(skillDirs: string[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const skillDir of skillDirs) {
    if (!isDir(skillDir)) continue;
    for (const entry of readdirSync(skillDir)) {
      const full = path.join(skillDir, entry);
      if (isDir(full)) snapshot.set(full, directoryDigest(full));
    }
  }
  return snapshot;
}

function regularFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...regularFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/** SHA-256 over sorted regular files: path length, path, content length, content. */
export function directoryDigest(dir: string): string {
  const digest = createHash("sha256");
  const sorted = regularFiles(dir)
    .map((rel) => ({ rel, bytes: Buffer.from(rel, "utf8") }))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes));
  for (const { rel, bytes } of sorted) {
    const content = readFileSync(path.join(dir, ...rel.split("/")));
    const pathLen = Buffer.alloc(4);
    pathLen.writeUInt32BE(bytes.length);
    const contentLen = Buffer.alloc(8);
    contentLen.writeBigUInt64BE(BigInt(content.length));
    digest.update(pathLen).update(bytes).update(contentLen).update(content);
  }
  return digest.digest("hex");
}

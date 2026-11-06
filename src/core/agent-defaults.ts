/** Disable agents' built-in web search so Tavily becomes the default web tool. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { InvalidArgumentError } from "commander";
import { isObject } from "../errors.js";

const CLAUDE_DENIED_TOOLS = ["WebSearch", "WebFetch"];
const CODEX_WEB_SEARCH_LINE = 'web_search = "disabled"';

const TOML_TABLE_HEADER = /^\s*\[/;
const TOML_WEB_SEARCH = /^\s*web_search\s*=/;
const TOML_WEB_SEARCH_DISABLED = /^\s*web_search\s*=\s*["']disabled["']\s*(#.*)?$/;

export interface PathContext {
  project?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}

/** `~` and `~/...` expand to the home directory, like Python's `expanduser`. */
function expandUser(p: string, home: string): string {
  return p === "~" || p.startsWith("~/") ? join(home, p.slice(1)) : p;
}

function configRoot(envVar: string, dirName: string, ctx: PathContext): string {
  const home = ctx.home ?? homedir();
  const raw = (ctx.env ?? process.env)[envVar];
  return raw ? resolve(expandUser(raw, home)) : join(home, dirName);
}

export function claudeSettingsPath(ctx: PathContext = {}): string {
  // Personal project settings; Claude Code gitignores this file automatically.
  if (ctx.project) return join(ctx.cwd ?? process.cwd(), ".claude", "settings.local.json");
  return join(configRoot("CLAUDE_CONFIG_DIR", ".claude", ctx), "settings.json");
}

export function codexConfigPath(ctx: PathContext = {}): string {
  if (ctx.project) return join(ctx.cwd ?? process.cwd(), ".codex", "config.toml");
  return join(configRoot("CODEX_HOME", ".codex", ctx), "config.toml");
}

// -- Claude Code: ~/.claude/settings.json --

type Settings = Record<string, unknown>;

function loadClaudeSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (e) {
    throw new InvalidArgumentError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(settings)) throw new InvalidArgumentError(`${path} must contain a JSON object.`);
  return settings;
}

function denyList(settings: Settings, path: string): unknown[] {
  settings.permissions ??= {};
  const permissions = settings.permissions;
  if (!isObject(permissions))
    throw new InvalidArgumentError(`"permissions" in ${path} must be an object.`);
  permissions.deny ??= [];
  const deny = permissions.deny;
  if (!Array.isArray(deny))
    throw new InvalidArgumentError(`"permissions.deny" in ${path} must be an array.`);
  return deny;
}

function writeClaudeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** Deny Claude Code's built-in web tools. Returns true if the file changed. */
export function setClaudeDefault(path: string): boolean {
  const settings = loadClaudeSettings(path);
  const deny = denyList(settings, path);
  const missing = CLAUDE_DENIED_TOOLS.filter((tool) => !deny.includes(tool));
  if (missing.length === 0) return false;
  deny.push(...missing);
  writeClaudeSettings(path, settings);
  return true;
}

/** Remove the web-tool denials added by set-default. Returns true if the file changed. */
export function unsetClaudeDefault(path: string): boolean {
  const settings = loadClaudeSettings(path);
  const permissions = settings.permissions;
  if (!isObject(permissions) || !Array.isArray(permissions.deny)) return false;
  const deny = permissions.deny;
  const kept = deny.filter((tool) => !CLAUDE_DENIED_TOOLS.includes(tool as string));
  if (kept.length === deny.length) return false;
  if (kept.length > 0) {
    permissions.deny = kept;
  } else {
    delete permissions.deny;
    if (Object.keys(permissions).length === 0) delete settings.permissions;
  }
  writeClaudeSettings(path, settings);
  return true;
}

// -- Codex: ~/.codex/config.toml --

/** Lines keeping their terminators, like Python's `splitlines(keepends=True)`. */
const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+/g) ?? [];

const stripEol = (line: string): string => line.replace(/\r?\n$/, "");

/** Index of the first table header; top-level keys must appear before it. */
function topLevelEnd(lines: string[]): number {
  const index = lines.findIndex((line) => TOML_TABLE_HEADER.test(line));
  return index === -1 ? lines.length : index;
}

/** Disable Codex's built-in web search. Returns true if the file changed. */
export function setCodexDefault(path: string): boolean {
  const lines = splitLines(existsSync(path) ? readFileSync(path, "utf8") : "");
  const end = topLevelEnd(lines);
  const index = lines.slice(0, end).findIndex((line) => TOML_WEB_SEARCH.test(line));
  if (index === -1) {
    lines.unshift(`${CODEX_WEB_SEARCH_LINE}\n`);
  } else if (TOML_WEB_SEARCH_DISABLED.test(stripEol(lines[index] as string))) {
    return false;
  } else {
    lines[index] = `${CODEX_WEB_SEARCH_LINE}\n`;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join(""), "utf8");
  return true;
}

/** Remove the web_search setting added by set-default. Returns true if the file changed. */
export function unsetCodexDefault(path: string): boolean {
  if (!existsSync(path)) return false;
  const lines = splitLines(readFileSync(path, "utf8"));
  const end = topLevelEnd(lines);
  const kept = lines.filter(
    (line, index) => index >= end || !TOML_WEB_SEARCH_DISABLED.test(stripEol(line)),
  );
  if (kept.length === lines.length) return false;
  writeFileSync(path, kept.join(""), "utf8");
  return true;
}

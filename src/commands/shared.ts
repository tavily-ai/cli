/** Helpers shared by the API commands: API error handling, query/CSV parsing. */
import { readFileSync } from "node:fs";
import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import type { Command } from "commander";
import { snake } from "../core/search-flags.js";
import { ExitError, messageOf, OAuthError } from "../errors.js";
import { keylessCapError, printKeylessCapHit } from "../ui/keyless.js";
import { safeLink, sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";
import { handleOauthRefreshError } from "./common.js";

// Status codes that represent usage/plan limits rather than real errors.
export const LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 432]);

export function handleApiError(e: unknown, json: boolean): never {
  const limit = e instanceof TavilyRequestError && LIMIT_STATUSES.has(e.status);
  if (json) {
    out(JSON.stringify({ error: messageOf(e) }));
    throw new ExitError(limit ? 3 : 4);
  }
  const text = sanitizeControl(messageOf(e));
  if (limit) {
    err();
    err(`  ${colors.yellow(">")} ${text}`);
    err();
    err(
      `  ${colors.dim("Upgrade your plan at")} ${colors.green(safeLink("https://tavily.com", "tavily.com"))}`,
    );
    if (e.docs) err(`  ${colors.dim("Docs:")} ${colors.dim(safeLink(e.docs))}`);
    err();
    throw new ExitError(3);
  }
  err(`  ${colors.pink("> Error:")} ${text}`);
  throw new ExitError(4);
}

/** Run a command body, turning keyless cap, OAuth refresh, and API failures into exit codes. */
export async function runWithApiErrors<T>(json: boolean, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExitError) throw e;
    if (e instanceof TavilyKeylessLimitError) {
      if (json) out(JSON.stringify({ error: keylessCapError(e) }));
      else printKeylessCapHit(e);
      throw new ExitError(3);
    }
    if (e instanceof OAuthError) return handleOauthRefreshError(e, json);
    return handleApiError(e, json);
  }
}

export function splitCsv(value?: string): string[] | undefined {
  return value ? value.split(",").map((part) => part.trim()) : undefined;
}

/** The options in `keys` that are set, under their snake_case API names, in `keys` order. */
export function definedSnake(opts: object, keys: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (opts as Record<string, unknown>)[key];
    if (value !== undefined) body[snake(key)] = value;
  }
  return body;
}

const MAX_STDIN_CHARS = 100_000;
export const QUERY_REQUIRED =
  "error: QUERY is required. Pass a query string or use '-' to read from stdin.";

/** The query argument; `-` reads it from stdin. A blank query is a usage error. */
export function readQueryArg(query: string | undefined, cmd: Command): string {
  const value = (
    query === "-" ? readFileSync(0, "utf8").slice(0, MAX_STDIN_CHARS) : (query ?? "")
  ).trim();
  if (!value) cmd.error(QUERY_REQUIRED);
  return value;
}

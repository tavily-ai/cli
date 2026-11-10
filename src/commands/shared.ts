/** Helpers shared by the API commands: query/CSV parsing. */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { snake } from "../core/search-flags.js";

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

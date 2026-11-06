/** Helpers shared by the API commands: API error handling, query/CSV parsing. */
import { readFileSync } from "node:fs";
import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import { InvalidArgumentError } from "commander";
import { ExitError, OAuthError } from "../errors.js";
import { formatKeylessEnvelopeForTerminal } from "../ui/keyless.js";
import { safeLink, sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";
import { handleOauthRefreshError } from "./common.js";

// Status codes that represent usage/plan limits rather than real errors.
export const LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 432]);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function keylessCapError(e: TavilyKeylessLimitError) {
  return {
    code: e.capType,
    message: e.message,
    window: e.window,
    retry_after_seconds: e.retryAfter,
    next_actions: e.continuationPaths,
  };
}

/** Print the keyless cap-hit message, retry delay, continuation options and login hint to stderr. */
export function printKeylessCapHit(e: TavilyKeylessLimitError): void {
  const block = formatKeylessEnvelopeForTerminal({
    message: e.message,
    retryAfterSeconds: e.retryAfter,
    nextActions: e.continuationPaths,
  });
  err();
  sanitizeControl(block)
    .split("\n")
    .forEach((line, i) => {
      if (i === 0) err(`  ${colors.yellow(">")} ${colors.bold(line)}`);
      else err(line ? `    ${line}` : "");
    });
  err();
  err(
    `  ${colors.dim("Run ")}${colors.green("tvly login")}${colors.dim(" to authenticate and remove this cap.")}`,
  );
  err();
}

export function handleKeylessCapHit(e: TavilyKeylessLimitError, json: boolean): never {
  if (json) out(JSON.stringify({ error: keylessCapError(e) }));
  else printKeylessCapHit(e);
  throw new ExitError(3);
}

export function handleApiError(e: unknown, json: boolean): never {
  const limit = e instanceof TavilyRequestError && LIMIT_STATUSES.has(e.status);
  if (json) {
    out(JSON.stringify({ error: message(e) }));
    throw new ExitError(limit ? 3 : 4);
  }
  const text = sanitizeControl(message(e));
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
    if (e instanceof TavilyKeylessLimitError) return handleKeylessCapHit(e, json);
    if (e instanceof OAuthError) return handleOauthRefreshError(e, json);
    return handleApiError(e, json);
  }
}

export function splitCsv(value?: string): string[] | undefined {
  return value ? value.split(",").map((part) => part.trim()) : undefined;
}

const MAX_STDIN_CHARS = 100_000;

/** The query argument; `-` reads it from stdin. */
export function readQueryArg(
  query: string | undefined,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): string {
  const value = (query === "-" ? readStdin().slice(0, MAX_STDIN_CHARS) : (query ?? "")).trim();
  if (!value) {
    throw new InvalidArgumentError(
      "QUERY is required. Pass a query string or use '-' to read from stdin.",
    );
  }
  return value;
}

/** The options crawl and map share, as the API's request body (unset ones are left out). */
export interface SiteOptions {
  maxDepth?: number;
  maxBreadth?: number;
  limit?: number;
  instructions?: string;
  selectPaths?: string;
  excludePaths?: string;
  selectDomains?: string;
  excludeDomains?: string;
  /** `--allow-external` */
  allowExternal?: boolean;
  /** false for `--no-external` */
  external?: boolean;
  timeout?: number;
}

export function siteBody(url: string, opts: SiteOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { url };
  if (opts.maxDepth !== undefined) body.max_depth = opts.maxDepth;
  if (opts.maxBreadth !== undefined) body.max_breadth = opts.maxBreadth;
  if (opts.limit !== undefined) body.limit = opts.limit;
  if (opts.instructions !== undefined) body.instructions = opts.instructions;
  const lists = {
    select_paths: splitCsv(opts.selectPaths),
    exclude_paths: splitCsv(opts.excludePaths),
    select_domains: splitCsv(opts.selectDomains),
    exclude_domains: splitCsv(opts.excludeDomains),
  };
  for (const [key, value] of Object.entries(lists)) if (value) body[key] = value;
  const allowExternal = opts.external === false ? false : opts.allowExternal;
  if (allowExternal !== undefined) body.allow_external = allowExternal;
  if (opts.timeout !== undefined) body.timeout = opts.timeout;
  return body;
}

/** The API request path: credential → client → spinner → call → errors as exit codes. */
import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import type { Command } from "commander";
import type { TavilyClientLike } from "../core/tavily-client.js";
import { ExitError, messageOf } from "../errors.js";
import type { Host } from "../host.js";
import { keylessCapError, printKeylessCapHit } from "../ui/keyless.js";
import { withSpinner } from "../ui/spinner.js";
import { safeLink, sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";
import { getApiKeyOrExit } from "./credential.js";
import { resolveJson } from "./options.js";

export interface InvokeOptions {
  /** Spinner text while `fn` runs (human mode only); none when absent. */
  label?: string;
  /** `false`: keyed when credentials exist, otherwise keyless. A command name: a key is required. */
  keyed: false | string;
  clientName?: string | undefined;
}

// Status codes that represent usage/plan limits rather than real errors.
export const LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 432]);
// Rejected credentials: exit 3 like the limits, but print the API's message as a plain error.
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** Run `fn` against the resolved client, turning keyless cap, OAuth refresh, and API failures into exit codes. */
export async function invoke<T>(
  cmd: Command,
  host: Host,
  opts: InvokeOptions,
  fn: (client: TavilyClientLike) => Promise<T>,
): Promise<T> {
  const json = resolveJson(cmd);
  const key = await getApiKeyOrExit(json, host);
  if (opts.keyed && !key) requireKey(opts.keyed);
  const client = await host.resolveClient(key, opts.clientName);
  try {
    const { label } = opts;
    return label === undefined
      ? await fn(client)
      : await withSpinner(label, !json, () => fn(client));
  } catch (e) {
    if (e instanceof ExitError) throw e;
    if (e instanceof TavilyKeylessLimitError) {
      if (json) out(JSON.stringify({ error: keylessCapError(e) }));
      else printKeylessCapHit(e);
      throw new ExitError(3);
    }
    return handleApiError(e, json);
  }
}

function requireKey(command: string): never {
  err();
  err(`  ${colors.pink(">")} The ${colors.bold(command)} command requires a Tavily API key.`);
  err();
  err(`  Sign up for a free key at ${safeLink("https://tavily.com")}`);
  err(
    `  Then run ${colors.green("tvly login")} or ${colors.green("tvly login --api-key tvly-YOUR_KEY")}`,
  );
  err();
  err(
    colors.dim(
      `  Tip: ${colors.green("tvly search")} and ${colors.green("tvly extract")} work without an API key (subject to a rate-limit cap).`,
    ),
  );
  err();
  throw new ExitError(3);
}

function handleApiError(e: unknown, json: boolean): never {
  const limit = e instanceof TavilyRequestError && LIMIT_STATUSES.has(e.status);
  const code = limit || (e instanceof TavilyRequestError && AUTH_STATUSES.has(e.status)) ? 3 : 4;
  if (json) {
    out(JSON.stringify({ error: messageOf(e) }));
    throw new ExitError(code);
  }
  const text = sanitizeControl(messageOf(e));
  if (limit) {
    err();
    err(`  ${colors.yellow(">")} ${text}`);
    err();
    err(
      `  ${colors.dim("Upgrade your plan at")} ${colors.green(safeLink("https://tavily.com", "tavily.com"))}`,
    );
    err();
    throw new ExitError(3);
  }
  err(`  ${colors.pink("> Error:")} ${text}`);
  throw new ExitError(code);
}

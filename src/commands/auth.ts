/** tvly login, logout, auth — manage stored Tavily credentials. */
import type { Command } from "commander";
import {
  authMethod,
  type ConfigOptions,
  clearCredentials,
  configPaths,
  getApiKey,
  saveApiKey,
  saveOauthSession,
} from "../core/config.js";
import { looksHeadless, runBrowserLogin } from "../core/oauth.js";
import { ExitError, OAuthError } from "../errors.js";
import { spinner } from "../ui/spinner.js";
import { sanitizeControl } from "../ui/text.js";
import { colors, err, LOGO, out } from "../ui/theme.js";
import { getApiKeyOrExit } from "./common.js";
import { resolveJson } from "./options.js";

export interface AuthDeps extends ConfigOptions {
  login?: typeof runBrowserLogin;
  openImpl?: (url: string) => void;
}

interface LoginOptions {
  apiKey?: string;
  browser?: boolean;
}

const ENV_CREDENTIAL_WARNING =
  "TAVILY_API_KEY is still set and cannot be removed from the parent environment by this process. " +
  "Run: unset TAVILY_API_KEY";

export async function runLogin(
  opts: LoginOptions,
  cmd: Command,
  deps: AuthDeps = {},
): Promise<void> {
  const json = resolveJson(cmd);
  const configFile = configPaths(deps.home).file;

  if (opts.apiKey) {
    await saveApiKey(opts.apiKey, deps);
    printLoginSuccess("API key", `Saved to ${configFile}`, json);
    return;
  }

  const openBrowser = !(opts.browser === false || looksHeadless(deps.env));
  const showUrl = (rawUrl: string) => {
    const url = sanitizeControl(rawUrl);
    if (json) {
      err(JSON.stringify({ event: "authorization_required", authorization_url: url }));
      return;
    }
    err();
    if (openBrowser) {
      err(`  ${colors.aqua(">")} Opening the browser to sign in with Tavily.`);
      err(`    ${colors.dim("If nothing opens, visit:")}`);
    } else {
      err(`  ${colors.aqua(">")} Open this URL in a browser on this machine:`);
    }
    err(`    ${url}`);
    err();
    if (!openBrowser) {
      err(
        `    ${colors.dim("Headless / SSH sessions cannot complete browser login unless this machine can receive http://127.0.0.1 callbacks.")}`,
      );
      err(
        `    ${colors.dim("Use")} ${colors.green("tvly login --api-key tvly-YOUR_KEY")} ${colors.dim("instead.")}`,
      );
      err();
    }
  };

  const waiting = () => spinner(colors.aqua("Waiting for browser authorization..."), !json);
  let spin = waiting();
  const onStatus = (url: string) => {
    // Clear the spinner line so the URL block prints cleanly, then resume waiting.
    spin.stop();
    showUrl(url);
    spin = waiting();
  };
  try {
    const session = await (deps.login ?? runBrowserLogin)({
      openBrowser,
      // Always report the URL: a browser launch can fail silently, even in --json mode.
      onStatus,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.openImpl ? { openImpl: deps.openImpl } : {}),
    });
    spin.stop();
    await saveOauthSession(session, deps);
  } catch (e) {
    spin.stop();
    if (e instanceof OAuthError) failLogin(e.message, json);
    throw e;
  }
  printLoginSuccess("OAuth", `Token stored in ${configFile}`, json);
}

/** Print the branded success screen (or JSON) after login. */
function printLoginSuccess(method: "API key" | "OAuth", detail: string, json: boolean): void {
  if (json) {
    out(
      JSON.stringify({
        authenticated: true,
        method: method === "OAuth" ? "oauth" : "api_key",
        detail,
      }),
    );
    return;
  }
  out();
  out(LOGO);
  out();
  out(`  ${colors.green(`> Authenticated via ${method}`)}`);
  out(`    ${colors.dim(detail)}`);
  out();
  out(`  ${colors.bold("Get started")}`);
  out();
  const hint = (cmd: string, arg: string) => out(`    ${colors.green(cmd)} ${colors.dim(arg)}`);
  hint("tvly search", '"your first query"');
  hint("tvly extract", "<url>");
  hint("tvly crawl", "<url>");
  hint("tvly map", "<url>");
  hint("tvly research", '"deep dive topic"');
  out();
}

function failLogin(message: string, json: boolean): never {
  if (json) {
    out(JSON.stringify({ authenticated: false, error: message }));
  } else {
    err();
    err(`  ${colors.pink(`> ${sanitizeControl(message)}`)}`);
    err();
    err("  Use an API key instead:");
    err(`    ${colors.green("tvly login --api-key tvly-YOUR_KEY")}`);
    err();
  }
  throw new ExitError(3);
}

/** The effective credential and where it came from. */
function effectiveAuthState(key: string | null, deps: AuthDeps) {
  if (!key) return { key: null, method: null, source: null };
  const method = authMethod(key, deps);
  const { file } = configPaths(deps.home);
  const source = {
    env: "TAVILY_API_KEY environment variable",
    oauth: `OAuth (${file})`,
    oauth_legacy: "OAuth (~/.mcp-auth/)",
    api_key: `config file (${file})`,
  }[method];
  return { key, method, source };
}

export async function runLogout(
  _opts: Record<string, never>,
  cmd: Command,
  deps: AuthDeps = {},
): Promise<void> {
  const json = resolveJson(cmd);
  const result = await clearCredentials(deps);
  const { key, method, source } = effectiveAuthState(await getApiKey(deps), deps);
  const envPresent = method === "env";
  const payload: Record<string, unknown> = {
    authenticated: key !== null,
    method,
    source,
    local_credentials_cleared: true,
    environment_credential_present: envPresent,
  };
  if (envPresent) payload.warning = ENV_CREDENTIAL_WARNING;
  const envStillSet = () => {
    err(`  ${colors.yellow(">")} TAVILY_API_KEY is still set, so the CLI remains authenticated.`);
    err(`    ${colors.dim("Run in your shell: unset TAVILY_API_KEY")}`);
  };

  if (result.revocationError) {
    if (json) {
      payload.server_revoked = false;
      payload.error = result.revocationError;
      out(JSON.stringify(payload));
    } else {
      err(`  ${colors.yellow(">")} Local credentials cleared, but server revocation failed.`);
      err(`    ${colors.dim(sanitizeControl(result.revocationError))}`);
      err("  The previous OAuth token may remain usable.");
      if (envPresent) envStillSet();
    }
    throw new ExitError(3);
  }

  if (json) {
    if (result.serverRevoked !== null) payload.server_revoked = result.serverRevoked;
    out(JSON.stringify(payload));
    return;
  }
  err(
    colors.dim(
      result.serverRevoked
        ? "  Server session revoked and credentials cleared."
        : "  Credentials cleared.",
    ),
  );
  if (envPresent) envStillSet();
  else err(`  Run ${colors.green("tvly login")} to authenticate again.`);
}

export async function runAuth(
  _opts: Record<string, never>,
  cmd: Command,
  deps: AuthDeps = {},
): Promise<void> {
  const json = resolveJson(cmd);
  const { key, method, source } = effectiveAuthState(await getApiKeyOrExit(json, deps), deps);
  if (json) {
    out(JSON.stringify({ authenticated: key !== null, method, source }));
    return;
  }
  out();
  if (key) {
    const masked = key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : "***";
    out(`  ${colors.green(">")} Authenticated via ${source}`);
    out(`    ${colors.dim(`Key: ${masked}`)}`);
  } else {
    out(`  ${colors.pink(">")} Not authenticated`);
    out();
    out(`  Run ${colors.green("tvly login")} to authenticate.`);
  }
  out();
}

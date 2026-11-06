/**
 * Credential storage (~/.tavily/config.json) and resolution for the Tavily CLI.
 *
 * Every write goes through `withConfigLock`, which serializes read-modify-write
 * transactions across processes and replaces the file atomically.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import { isObject, messageOf, OAuthError } from "../errors.js";
import {
  fetchMetadata,
  MCP_ISSUER,
  type OAuthSession,
  type RegisteredClient,
  refreshTokens,
  revokeToken,
  tokenIsExpired,
} from "./oauth.js";

export type Config = Record<string, unknown>;

export interface ConfigOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface ClearCredentialsResult {
  serverRevoked: boolean | null;
  revocationError?: string;
}

export function configPaths(home?: string) {
  const dir = path.join(home ?? homedir(), ".tavily");
  return {
    dir,
    file: path.join(dir, "config.json"),
    mcpAuthDir: path.join(home ?? homedir(), ".mcp-auth"),
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function readConfig(opts: ConfigOptions = {}): Config {
  try {
    const data: unknown = JSON.parse(readFileSync(configPaths(opts.home).file, "utf8"));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

/** chmod that is a no-op failure on Windows, where POSIX modes do not apply. */
async function chmod(target: string, mode: number): Promise<void> {
  try {
    await fs.chmod(target, mode);
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }
}

async function ensureConfigDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** Atomically replace config.json (or delete it when empty); caller holds the lock. */
async function writeConfigUnlocked(config: Config, opts: ConfigOptions): Promise<void> {
  const { dir, file } = configPaths(opts.home);
  await ensureConfigDir(dir);
  if (Object.keys(config).length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  const temp = path.join(dir, `.config.json.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    await fs.rename(temp, file);
    await chmod(file, 0o600);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/**
 * The only config writer: lock, read fresh, run `fn`, and atomically persist the
 * config it returns (an empty config deletes the file). Code running inside `fn`
 * must not call `withConfigLock` again.
 */
export async function withConfigLock<T>(
  fn: (config: Config) => Promise<{ config?: Config; result: T }>,
  opts: ConfigOptions = {},
): Promise<T> {
  const { dir, file } = configPaths(opts.home);
  await ensureConfigDir(dir);
  const release = await lockfile.lock(file, {
    lockfilePath: path.join(dir, ".config.lock"),
    stale: 30_000,
    // Backoff starts at 20 ms and is capped so a waiter polls at least once per second.
    retries: { retries: 50, minTimeout: 20, maxTimeout: 1000 },
    realpath: false,
    // The write is an atomic rename, so a lock that goes stale mid-transaction (e.g. the
    // laptop sleeps) can at worst lose one update; that beats crashing the CLI, which is
    // what proper-lockfile's default handler does.
    onCompromised: () => {},
  });
  try {
    const { config, result } = await fn(readConfig(opts));
    if (config !== undefined) await writeConfigUnlocked(config, opts);
    return result;
  } finally {
    await release().catch((e: unknown) => {
      // A compromised lock is already released; anything else is a real failure.
      if ((e as NodeJS.ErrnoException).code !== "ERELEASED") throw e;
    });
  }
}

function oauthSessionData(session: OAuthSession): Config {
  return {
    access_token: session.tokens.accessToken,
    refresh_token: session.tokens.refreshToken,
    expires_at: session.tokens.expiresAt,
    token_type: session.tokens.tokenType,
    client_id: session.client.clientId,
    client_secret: session.client.clientSecret,
    token_endpoint_auth_method: session.client.tokenEndpointAuthMethod,
    redirect_uri: session.client.redirectUri,
  };
}

function withoutKeys(config: Config, ...keys: string[]): Config {
  const copy = { ...config };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Replace stored credentials with an API key, revoking old OAuth first (best effort). */
export async function saveApiKey(apiKey: string, opts: ConfigOptions = {}): Promise<void> {
  await withConfigLock(async (config) => {
    if (isObject(config.oauth)) {
      try {
        await revokeStoredOauth(config.oauth, opts);
      } catch {
        // Like clearCredentials: an offline or incomplete OAuth session must not block saving the key.
      }
    }
    return { config: { ...withoutKeys(config, "oauth"), api_key: apiKey }, result: undefined };
  }, opts);
}

/** Replace stored credentials with a newly authorized OAuth session. */
export async function saveOauthSession(
  session: OAuthSession,
  opts: ConfigOptions = {},
): Promise<void> {
  const replacement = oauthSessionData(session);
  await withConfigLock(async (config) => {
    const previous = config.oauth;
    if (isObject(previous) && !isDeepStrictEqual(previous, replacement)) {
      try {
        await revokeStoredOauth(previous, opts);
      } catch (previousError) {
        if (!(previousError instanceof OAuthError)) throw previousError;
        try {
          await revokeStoredOauth(replacement, opts);
        } catch (cleanupError) {
          if (!(cleanupError instanceof OAuthError)) throw cleanupError;
          throw new OAuthError(
            `Could not replace the previous OAuth session: ${previousError.message} ` +
              `The new OAuth session also could not be revoked: ${cleanupError.message}`,
          );
        }
        throw new OAuthError(
          `Could not replace the previous OAuth session: ${previousError.message}`,
        );
      }
    }
    return { config: { ...withoutKeys(config, "api_key"), oauth: replacement }, result: undefined };
  }, opts);
}

/** True when ~/.tavily/config.json holds a native OAuth session. */
export function hasStoredOauth(opts: ConfigOptions = {}): boolean {
  const data = readConfig(opts).oauth;
  return isObject(data) && typeof data.access_token === "string";
}

/** Optional human_id: env var > config file; null when unset. */
export function getHumanId(opts: ConfigOptions = {}): string | null {
  const value = (opts.env ?? process.env).TAVILY_HUMAN_ID;
  if (value) return value;
  const configured = readConfig(opts).human_id;
  return typeof configured === "string" ? configured : null;
}

/** Optional API base URL: env var > config file, trailing slashes stripped. */
export function getApiBaseUrl(opts: ConfigOptions = {}): string | null {
  const stripSlashes = (url: string) => url.replace(/\/+$/, "");
  const value = (opts.env ?? process.env).TAVILY_API_BASE_URL;
  if (value) return stripSlashes(value);
  const configured = readConfig(opts).api_base_url;
  return nonEmptyString(configured) ? stripSlashes(configured) : null;
}

export async function clearCredentials(opts: ConfigOptions = {}): Promise<ClearCredentialsResult> {
  const result = await withConfigLock(async (config) => {
    const outcome: ClearCredentialsResult = { serverRevoked: null };
    if (isObject(config.oauth)) {
      try {
        if (await revokeStoredOauth(config.oauth, opts)) outcome.serverRevoked = true;
      } catch (e) {
        // Logout must still remove local credentials even when the remote session
        // cannot be revoked; the command reports the partial result and exits non-zero.
        outcome.serverRevoked = false;
        outcome.revocationError = (e instanceof Error && (e.message || e.name)) || String(e);
      }
    }
    return { config: withoutKeys(config, "api_key", "oauth"), result: outcome };
  }, opts);
  clearMcpTokens(opts);
  return result;
}

/** Decode a JWT payload without verification (issuer/expiry checks only); never throws. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[1], "base64url")),
    );
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

function isTavilyToken(token: string): boolean {
  return decodeJwtPayload(token)?.iss === MCP_ISSUER;
}

function isValidTavilyToken(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (payload?.iss !== MCP_ISSUER) return false;
  const exp = payload.exp;
  if (exp === undefined || exp === null) return true;
  return typeof exp === "number" && Date.now() / 1000 < exp;
}

/** Access tokens from every `*_tokens.json` under ~/.mcp-auth, with their paths. */
function mcpTokenFiles(opts: ConfigOptions): { file: string; token: unknown }[] {
  const root = configPaths(opts.home).mcpAuthDir;
  let names: string[];
  try {
    names = readdirSync(root, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const found: { file: string; token: unknown }[] = [];
  for (const name of names) {
    if (!path.basename(name).endsWith("_tokens.json")) continue;
    const file = path.join(root, name);
    try {
      const data: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isObject(data)) found.push({ file, token: data.access_token });
    } catch {
      // Unreadable or malformed token files are skipped.
    }
  }
  return found;
}

function getMcpToken(opts: ConfigOptions): string | null {
  for (const { token } of mcpTokenFiles(opts)) {
    if (nonEmptyString(token) && isValidTavilyToken(token)) return token;
  }
  return null;
}

/**
 * Remove Tavily-issued tokens from ~/.mcp-auth regardless of expiry, leaving other
 * MCP tools' tokens untouched.
 */
function clearMcpTokens(opts: ConfigOptions): void {
  for (const { file, token } of mcpTokenFiles(opts)) {
    if (!nonEmptyString(token) || !isTavilyToken(token)) continue;
    try {
      rmSync(file);
    } catch {
      // Best effort, like the Python CLI.
    }
  }
}

function oauthClientFromConfig(data: Config): RegisteredClient | null {
  const clientId = data.client_id;
  if (!nonEmptyString(clientId)) return null;
  const { client_secret: secret, token_endpoint_auth_method: method, redirect_uri: uri } = data;
  return {
    clientId,
    clientSecret: typeof secret === "string" ? secret : null,
    tokenEndpointAuthMethod: nonEmptyString(method) ? method : "none",
    redirectUri: nonEmptyString(uri) ? uri : "http://127.0.0.1/callback",
  };
}

/** Revoke stored refresh then access tokens; returns whether any were attempted. */
export async function revokeStoredOauth(data: Config, opts: ConfigOptions = {}): Promise<boolean> {
  const present = (["refresh_token", "access_token"] as const).flatMap((key) => {
    const token = data[key];
    return nonEmptyString(token) ? [{ key, token }] : [];
  });
  if (present.length === 0) return false;

  const client = oauthClientFromConfig(data);
  if (client === null) {
    throw new OAuthError(
      "Stored OAuth client metadata is incomplete; server revocation was not attempted.",
    );
  }
  const metadata = await fetchMetadata(opts.fetchImpl);
  const errors: string[] = [];
  for (const { key, token } of present) {
    try {
      await revokeToken(metadata, client, token, { tokenTypeHint: key }, opts.fetchImpl);
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      errors.push(`${key}: ${e.message}`);
    }
  }
  if (errors.length > 0) throw new OAuthError(errors.join("; "));
  return true;
}

/** A usable OAuth access token, refreshing and persisting when expired; caller holds the lock. */
async function oauthAccessToken(config: Config, opts: ConfigOptions): Promise<string | null> {
  const data = config.oauth;
  if (!isObject(data)) return null;
  const access = data.access_token;
  if (!nonEmptyString(access)) return null;
  if (!tokenIsExpired(data.expires_at)) return access;

  const refresh = data.refresh_token;
  const client = oauthClientFromConfig(data);
  if (!nonEmptyString(refresh) || client === null) return null;
  try {
    const tokens = await refreshTokens(
      await fetchMetadata(opts.fetchImpl),
      client,
      refresh,
      opts.fetchImpl,
    );
    // The refreshed session replaces the stored one without revoking it.
    const oauth = oauthSessionData({ tokens, client });
    await writeConfigUnlocked({ ...withoutKeys(config, "api_key"), oauth }, opts);
    return tokens.accessToken;
  } catch (e) {
    throw new OAuthError(
      "Could not refresh the stored Tavily OAuth session. " +
        "The stored credentials were not removed; retry the command, and run `tvly login` only if it continues. " +
        `Details: ${messageOf(e)}`,
    );
  }
}

/** Resolve credentials: env var > API key in config > OAuth in config > legacy ~/.mcp-auth. */
export async function getApiKey(opts: ConfigOptions = {}): Promise<string | null> {
  const envKey = (opts.env ?? process.env).TAVILY_API_KEY;
  if (envKey) return envKey;

  // Read without the lock (or creating ~/.tavily) so keyless use works with an unwritable HOME;
  // only an expired OAuth session, which refreshes and writes, takes the lock and re-reads.
  const config = readConfig(opts);
  if (nonEmptyString(config.api_key)) return config.api_key;
  const oauth = config.oauth;
  const needsRefresh =
    isObject(oauth) && nonEmptyString(oauth.access_token) && tokenIsExpired(oauth.expires_at);
  const stored = needsRefresh
    ? await withConfigLock(async (fresh) => {
        if (nonEmptyString(fresh.api_key)) return { result: fresh.api_key };
        return { result: await oauthAccessToken(fresh, opts) };
      }, opts)
    : await oauthAccessToken(config, opts);
  return stored ?? getMcpToken(opts);
}

/** True for an MCP OAuth JWT (as opposed to a tvly-* API key). */
export function isOauthToken(key: string): boolean {
  return !key.startsWith("tvly-") && decodeJwtPayload(key) !== null;
}

/** How `key`, as `getApiKey` resolved it, was found. */
export function authMethod(
  key: string,
  opts: ConfigOptions = {},
): "env" | "oauth" | "oauth_legacy" | "api_key" {
  if ((opts.env ?? process.env).TAVILY_API_KEY) return "env";
  if (isOauthToken(key)) return hasStoredOauth(opts) ? "oauth" : "oauth_legacy";
  return "api_key";
}

/** Describe how the user is authenticated. */
export function authSource(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): "TAVILY_API_KEY" | "OAuth (tvly login)" | "API key" {
  if (env.TAVILY_API_KEY) return "TAVILY_API_KEY";
  if (isOauthToken(key)) return "OAuth (tvly login)";
  return "API key";
}

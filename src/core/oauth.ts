/**
 * Native MCP OAuth 2.1 protocol functions (discovery, dynamic registration, PKCE,
 * token exchange/refresh, revocation). Also holds the interactive browser login with its local callback server.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthError } from "../errors.js";

export const MCP_ISSUER = "https://mcp.tavily.com/";
export const MCP_RESOURCE = "https://mcp.tavily.com/mcp";
export const OAUTH_METADATA_URL = "https://mcp.tavily.com/.well-known/oauth-authorization-server";
export const PRM_URL = "https://mcp.tavily.com/.well-known/oauth-protected-resource/mcp";
export const DEFAULT_SCOPES = "openid offline_access";
export const CLIENT_NAME = "Tavily CLI";
export const LOGIN_TIMEOUT_SECONDS = 180;
export const HTTP_TIMEOUT_MS = 30_000;
const EXPIRY_SKEW_SECONDS = 60;

const FALLBACK_METADATA: Record<string, string> = {
  issuer: MCP_ISSUER,
  authorization_endpoint: "https://mcp.tavily.com/authorize",
  token_endpoint: "https://mcp.tavily.com/token",
  registration_endpoint: "https://mcp.tavily.com/register",
  revocation_endpoint: "https://mcp.tavily.com/revoke",
};

export interface OAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string | null;
  resource: string;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: string;
  redirectUri: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds since the epoch (matches Python's `time.time()`). */
  expiresAt: number;
  tokenType: string;
}

export interface OAuthSession {
  tokens: OAuthTokens;
  client: RegisteredClient;
}

const PKCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generatePkce(): { verifier: string; challenge: string } {
  let verifier = "";
  for (let i = 0; i < 128; i++) verifier += PKCE_ALPHABET[randomInt(PKCE_ALPHABET.length)];
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

const nowSeconds = () => Date.now() / 1000;

export function expiresAtFromNow(expiresIn: unknown, now: number = nowSeconds()): number {
  const lifetime =
    typeof expiresIn === "number" && Number.isInteger(expiresIn) && expiresIn > 0
      ? expiresIn
      : 3600;
  return now + lifetime - EXPIRY_SKEW_SECONDS;
}

/** Missing, malformed, and non-finite stored expiries count as expired. */
export function tokenIsExpired(expiresAt: unknown, now: number = nowSeconds()): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return true;
  return now >= expiresAt;
}

function validatedHttpsUrl(value: string, field: string): string {
  const invalid = new OAuthError(
    `OAuth discovery returned an invalid ${field}; expected a secure HTTPS URL.`,
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid;
  }
  if (url.protocol !== "https:" || !url.host || url.username || url.password || url.hash) {
    throw invalid;
  }
  return value;
}

function timeout(): AbortSignal {
  return AbortSignal.timeout(HTTP_TIMEOUT_MS);
}

/** fetch wrapper: transport failures become OAuthError. */
async function send(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  // Redirects are never followed (like httpx): a 3xx must not re-POST secrets elsewhere.
  return transport(() => fetchImpl(url, { ...init, signal: timeout(), redirect: "manual" }));
}

/** Runs a fetch or body read, mapping transport failures to OAuthError. */
async function transport<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
    const message = e instanceof Error ? e.message : String(e);
    throw new OAuthError(
      `Could not reach the Tavily OAuth server: ${message}${cause ? `: ${cause}` : ""}`,
    );
  }
}

export async function fetchMetadata(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OAuthMetadata> {
  const data: Record<string, string> = { ...FALLBACK_METADATA };

  // Discovery failures (network, non-2xx, bad JSON) fall back to the static endpoints;
  // OAuthError (untrusted metadata) always propagates.
  const discoveredJson = async (url: string): Promise<unknown> => {
    try {
      const resp = await fetchImpl(url, { signal: timeout(), redirect: "manual" });
      if (!resp.ok) return undefined;
      return await resp.json();
    } catch {
      return undefined;
    }
  };

  const discovered = await discoveredJson(OAUTH_METADATA_URL);
  if (isObject(discovered)) {
    if (discovered.issuer !== MCP_ISSUER) {
      throw new OAuthError("OAuth discovery issuer does not match the configured Tavily issuer.");
    }
    for (const field of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
    ]) {
      const value = discovered[field];
      if (typeof value === "string") data[field] = validatedHttpsUrl(value, field);
    }
  }

  let resource = MCP_RESOURCE;
  const prm = await discoveredJson(PRM_URL);
  if (isObject(prm) && typeof prm.resource === "string") {
    const discoveredResource = validatedHttpsUrl(prm.resource, "resource");
    if (discoveredResource !== MCP_RESOURCE) {
      throw new OAuthError(
        "OAuth protected-resource metadata does not match the Tavily MCP resource.",
      );
    }
    resource = discoveredResource;
  }

  const { registration_endpoint: registration, authorization_endpoint: authorization } = data;
  const { token_endpoint: token, revocation_endpoint: revocation } = data;
  if (!registration || !authorization || !token) {
    throw new OAuthError(
      "OAuth discovery did not return authorization, token, and registration endpoints.",
    );
  }
  return {
    authorizationEndpoint: validatedHttpsUrl(authorization, "authorization_endpoint"),
    tokenEndpoint: validatedHttpsUrl(token, "token_endpoint"),
    registrationEndpoint: validatedHttpsUrl(registration, "registration_endpoint"),
    revocationEndpoint: revocation ? validatedHttpsUrl(revocation, "revocation_endpoint") : null,
    resource,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonObjectResponse(
  resp: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const text = await transport(() => resp.text());
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new OAuthError(`${operation} returned invalid JSON (HTTP ${resp.status}).`);
  }
  if (!isObject(data)) {
    throw new OAuthError(
      `${operation} returned an invalid response (HTTP ${resp.status}; expected a JSON object).`,
    );
  }
  return data;
}

export function httpErrorMessage(prefix: string, status: number, text: string): string {
  let detail = text.trim().replaceAll("\n", " ");
  if (detail.length > 280) detail = `${detail.slice(0, 277)}...`;
  return detail ? `${prefix} (HTTP ${status}): ${detail}` : `${prefix} (HTTP ${status}).`;
}

async function httpError(prefix: string, resp: Response): Promise<OAuthError> {
  return new OAuthError(httpErrorMessage(prefix, resp.status, await transport(() => resp.text())));
}

export async function registerClient(
  metadata: OAuthMetadata,
  redirectUri: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RegisteredClient> {
  const payload = {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: DEFAULT_SCOPES,
    application_type: "native",
  };
  const resp = await send(fetchImpl, metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw await httpError("Client registration failed", resp);
  const data = await jsonObjectResponse(resp, "OAuth client registration");
  const clientId = data.client_id;
  if (typeof clientId !== "string" || !clientId) {
    throw new OAuthError("OAuth registration did not return a client_id.");
  }
  const method = data.token_endpoint_auth_method || "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    throw new OAuthError(
      `Authorization server registered the CLI with unsupported token_endpoint_auth_method '${String(method)}'.`,
    );
  }
  const secret = data.client_secret;
  if (method !== "none" && (typeof secret !== "string" || !secret)) {
    throw new OAuthError(
      `Authorization server registered the CLI for '${method}' but issued no valid client_secret.`,
    );
  }
  return {
    clientId,
    clientSecret: typeof secret === "string" ? secret : null,
    tokenEndpointAuthMethod: method,
    redirectUri,
  };
}

export function buildAuthorizeUrl(
  metadata: OAuthMetadata,
  client: RegisteredClient,
  { state, codeChallenge }: { state: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: DEFAULT_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource: metadata.resource,
  });
  return `${metadata.authorizationEndpoint}?${params}`;
}

/** Body fields and optional Authorization header for the token/revoke endpoints. */
function tokenAuth(client: RegisteredClient): {
  extra: Record<string, string>;
  basic: string | null;
} {
  if (client.tokenEndpointAuthMethod === "client_secret_post" && client.clientSecret) {
    return {
      extra: { client_id: client.clientId, client_secret: client.clientSecret },
      basic: null,
    };
  }
  if (client.tokenEndpointAuthMethod === "client_secret_basic" && client.clientSecret) {
    const creds = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64");
    return { extra: {}, basic: `Basic ${creds}` };
  }
  return { extra: { client_id: client.clientId }, basic: null };
}

function formRequest(body: Record<string, string>, basic: string | null): RequestInit {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (basic) headers.authorization = basic;
  return { method: "POST", headers, body: new URLSearchParams(body).toString() };
}

async function requestTokens(
  tokenEndpoint: string,
  body: Record<string, string>,
  basic: string | null,
  fetchImpl: typeof fetch,
): Promise<OAuthTokens> {
  const resp = await send(fetchImpl, tokenEndpoint, formRequest(body, basic));
  if (!resp.ok) throw await httpError("Token request failed", resp);
  const data = await jsonObjectResponse(resp, "OAuth token endpoint");
  const access = data.access_token;
  if (typeof access !== "string" || !access) {
    throw new OAuthError("OAuth token response did not include a valid access_token.");
  }
  const refresh = data.refresh_token;
  const tokenType = data.token_type;
  return {
    accessToken: access,
    refreshToken: typeof refresh === "string" ? refresh : null,
    expiresAt: expiresAtFromNow(data.expires_in),
    tokenType: typeof tokenType === "string" && tokenType ? tokenType : "Bearer",
  };
}

export async function exchangeCode(
  metadata: OAuthMetadata,
  client: RegisteredClient,
  { code, codeVerifier }: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OAuthTokens> {
  const { extra, basic } = tokenAuth(client);
  const body = {
    grant_type: "authorization_code",
    code,
    redirect_uri: client.redirectUri,
    code_verifier: codeVerifier,
    resource: metadata.resource,
    ...extra,
  };
  return requestTokens(metadata.tokenEndpoint, body, basic, fetchImpl);
}

export async function refreshTokens(
  metadata: OAuthMetadata,
  client: RegisteredClient,
  refreshToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OAuthTokens> {
  const { extra, basic } = tokenAuth(client);
  const body = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource: metadata.resource,
    ...extra,
  };
  const tokens = await requestTokens(metadata.tokenEndpoint, body, basic, fetchImpl);
  return tokens.refreshToken === null ? { ...tokens, refreshToken } : tokens;
}

export async function revokeToken(
  metadata: OAuthMetadata,
  client: RegisteredClient,
  token: string,
  { tokenTypeHint }: { tokenTypeHint: "access_token" | "refresh_token" },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (!token) return;
  if (!metadata.revocationEndpoint) {
    throw new OAuthError("OAuth server does not advertise a token revocation endpoint.");
  }
  const { extra, basic } = tokenAuth(client);
  const body = { token, token_type_hint: tokenTypeHint, ...extra };
  let resp = await send(fetchImpl, metadata.revocationEndpoint, formRequest(body, basic));

  if (resp.status === 400 && client.tokenEndpointAuthMethod === "none") {
    // Compatibility fallback for MCP Python SDK revocation handlers that incorrectly
    // require the nullable client_secret form field. The client stays public and no
    // secret is supplied. https://github.com/modelcontextprotocol/python-sdk/issues/2260
    resp = await send(
      fetchImpl,
      metadata.revocationEndpoint,
      formRequest({ ...body, client_secret: "" }, basic),
    );
  }
  if (!resp.ok) throw await httpError("Token revocation failed", resp);
}

/** Heuristic: SSH or missing display means don't try to open a browser. */
export function looksHeadless(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function callbackHtml({ success }: { success: boolean }): string {
  const message = success
    ? "You're signed in. You can close this tab and return to the terminal."
    : "Sign-in didn't complete. Return to the terminal for details.";
  const color = success ? "#9BC0AE" : "#FAA2FB";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Tavily CLI</title></head>
<body style="font-family: system-ui, sans-serif; background:#111; color:#eee;
             display:flex; min-height:100vh; align-items:center; justify-content:center;">
  <div style="max-width:32rem; text-align:center;">
    <p style="color:${color}; font-size:1.25rem; font-weight:600;">tavily</p>
    <p>${message}</p>
  </div>
</body></html>`;
}

/** Best-effort browser launch; failures are ignored because the URL was already printed. */
export function openBrowser(url: string, spawnImpl: typeof spawn = spawn): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnImpl(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore
  }
}

interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

/** Runs the interactive authorization-code login and returns tokens plus the registered client. */
export async function runBrowserLogin(opts: {
  openBrowser: boolean;
  timeoutSeconds?: number;
  onStatus?: (url: string) => void;
  fetchImpl?: typeof fetch;
  openImpl?: (url: string) => void;
}): Promise<OAuthSession> {
  const { timeoutSeconds = LOGIN_TIMEOUT_SECONDS, fetchImpl = globalThis.fetch } = opts;
  const metadata = await fetchMetadata(fetchImpl);

  let resolveCallback: (p: CallbackParams) => void = () => {};
  const callback = new Promise<CallbackParams>((r) => {
    resolveCallback = r;
  });
  let handled = false;
  const server = createServer((req, res) => {
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      // malformed request target, e.g. "//"
    }
    if (!url || req.method !== "GET" || url.pathname !== "/callback" || handled) {
      res.writeHead(404).end();
      return;
    }
    handled = true;
    const q = url.searchParams;
    const params: CallbackParams = {
      code: q.get("code"),
      state: q.get("state"),
      error: q.get("error"),
      errorDescription: q.get("error_description"),
    };
    const ok = Boolean(params.code) && !params.error;
    const body = Buffer.from(callbackHtml({ success: ok }), "utf8");
    res.writeHead(ok ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
    });
    res.end(body);
    resolveCallback(params);
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const client = await registerClient(metadata, `http://127.0.0.1:${port}/callback`, fetchImpl);

    const { verifier, challenge } = generatePkce();
    const state = randomBytes(32).toString("base64url");
    const authorizeUrl = buildAuthorizeUrl(metadata, client, { state, codeChallenge: challenge });

    opts.onStatus?.(authorizeUrl);
    if (opts.openBrowser) (opts.openImpl ?? openBrowser)(authorizeUrl);

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new OAuthError(
              `Timed out after ${timeoutSeconds}s waiting for browser authorization. ` +
                "Open the login URL printed above, or use: tvly login --api-key tvly-YOUR_KEY",
            ),
          ),
        timeoutSeconds * 1000,
      );
    });
    const result = await Promise.race([callback, timeout]);

    if (result.error) {
      throw new OAuthError(`Authorization was denied: ${result.errorDescription || result.error}`);
    }
    if (result.state !== state) {
      throw new OAuthError("OAuth state mismatch; aborting to prevent CSRF.");
    }
    if (!result.code) throw new OAuthError("Authorization callback did not include a code.");

    const tokens = await exchangeCode(
      metadata,
      client,
      { code: result.code, codeVerifier: verifier },
      fetchImpl,
    );
    return { tokens, client };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

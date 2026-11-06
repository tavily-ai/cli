import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type Config,
  type ConfigOptions,
  clearCredentials,
  configPaths,
  decodeJwtPayload,
  getApiBaseUrl,
  getApiKey,
  getHumanId,
  hasStoredOauth,
  isOauthToken,
  readConfig,
  revokeStoredOauth,
  saveApiKey,
  saveOauthSession,
  withConfigLock,
} from "../src/core/config.js";
import { expiresAtFromNow, type OAuthSession } from "../src/core/oauth.js";
import { OAuthError } from "../src/errors.js";

const CONFIG_MODULE = fileURLToPath(new URL("../src/core/config.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/config-python-written.json", import.meta.url));

interface Call {
  url: string;
  params: URLSearchParams;
}

type Route = (call: Call) => Response | Promise<Response>;

/** Fake OAuth server: discovery 404s (static fallback endpoints), routes by path. */
function fakeServer(routes: { revoke?: Route; token?: Route } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = { url, params: new URLSearchParams(String(init?.body ?? "")) };
    if (url.includes("/.well-known/")) return new Response("", { status: 404 });
    calls.push(call);
    const route = url.endsWith("/revoke") ? routes.revoke : routes.token;
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route(call);
  }) as typeof fetch;
  const revoked = () =>
    calls
      .filter((c) => c.url.endsWith("/revoke"))
      .map((c) => [c.params.get("token"), c.params.get("token_type_hint")]);
  return { fetchImpl, calls, revoked };
}

const ok = () => new Response("", { status: 200 });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function jwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

let home: string;
let opts: ConfigOptions;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "tvly-config-"));
  opts = { home, env: {} };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

async function writeConfig(config: Config): Promise<void> {
  await withConfigLock(async () => ({ config, result: undefined }), opts);
}

const previousOauth = {
  access_token: "old-access",
  refresh_token: "old-refresh",
  client_id: "old-client",
  token_endpoint_auth_method: "none",
};

const replacementSession: OAuthSession = {
  tokens: {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: expiresAtFromNow(3600),
    tokenType: "Bearer",
  },
  client: {
    clientId: "new-client",
    clientSecret: null,
    tokenEndpointAuthMethod: "none",
    redirectUri: "http://127.0.0.1:2/callback",
  },
};

test("stored oauth revokes refresh before access", async () => {
  const server = fakeServer({ revoke: ok });
  const attempted = await revokeStoredOauth(
    {
      access_token: "access-1",
      refresh_token: "refresh-1",
      client_id: "cid",
      token_endpoint_auth_method: "none",
    },
    { fetchImpl: server.fetchImpl },
  );
  expect(attempted).toBe(true);
  expect(server.revoked()).toEqual([
    ["refresh-1", "refresh_token"],
    ["access-1", "access_token"],
  ]);
});

test("stored oauth without tokens is not revoked; incomplete client raises", async () => {
  const server = fakeServer();
  // Empty tokens are never sent for revocation.
  expect(
    await revokeStoredOauth(
      { client_id: "cid", access_token: "", refresh_token: "" },
      { fetchImpl: server.fetchImpl },
    ),
  ).toBe(false);
  await expect(
    revokeStoredOauth({ access_token: "a" }, { fetchImpl: server.fetchImpl }),
  ).rejects.toThrow(
    "Stored OAuth client metadata is incomplete; server revocation was not attempted.",
  );
  expect(server.calls).toEqual([]);
});

test("clear credentials reports revocation failure but clears disk", async () => {
  await writeConfig({
    human_id: "keep-me",
    oauth: {
      access_token: "access-1",
      refresh_token: "refresh-1",
      client_id: "cid",
      token_endpoint_auth_method: "none",
    },
  });
  const mcpDir = path.join(configPaths(home).mcpAuthDir, "mcp-remote-0.1", "abc");
  mkdirSync(mcpDir, { recursive: true });
  const tavilyTokens = path.join(mcpDir, "tavily_tokens.json");
  const otherTokens = path.join(mcpDir, "other_tokens.json");
  // Tavily-issued tokens are removed even when expired; other issuers are left alone.
  writeFileSync(
    tavilyTokens,
    JSON.stringify({ access_token: jwt({ iss: "https://mcp.tavily.com/", exp: 1 }) }),
  );
  writeFileSync(otherTokens, JSON.stringify({ access_token: jwt({ iss: "https://other/" }) }));
  const server = fakeServer({ revoke: () => new Response("", { status: 500 }) });

  const result = await clearCredentials({ ...opts, fetchImpl: server.fetchImpl });

  expect(result.serverRevoked).toBe(false);
  expect(result.revocationError).toBe(
    "refresh_token: Token revocation failed (HTTP 500).; access_token: Token revocation failed (HTTP 500).",
  );
  expect(readConfig(opts)).toEqual({ human_id: "keep-me" });
  expect(readdirSync(mcpDir)).toEqual(["other_tokens.json"]);
});

test("clear credentials revokes, deletes an emptied config, and reports success", async () => {
  await writeConfig({ api_key: "tvly-x", oauth: previousOauth });
  const server = fakeServer({ revoke: ok });
  const result = await clearCredentials({ ...opts, fetchImpl: server.fetchImpl });
  expect(result).toEqual({ serverRevoked: true });
  expect(readdirSync(configPaths(home).dir)).not.toContain("config.json");

  const again = await clearCredentials({ ...opts, fetchImpl: server.fetchImpl });
  expect(again).toEqual({ serverRevoked: null });
});

test("save api key still saves when revoking the previous oauth fails", async () => {
  await writeConfig({ human_id: "keep-me", oauth: previousOauth });
  const server = fakeServer({ revoke: () => new Response("", { status: 500 }) });

  await saveApiKey("tvly-replacement", { ...opts, fetchImpl: server.fetchImpl });

  expect(server.revoked()).toEqual([
    ["old-refresh", "refresh_token"],
    ["old-access", "access_token"],
  ]);
  expect(readConfig(opts)).toEqual({ human_id: "keep-me", api_key: "tvly-replacement" });
});

test("save api key works offline and with an oauth block lacking client_id", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await writeConfig({ oauth: previousOauth });
  await saveApiKey("tvly-offline", { ...opts, fetchImpl: offline });
  expect(readConfig(opts)).toEqual({ api_key: "tvly-offline" });

  await writeConfig({ oauth: { access_token: "a" } });
  await saveApiKey("tvly-no-client", { ...opts, fetchImpl: offline });
  expect(readConfig(opts)).toEqual({ api_key: "tvly-no-client" });
});

test("save oauth session revokes previous before overwrite", async () => {
  await writeConfig({ oauth: previousOauth });
  const server = fakeServer({
    revoke: () => {
      expect(readConfig(opts).oauth).toEqual(previousOauth);
      return ok();
    },
  });

  await saveOauthSession(replacementSession, { ...opts, fetchImpl: server.fetchImpl });

  const stored = readConfig(opts).oauth as Record<string, unknown>;
  expect(server.revoked()).toEqual([
    ["old-refresh", "refresh_token"],
    ["old-access", "access_token"],
  ]);
  expect(server.calls.every((c) => c.params.get("client_id") === "old-client")).toBe(true);
  expect(stored.access_token).toBe("new-access");
  expect(stored.refresh_token).toBe("new-refresh");
  expect(stored.client_id).toBe("new-client");
});

test("save oauth session keeps previous and cleans replacement on failure", async () => {
  await writeConfig({ oauth: previousOauth });
  const server = fakeServer({
    revoke: ({ params }) =>
      new Response("", { status: params.get("token")?.startsWith("old-") ? 500 : 200 }),
  });

  const err = await saveOauthSession(replacementSession, {
    ...opts,
    fetchImpl: server.fetchImpl,
  }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(OAuthError);
  expect((err as Error).message).toMatch(/^Could not replace the previous OAuth session: /);
  expect((err as Error).message).not.toMatch(/also could not be revoked/);
  expect(readConfig(opts)).toEqual({ oauth: previousOauth });
  expect(server.revoked()).toEqual([
    ["old-refresh", "refresh_token"],
    ["old-access", "access_token"],
    ["new-refresh", "refresh_token"],
    ["new-access", "access_token"],
  ]);
  expect(server.calls[2]?.params.get("client_id")).toBe("new-client");
});

test("save oauth session reports when the replacement cleanup also fails", async () => {
  await writeConfig({ oauth: previousOauth });
  const server = fakeServer({ revoke: () => new Response("", { status: 500 }) });

  const err = await saveOauthSession(replacementSession, {
    ...opts,
    fetchImpl: server.fetchImpl,
  }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(OAuthError);
  expect((err as Error).message).toMatch(
    /^Could not replace the previous OAuth session: .+ The new OAuth session also could not be revoked: /,
  );
  expect(readConfig(opts)).toEqual({ oauth: previousOauth });
});

test("malformed expiry refreshes without revoking active session", async () => {
  await writeConfig({
    api_key: "",
    human_id: "h",
    oauth: {
      access_token: "old-access",
      refresh_token: "same-refresh",
      expires_at: "bad",
      token_type: "Bearer",
      client_id: "same-client",
      client_secret: null,
      token_endpoint_auth_method: "none",
      redirect_uri: "http://127.0.0.1:1/callback",
    },
  });
  const server = fakeServer({
    token: () => json({ access_token: "new-access", expires_in: 3600 }),
    revoke: () => {
      throw new Error("automatic refresh must not revoke the active session");
    },
  });

  const accessToken = await getApiKey({ ...opts, fetchImpl: server.fetchImpl });

  expect(accessToken).toBe("new-access");
  const stored = readConfig(opts).oauth as Record<string, unknown>;
  expect(stored.access_token).toBe("new-access");
  expect(stored.refresh_token).toBe("same-refresh");
  expect(stored.client_id).toBe("same-client");
  expect(server.revoked()).toEqual([]);
  // The rewrite drops the (empty) api_key and keeps unrelated fields.
  expect(readConfig(opts)).not.toHaveProperty("api_key");
  expect(readConfig(opts).human_id).toBe("h");
});

test("malformed expiry without refresh is invalid", async () => {
  await writeConfig({ oauth: { access_token: "old-access", expires_at: "bad" } });
  const server = fakeServer();
  expect(await getApiKey({ ...opts, fetchImpl: server.fetchImpl })).toBeNull();
  expect(server.calls).toEqual([]);
});

test("config write keeps previous file when atomic replace fails", async () => {
  await writeConfig({ api_key: "tvly-old" });
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk busy"));

  await expect(saveApiKey("tvly-new", opts)).rejects.toThrow("disk busy");

  expect(readConfig(opts)).toEqual({ api_key: "tvly-old" });
  expect(readdirSync(configPaths(home).dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("parallel expired session refreshes once", async () => {
  await writeConfig({
    oauth: {
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: 0,
      client_id: "same-client",
      client_secret: null,
      token_endpoint_auth_method: "none",
      redirect_uri: "http://127.0.0.1:1/callback",
    },
  });
  let refreshStarted!: () => void;
  const started = new Promise<void>((r) => {
    refreshStarted = r;
  });
  let releaseRefresh!: () => void;
  const released = new Promise<void>((r) => {
    releaseRefresh = r;
  });
  const server = fakeServer({
    token: async ({ params }) => {
      expect(params.get("refresh_token")).toBe("old-refresh");
      refreshStarted();
      await released;
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    },
  });
  const o = { ...opts, fetchImpl: server.fetchImpl };

  const first = getApiKey(o);
  await started;
  const second = getApiKey(o);
  await new Promise((r) => setTimeout(r, 100));
  releaseRefresh();

  expect(await Promise.all([first, second])).toEqual(["new-access", "new-access"]);
  expect(server.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
  expect((readConfig(opts).oauth as Record<string, unknown>).refresh_token).toBe("new-refresh");
});

test("config lock serializes separate processes", async () => {
  await writeConfig({ api_key: "tvly-old" });
  const script = path.join(home, "append.mjs");
  writeFileSync(
    script,
    [
      `import { withConfigLock } from ${JSON.stringify(CONFIG_MODULE)};`,
      "const [home, key] = process.argv.slice(2);",
      "await withConfigLock(async (config) => {",
      "  await new Promise((r) => setTimeout(r, 200));",
      "  return { config: { ...config, [key]: true }, result: undefined };",
      "}, { home });",
    ].join("\n"),
  );
  const run = (key: string) =>
    new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", script, home, key], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
      });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });

  const results = await Promise.all([run("first"), run("second")]);

  expect(results).toEqual([
    { code: 0, stderr: "" },
    { code: 0, stderr: "" },
  ]);
  const raw = await fs.readFile(configPaths(home).file, "utf8");
  expect(JSON.parse(raw)).toEqual({ api_key: "tvly-old", first: true, second: true });
});

test("refresh failure is reported and preserves session", async () => {
  const previous = {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: 0,
    client_id: "same-client",
    client_secret: null,
    token_endpoint_auth_method: "none",
    redirect_uri: "http://127.0.0.1:1/callback",
  };
  await writeConfig({ oauth: previous });
  const fetchImpl = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;

  const err = await getApiKey({ ...opts, fetchImpl }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(OAuthError);
  expect((err as Error).message).toMatch(/^Could not refresh.*network down/);
  expect((err as Error).message).toContain(
    "Could not refresh the stored Tavily OAuth session. The stored credentials were not removed; " +
      "retry the command, and run `tvly login` only if it continues. Details: ",
  );
  expect(readConfig(opts)).toEqual({ oauth: previous });
});

test("api key and oauth replace each other", async () => {
  await saveApiKey("tvly-test-key", opts);
  expect(await getApiKey(opts)).toBe("tvly-test-key");

  const session: OAuthSession = {
    tokens: {
      accessToken: "header.payload.sig",
      refreshToken: "r1",
      expiresAt: expiresAtFromNow(3600),
      tokenType: "Bearer",
    },
    client: {
      clientId: "cid",
      clientSecret: null,
      tokenEndpointAuthMethod: "none",
      redirectUri: "http://127.0.0.1:1/callback",
    },
  };
  await saveOauthSession(session, opts);
  expect(hasStoredOauth(opts)).toBe(true);
  expect(await getApiKey(opts)).toBe("header.payload.sig");
  const stored = readConfig(opts);
  expect(stored).not.toHaveProperty("api_key");

  const server = fakeServer({ revoke: ok });
  await saveApiKey("tvly-other", { ...opts, fetchImpl: server.fetchImpl });
  expect(await getApiKey(opts)).toBe("tvly-other");
  expect(hasStoredOauth(opts)).toBe(false);
  expect(server.revoked()).toEqual([
    ["r1", "refresh_token"],
    ["header.payload.sig", "access_token"],
  ]);
});

test("environment API key wins over stored credentials", async () => {
  await saveApiKey("tvly-stored", opts);
  expect(await getApiKey({ ...opts, env: { TAVILY_API_KEY: "tvly-env" } })).toBe("tvly-env");
});

test("getApiKey with an unwritable HOME and no env key resolves keyless instead of throwing", async () => {
  // A regular file as HOME: ~/.tavily can be neither read nor created.
  const fileHome = path.join(home, "not-a-dir");
  writeFileSync(fileHome, "");
  expect(await getApiKey({ home: fileHome, env: {} })).toBeNull();
});

test("reading a Python-written config returns its unexpired access token", async () => {
  mkdirSync(configPaths(home).dir, { recursive: true });
  copyFileSync(FIXTURE, configPaths(home).file);
  const server = fakeServer();
  expect(await getApiKey({ ...opts, fetchImpl: server.fetchImpl })).toBe("python-access-token");
  expect(getHumanId(opts)).toBe("human-1");
  expect(server.calls).toEqual([]);
});

test.skipIf(process.platform === "win32")("config file is 0600 and directory 0700", async () => {
  await saveApiKey("tvly-x", opts);
  const { dir, file } = configPaths(home);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // A umask that strips the owner's write bit still ends at 0600 (the temp file is chmodded
  // before the rename, which keeps its mode).
  const previous = process.umask(0o277);
  try {
    await saveApiKey("tvly-y", opts);
  } finally {
    process.umask(previous);
  }
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a pre-existing 0-byte Python lock file does not block writes", async () => {
  const { dir } = configPaths(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".config.json.lock"), "");
  await saveApiKey("tvly-x", opts);
  expect(readConfig(opts)).toEqual({ api_key: "tvly-x" });
});

test("withConfigLock returns the result and only writes when config is returned", async () => {
  expect(await withConfigLock(async () => ({ result: 42 }), opts)).toBe(42);
  expect(readdirSync(configPaths(home).dir)).not.toContain("config.json");
  await expect(
    withConfigLock(async () => {
      throw new Error("boom");
    }, opts),
  ).rejects.toThrow("boom");
  // The lock was released despite the throw.
  await saveApiKey("tvly-x", opts);
  expect(readConfig(opts)).toEqual({ api_key: "tvly-x" });
});

test("a lock compromised mid-transaction neither crashes nor fails the write", async () => {
  const lockDir = path.join(configPaths(home).dir, ".config.lock");
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    await withConfigLock(async () => {
      await fs.rm(lockDir, { recursive: true });
      // proper-lockfile refreshes the lock mtime every stale/2 ms; the refresh finds the
      // lock gone and marks it compromised.
      vi.advanceTimersByTime(15_000);
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      return { config: { api_key: "tvly-x" }, result: undefined };
    }, opts);
  } finally {
    vi.useRealTimers();
  }
  expect(readConfig(opts)).toEqual({ api_key: "tvly-x" });
  await saveApiKey("tvly-y", opts);
  expect(readConfig(opts)).toEqual({ api_key: "tvly-y" });
});

test("corrupt config reads as empty", () => {
  mkdirSync(configPaths(home).dir, { recursive: true });
  writeFileSync(configPaths(home).file, "{not json");
  expect(readConfig(opts)).toEqual({});
});

describe("~/.mcp-auth fallback", () => {
  const writeTokens = (name: string, token: string) => {
    const dir = path.join(configPaths(home).mcpAuthDir, "mcp-remote-0.1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify({ access_token: token }));
  };

  test("returns a valid Tavily-issued token", async () => {
    const token = jwt({ iss: "https://mcp.tavily.com/", exp: Date.now() / 1000 + 3600 });
    writeTokens("a_tokens.json", token);
    expect(await getApiKey(opts)).toBe(token);
  });

  test("skips expired and foreign tokens", async () => {
    writeTokens("a_tokens.json", jwt({ iss: "https://mcp.tavily.com/", exp: 1 }));
    writeTokens("b_tokens.json", jwt({ iss: "https://evil.example/" }));
    writeTokens("c_tokens.json", "not-a-jwt");
    expect(await getApiKey(opts)).toBeNull();
  });
});

test("jwt helpers", () => {
  const token = jwt({ iss: "x", sub: "ü" });
  expect(decodeJwtPayload(token)).toEqual({ iss: "x", sub: "ü" });
  expect(decodeJwtPayload("a.b")).toBeNull();
  expect(decodeJwtPayload("a.!!!.c")).toBeNull();
  expect(isOauthToken(token)).toBe(true);
  expect(isOauthToken("tvly-abc")).toBe(false);
  expect(isOauthToken("header.payload.sig")).toBe(false);
});

test("human id and api base url resolve env over config", async () => {
  await writeConfig({ human_id: "cfg-human", api_base_url: "https://cfg.example//" });
  expect(getHumanId(opts)).toBe("cfg-human");
  expect(getApiBaseUrl(opts)).toBe("https://cfg.example");
  const env = { TAVILY_HUMAN_ID: "env-human", TAVILY_API_BASE_URL: "https://env.example/" };
  expect(getHumanId({ ...opts, env })).toBe("env-human");
  expect(getApiBaseUrl({ ...opts, env })).toBe("https://env.example");
  expect(getApiBaseUrl({ home: path.join(home, "empty"), env: {} })).toBeNull();
});

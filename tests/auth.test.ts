import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type AuthDeps, runAuth, runLogin, runLogout } from "../src/commands/auth.js";
import { configPaths, readConfig } from "../src/core/config.js";
import type { OAuthSession } from "../src/core/oauth.js";
import { ExitError, OAuthError } from "../src/errors.js";
import { buildProgram } from "../src/program.js";
import { captureOutput, visible } from "./helpers/capture.js";
import { runProgram, stubClient } from "./helpers/program.js";

const io = captureOutput();

const session: OAuthSession = {
  tokens: {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    tokenType: "Bearer",
  },
  client: {
    clientId: "cid",
    clientSecret: null,
    tokenEndpointAuthMethod: "none",
    redirectUri: "http://127.0.0.1:9999/callback",
  },
};

const storedOauth = {
  access_token: "old-access",
  refresh_token: "old-refresh",
  client_id: "old-client",
  token_endpoint_auth_method: "none",
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tvly-auth-"));
});

function writeConfig(config: Record<string, unknown>): void {
  const { dir, file } = configPaths(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config));
}

/** Discovery 404s (static endpoints); every revoke call gets `revokeStatus`. */
const fetchWith = (revokeStatus: number): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/.well-known/")) return new Response("", { status: 404 });
    if (url.endsWith("/revoke")) return new Response("", { status: revokeStatus });
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;

/** Run the real program in-process with the auth commands bound to `deps`. */
async function runAuthProgram(argv: string[], deps: AuthDeps): Promise<number> {
  const program = buildProgram();
  for (const sub of program.commands) {
    if (sub.name() === "login") sub.action((o, c) => runLogin(o, c, deps));
    if (sub.name() === "logout") sub.action((o, c) => runLogout(o, c, deps));
    if (sub.name() === "auth") sub.action((o, c) => runAuth(o, c, deps));
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
}

const stdoutJson = () => JSON.parse(io.stdout());

describe("logout", () => {
  test("--json reports partial revocation failure and exits 3", async () => {
    writeConfig({ oauth: storedOauth });
    const code = await runAuthProgram(["logout", "--json"], {
      home,
      env: {},
      fetchImpl: fetchWith(500),
    });
    expect(code).toBe(3);
    expect(stdoutJson()).toEqual({
      authenticated: false,
      method: null,
      source: null,
      local_credentials_cleared: true,
      environment_credential_present: false,
      server_revoked: false,
      error:
        "refresh_token: Token revocation failed (HTTP 500).; access_token: Token revocation failed (HTTP 500).",
    });
  });

  test("--json reports a remaining environment credential", async () => {
    const env = { TAVILY_API_KEY: "tvly-environment-secret" };
    const deps = { home, env, fetchImpl: fetchWith(200) };
    expect(await runAuthProgram(["logout", "--json"], deps)).toBe(0);
    expect(JSON.parse(io.stdout().trim().split("\n")[0] ?? "")).toEqual({
      authenticated: true,
      method: "env",
      source: "TAVILY_API_KEY environment variable",
      local_credentials_cleared: true,
      environment_credential_present: true,
      warning:
        "TAVILY_API_KEY is still set and cannot be removed from the parent environment by this process. Run: unset TAVILY_API_KEY",
    });
    expect(io.stdout()).not.toContain("tvly-environment-secret");

    expect(await runAuthProgram(["auth", "--json"], deps)).toBe(0);
    expect(JSON.parse(io.stdout().trim().split("\n").at(-1) ?? "")).toEqual({
      authenticated: true,
      method: "env",
      source: "TAVILY_API_KEY environment variable",
    });
  });

  test("--json reports unauthenticated after cleanup", async () => {
    writeConfig({ api_key: "tvly-stored" });
    const code = await runAuthProgram(["logout", "--json"], {
      home,
      env: {},
      fetchImpl: fetchWith(200),
    });
    expect(code).toBe(0);
    expect(stdoutJson()).toEqual({
      authenticated: false,
      method: null,
      source: null,
      local_credentials_cleared: true,
      environment_credential_present: false,
    });
  });
});

describe("login", () => {
  test.each([
    { name: "--no-browser", argv: ["--json", "login", "--no-browser"], env: { DISPLAY: ":0" } },
    { name: "a headless environment", argv: ["--json", "login"], env: { SSH_CONNECTION: "x" } },
  ])("--json with $name emits the authorization URL on stderr", async ({ argv, env }) => {
    const login = vi.fn<NonNullable<AuthDeps["login"]>>(async (opts) => {
      expect(opts.openBrowser).toBe(false);
      expect(opts.onStatus).toBeTypeOf("function");
      opts.onStatus?.("https://mcp.tavily.com/authorize?client_id=cid");
      return session;
    });
    const code = await runAuthProgram(argv, { home, env, login, fetchImpl: fetchWith(200) });
    expect(code).toBe(0);
    expect(stdoutJson()).toEqual({
      authenticated: true,
      method: "oauth",
      detail: `Token stored in ${configPaths(home).file}`,
    });
    expect(JSON.parse(io.stderr())).toEqual({
      event: "authorization_required",
      authorization_url: "https://mcp.tavily.com/authorize?client_id=cid",
    });
    expect(readConfig({ home, env })).toHaveProperty("oauth.access_token", "access-1");
  });

  test("the printed authorization URL has control bytes stripped", async () => {
    const login = vi.fn<NonNullable<AuthDeps["login"]>>(async (opts) => {
      opts.onStatus?.("https://mcp.tavily.com/authorize?x=\x1b]8;;evil\x07y");
      return session;
    });
    await runAuthProgram(["login", "--no-browser"], {
      home,
      env: { DISPLAY: ":0" },
      login,
      fetchImpl: fetchWith(200),
    });
    expect(io.stderr()).toContain("https://mcp.tavily.com/authorize?x=]8;;evily");
    expect(io.stderr()).not.toContain("\x1b");
    expect(io.stderr()).not.toContain("\x07");
  });

  test("--json with a browser keeps stderr empty", async () => {
    const login = vi.fn<NonNullable<AuthDeps["login"]>>(async (opts) => {
      expect(opts.openBrowser).toBe(true);
      expect(opts.onStatus).toBeUndefined();
      return session;
    });
    const code = await runAuthProgram(["--json", "login"], {
      home,
      env: { DISPLAY: ":0" },
      login,
      fetchImpl: fetchWith(200),
    });
    expect(code).toBe(0);
    expect(stdoutJson().authenticated).toBe(true);
    expect(io.stderr()).toBe("");
  });

  test("--api-key --json reports replacement revocation failure", async () => {
    writeConfig({ oauth: storedOauth });
    const code = await runAuthProgram(["--json", "login", "--api-key", "tvly-replacement"], {
      home,
      env: {},
      fetchImpl: fetchWith(500),
    });
    expect(code).toBe(3);
    const body = stdoutJson();
    expect(body.authenticated).toBe(false);
    expect(body.error).toContain("Token revocation failed (HTTP 500)");
    expect(readConfig({ home, env: {} })).toHaveProperty("oauth.access_token", "old-access");
  });

  test("--api-key --json saves the key", async () => {
    const code = await runAuthProgram(["--json", "login", "--api-key", "tvly-new"], {
      home,
      env: {},
    });
    expect(code).toBe(0);
    expect(stdoutJson()).toEqual({
      authenticated: true,
      method: "api_key",
      detail: `Saved to ${configPaths(home).file}`,
    });
    expect(readConfig({ home, env: {} })).toHaveProperty("api_key", "tvly-new");
  });

  test("oauth --json reports replacement revocation failure", async () => {
    writeConfig({ oauth: storedOauth });
    const login = vi.fn<NonNullable<AuthDeps["login"]>>(async () => session);
    const code = await runAuthProgram(["--json", "login"], {
      home,
      env: { DISPLAY: ":0" },
      login,
      fetchImpl: fetchWith(500),
    });
    expect(code).toBe(3);
    const body = stdoutJson();
    expect(body.authenticated).toBe(false);
    expect(body.error).toContain("Could not replace the previous OAuth session");
  });

  test("a failed oauth login prints the failure block and exits 3", async () => {
    const login = async () => {
      throw new OAuthError("denied");
    };
    const code = await runAuthProgram(["login"], {
      home,
      env: { DISPLAY: ":0" },
      login,
    });
    expect(code).toBe(3);
    expect(visible(io.stderr())).toContain("> denied");
    expect(visible(io.stderr())).toContain("tvly login --api-key tvly-YOUR_KEY");
  });

  test("human success prints the logo and the five get-started lines", async () => {
    const code = await runAuthProgram(["login", "--api-key", "tvly-new"], { home, env: {} });
    expect(code).toBe(0);
    const text = visible(io.stdout());
    expect(text).toContain("> Authenticated via API key");
    expect(text).toContain(`Saved to ${configPaths(home).file}`);
    expect(text).toContain("Get started");
    for (const line of [
      'tvly search "your first query"',
      "tvly extract <url>",
      "tvly crawl <url>",
      "tvly map <url>",
      'tvly research "deep dive topic"',
    ]) {
      expect(text).toContain(line);
    }
  });
});

describe("auth", () => {
  test("human output masks the key as first 8, ..., last 4", async () => {
    writeConfig({ api_key: "tvly-abcdefghijklmnop" });
    const code = await runAuthProgram(["auth"], { home, env: {} });
    expect(code).toBe(0);
    const text = visible(io.stdout());
    expect(text).toContain(`Authenticated via config file (${configPaths(home).file})`);
    expect(text).toContain("Key: tvly-abc...mnop");
    expect(text).not.toContain("abcdefghijklmnop");
  });

  test("short keys are fully masked", async () => {
    await runAuthProgram(["auth"], { home, env: { TAVILY_API_KEY: "tvly-short" } });
    expect(visible(io.stdout())).toContain("Key: ***");
  });

  test("reports not authenticated", async () => {
    await runAuthProgram(["auth"], { home, env: {} });
    expect(visible(io.stdout())).toContain("> Not authenticated");
    expect(visible(io.stdout())).toContain("Run tvly login to authenticate.");
  });
});

test("search --json reports refresh failure without a keyless fallback", async () => {
  const getClientOrKeyless = async () => {
    throw new OAuthError("network down");
  };
  const code = await runProgram(["search", "query", "--json"], stubClient({}), {
    getClientOrKeyless,
  });
  expect(code).toBe(3);
  expect(stdoutJson()).toEqual({
    error: { code: "oauth_refresh_failed", message: "network down" },
  });
});

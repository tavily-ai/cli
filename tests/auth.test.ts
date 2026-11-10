import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type LoginHooks, runLogin } from "../src/commands/auth.js";
import { configPaths, readConfig } from "../src/core/config.js";
import type { OAuthSession } from "../src/core/oauth.js";
import { ExitError, OAuthError } from "../src/errors.js";
import type { Host } from "../src/host.js";
import { captureOutput, visible } from "./helpers/capture.js";
import { fakeHost, runProgram } from "./helpers/program.js";

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

const host = (over: Partial<Host> = {}) => fakeHost({ home, ...over });

/** `tvly login` with the browser login stubbed; the exit code `cli.ts` would set. */
async function login(
  opts: { apiKey?: string; browser?: boolean },
  json: boolean,
  h: Host,
  hook: NonNullable<LoginHooks["login"]>,
): Promise<number> {
  const cmd = new Command().option("--json");
  cmd.setOptionValue("json", json);
  try {
    await runLogin(opts, cmd, h, { login: hook });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

const stdoutJson = () => JSON.parse(io.stdout());

describe("logout", () => {
  test("--json reports partial revocation failure and exits 3", async () => {
    writeConfig({ oauth: storedOauth });
    const code = await runProgram(["logout", "--json"], host({ fetch: fetchWith(500) }));
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
    const h = host({ env: { TAVILY_API_KEY: "tvly-environment-secret" }, fetch: fetchWith(200) });
    expect(await runProgram(["logout", "--json"], h)).toBe(0);
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

    expect(await runProgram(["auth", "--json"], h)).toBe(0);
    expect(JSON.parse(io.stdout().trim().split("\n").at(-1) ?? "")).toEqual({
      authenticated: true,
      method: "env",
      source: "TAVILY_API_KEY environment variable",
    });
  });

  test("--json reports unauthenticated after cleanup", async () => {
    writeConfig({ api_key: "tvly-stored" });
    const code = await runProgram(["logout", "--json"], host({ fetch: fetchWith(200) }));
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
    { name: "--no-browser", opts: { browser: false }, env: { DISPLAY: ":0" } },
    { name: "a headless environment", opts: {}, env: { SSH_CONNECTION: "x" } },
  ])("--json with $name emits the authorization URL on stderr", async ({ opts, env }) => {
    const hook = vi.fn<NonNullable<LoginHooks["login"]>>(async (o) => {
      expect(o.openBrowser).toBe(false);
      expect(o.onStatus).toBeTypeOf("function");
      o.onStatus?.("https://mcp.tavily.com/authorize?client_id=cid");
      return session;
    });
    const h = host({ env, fetch: fetchWith(200) });
    expect(await login(opts, true, h, hook)).toBe(0);
    expect(stdoutJson()).toEqual({
      authenticated: true,
      method: "oauth",
      detail: `Token stored in ${configPaths(home).file}`,
    });
    expect(JSON.parse(io.stderr())).toEqual({
      event: "authorization_required",
      authorization_url: "https://mcp.tavily.com/authorize?client_id=cid",
    });
    expect(readConfig(h)).toHaveProperty("oauth.access_token", "access-1");
  });

  test("the printed authorization URL has control bytes stripped", async () => {
    const hook = vi.fn<NonNullable<LoginHooks["login"]>>(async (o) => {
      o.onStatus?.("https://mcp.tavily.com/authorize?x=\x1b]8;;evil\x07y");
      return session;
    });
    await login(
      { browser: false },
      false,
      host({ env: { DISPLAY: ":0" }, fetch: fetchWith(200) }),
      hook,
    );
    expect(io.stderr()).toContain("https://mcp.tavily.com/authorize?x=]8;;evily");
    expect(io.stderr()).not.toContain("\x1b");
    expect(io.stderr()).not.toContain("\x07");
  });

  test("--api-key --json saves the key, even when revoking the old oauth fails", async () => {
    writeConfig({ oauth: storedOauth });
    const h = host({ fetch: fetchWith(500) });
    const code = await runProgram(["--json", "login", "--api-key", "tvly-new"], h);
    expect(code).toBe(0);
    expect(stdoutJson()).toEqual({
      authenticated: true,
      method: "api_key",
      detail: `Saved to ${configPaths(home).file}`,
    });
    expect(readConfig(h)).toEqual({ api_key: "tvly-new" });
  });

  test("oauth --json reports replacement revocation failure", async () => {
    writeConfig({ oauth: storedOauth });
    const h = host({ env: { DISPLAY: ":0" }, fetch: fetchWith(500) });
    expect(await login({}, true, h, async () => session)).toBe(3);
    const body = stdoutJson();
    expect(body.authenticated).toBe(false);
    expect(body.error).toContain("Could not replace the previous OAuth session");
  });

  test("a failed oauth login prints the failure block and exits 3", async () => {
    const hook = async () => {
      throw new OAuthError("denied");
    };
    expect(await login({}, false, host({ env: { DISPLAY: ":0" } }), hook)).toBe(3);
    expect(visible(io.stderr())).toContain("> denied");
    expect(visible(io.stderr())).toContain("tvly login --api-key tvly-YOUR_KEY");
  });

  test("human success prints the logo and the five get-started lines", async () => {
    const code = await runProgram(["login", "--api-key", "tvly-new"], host());
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
  test("short keys are fully masked", async () => {
    await runProgram(["auth"], host({ env: { TAVILY_API_KEY: "tvly-short" } }));
    expect(visible(io.stdout())).toContain("Key: ***");
  });

  test("reports not authenticated", async () => {
    await runProgram(["auth"], host());
    expect(visible(io.stdout())).toContain("> Not authenticated");
    expect(visible(io.stdout())).toContain("Run tvly login to authenticate.");
  });
});

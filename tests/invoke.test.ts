import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import { Command } from "commander";
import { afterEach, expect, test, vi } from "vitest";
import { type InvokeOptions, invoke } from "../src/commands/invoke.js";
import { configPaths } from "../src/core/config.js";
import type { Json } from "../src/core/tavily-client.js";
import { ExitError } from "../src/errors.js";
import { keylessCapError } from "../src/ui/keyless.js";
import { captureOutput, visible } from "./helpers/capture.js";
import { runProgram, stubClient } from "./helpers/program.js";

const io = captureOutput();
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const capError = () =>
  new TavilyKeylessLimitError({
    message: "Daily cap",
    capType: "daily",
    retryAfter: 3600,
    bonusEligible: false,
    continuationPaths: [{ type: "signup", url: "https://tavily.com/signup" }],
    window: "day",
  });

/** Run `fn` through `invoke` with `tvly-test` as the key; the exit code, or -1 when it returned. */
async function exitCode(
  args: string[],
  fn: () => Promise<Json>,
  opts: InvokeOptions = { keyed: false },
): Promise<number> {
  vi.stubEnv("TAVILY_API_KEY", "tvly-test");
  const cmd = new Command().option("--json");
  cmd.parse(args, { from: "user" });
  const ctx = { resolveClient: async () => stubClient({ search: fn }) };
  try {
    await invoke(cmd, ctx, opts, (client) => client.search({}));
    return -1;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

const reject = (e: unknown) => async (): Promise<Json> => {
  throw e;
};

test("a keyless cap hit exits 3 in JSON and human modes", async () => {
  expect(await exitCode(["--json"], reject(capError()))).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual({ error: keylessCapError(capError()) });
  expect(await exitCode([], reject(capError()))).toBe(3);
  const text = visible(io.stderr());
  expect(text).toContain("  > Tavily rate limit reached.");
  expect(text).toContain("    Retry after: 1h (3600s)");
  expect(text).toContain("      - Sign up for a Tavily API key:  https://tavily.com/signup");
  expect(text).toContain("  Run tvly login to authenticate and remove this cap.");
});

test("limit statuses 429 and 432 print the upgrade block and exit 3", async () => {
  for (const status of [429, 432]) {
    const before = io.stderr().length;
    const e = new TavilyRequestError({
      status,
      body: null,
      message: "Plan limit",
      docs: "https://docs.tavily.com/x",
    });
    expect(await exitCode([], reject(e))).toBe(3);
    expect(visible(io.stderr().slice(before)).split("\n")).toEqual([
      "",
      "  > Plan limit",
      "",
      "  Upgrade your plan at tavily.com",
      "  Docs: https://docs.tavily.com/x",
      "",
      "",
    ]);
  }
  const limit = new TavilyRequestError({ status: 432, body: null, message: "m" });
  expect(await exitCode(["--json"], reject(limit))).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual({ error: "m" });
});

test("auth statuses 401 and 403 keep the API message and exit 3", async () => {
  const message = "Unauthorized: missing or invalid API key.";
  for (const status of [401, 403]) {
    const e = new TavilyRequestError({ status, body: null, message });
    const before = io.stderr().length;
    expect(await exitCode([], reject(e))).toBe(3);
    expect(visible(io.stderr().slice(before))).toBe(`  > Error: ${message}\n`);
  }
  const e = new TavilyRequestError({ status: 401, body: null, message });
  expect(await exitCode(["--json"], reject(e))).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual({ error: message });
});

test("other errors print to stderr and exit 4; a returned value passes through", async () => {
  expect(await exitCode([], reject(new Error("bo\x1b[2Jom")))).toBe(4);
  expect(visible(io.stderr())).toBe("  > Error: bo[2Jom\n");
  expect(io.stdout()).toBe("");
  expect(await exitCode([], async () => ({}))).toBe(-1);
});

/** A HOME holding an expired OAuth session, with every network call failing. */
function expiredSessionHome(): void {
  const home = mkdtempSync(join(tmpdir(), "tvly-invoke-"));
  const { dir, file } = configPaths(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      oauth: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_at: 0,
        client_id: "same-client",
        client_secret: null,
        token_endpoint_auth_method: "none",
        redirect_uri: "http://127.0.0.1:1/callback",
      },
    }),
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TAVILY_API_KEY", "");
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("network down");
  });
}

test("a failed OAuth refresh exits 3 with the oauth_refresh_failed payload", async () => {
  expiredSessionHome();
  const resolveClient = vi.fn(async () => stubClient({}));
  const cmd = new Command().option("--json");
  cmd.parse(["--json"], { from: "user" });
  const code = await invoke(cmd, { resolveClient }, { keyed: false }, async () => {}).catch(
    (e: ExitError) => e.code,
  );
  expect(code).toBe(3);
  expect(resolveClient).not.toHaveBeenCalled();
  const payload = JSON.parse(io.stdout());
  expect(payload.error.code).toBe("oauth_refresh_failed");
  expect(payload.error.message).toMatch(/^Could not refresh.*network down$/);
});

test.each(["search", "crawl"])(
  "%s --json reports a stored-session refresh failure without a keyless fallback",
  async (command) => {
    expiredSessionHome();
    const code = await runProgram([command, "https://a.example", "--json"], stubClient({}));
    expect(code).toBe(3);
    expect(JSON.parse(io.stdout()).error.code).toBe("oauth_refresh_failed");
  },
);

test("a keyed command without a key prints why and exits 3", async () => {
  const home = mkdtempSync(join(tmpdir(), "tvly-invoke-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TAVILY_API_KEY", "");
  const resolveClient = vi.fn(async () => stubClient({}));
  const cmd = new Command().option("--json");
  cmd.parse([], { from: "user" });
  const code = await invoke(cmd, { resolveClient }, { keyed: "crawl" }, async () => {}).catch(
    (e: ExitError) => e.code,
  );
  expect(code).toBe(3);
  expect(resolveClient).not.toHaveBeenCalled();
  expect(io.stdout()).toBe("");
  expect(visible(io.stderr())).toContain("  > The crawl command requires a Tavily API key.");
});

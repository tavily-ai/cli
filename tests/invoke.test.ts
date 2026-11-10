import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TavilyRequestError } from "@tavily/core";
import { Command } from "commander";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "../src/commands/invoke.js";
import { configPaths } from "../src/core/config.js";
import type { ExitError } from "../src/errors.js";
import { captureOutput, visible } from "./helpers/capture.js";
import { runProgram, stubClient } from "./helpers/program.js";

const io = captureOutput();
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const failing = (e: unknown) =>
  stubClient({
    search: async () => {
      throw e;
    },
  });

test.each([401, 403])("auth status %i keeps the API message and exits 3", async (status) => {
  const message = "Unauthorized: missing or invalid API key.";
  const client = failing(new TavilyRequestError({ status, body: null, message }));
  expect(await runProgram(["search", "q"], client)).toBe(3);
  expect(visible(io.stderr())).toBe(`  > Error: ${message}\n`);
  expect(await runProgram(["search", "q", "--json"], client)).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual({ error: message });
});

test("other errors print to stderr with control bytes stripped and exit 4", async () => {
  expect(await runProgram(["search", "q"], failing(new Error("bo\x1b[2Jom")))).toBe(4);
  expect(visible(io.stderr())).toBe("  > Error: bo[2Jom\n");
  expect(io.stdout()).toBe("");
});

/** An empty HOME, or one holding an expired OAuth session whose refresh fails on the network. */
function stubHome(expiredSession: boolean): void {
  const home = mkdtempSync(join(tmpdir(), "tvly-invoke-"));
  if (expiredSession) {
    const { dir, file } = configPaths(home);
    mkdirSync(dir, { recursive: true });
    const oauth = { access_token: "old", refresh_token: "old", expires_at: 0, client_id: "c" };
    writeFileSync(file, JSON.stringify({ oauth }));
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TAVILY_API_KEY", "");
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("network down");
  });
}

test.each(["search", "crawl"])(
  "%s --json reports a stored-session refresh failure without a keyless fallback",
  async (command) => {
    stubHome(true);
    expect(await runProgram([command, "https://a.example", "--json"], stubClient({}))).toBe(3);
    const { error } = JSON.parse(io.stdout());
    expect(error.code).toBe("oauth_refresh_failed");
    expect(error.message).toMatch(/^Could not refresh.*network down$/);
  },
);

test("a keyed command without a key prints why and exits 3 before resolving a client", async () => {
  stubHome(false);
  const ctx = { resolveClient: vi.fn(async () => stubClient({})) };
  const code = await invoke(new Command(), ctx, { keyed: "crawl" }, async () => {}).catch(
    (e: ExitError) => e.code,
  );
  expect(code).toBe(3);
  expect(ctx.resolveClient).not.toHaveBeenCalled();
  expect(io.stdout()).toBe("");
  expect(visible(io.stderr())).toContain("  > The crawl command requires a Tavily API key.");
});

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type McpDeps, runMcp } from "../src/commands/setup.js";
import type { McpSetupResult } from "../src/core/mcp-setup.js";
import { captureOutput } from "./helpers/capture.js";
import { runProgram } from "./helpers/program.js";

const io = captureOutput();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tvly-setup-"));
});

const runSetup = (argv: string[], deps: McpDeps) =>
  runProgram(["setup", "mcp", ...argv], undefined, {
    actions: { "setup mcp": (o, c) => runMcp(o, c, deps) },
  });

const configuring = (outcome?: Partial<McpSetupResult>) =>
  vi.fn(async (agents: string[]) => ({
    configured: agents,
    skipped: [],
    auth: "oauth" as const,
    ...outcome,
  }));

describe("setup mcp", () => {
  test("--agent all expands to every supported agent", async () => {
    const installMcp = configuring();
    expect(await runSetup(["--agent", "all"], { home, env: {}, installMcp })).toBe(0);
    expect(installMcp).toHaveBeenCalledWith(["claude-code", "codex", "cursor"], {
      keyless: false,
      home,
      env: {},
    });
    expect(io.stdout()).toContain("✓ claude-code: Tavily MCP server added");
    expect(io.stdout()).toContain("open a browser to sign in to Tavily");
  });

  test("detected agents are the default, --keyless is passed through", async () => {
    mkdirSync(join(home, ".codex"));
    const installMcp = configuring({ auth: "env" });
    expect(await runSetup(["--keyless"], { home, env: {}, installMcp })).toBe(0);
    expect(installMcp).toHaveBeenCalledWith(["codex"], { keyless: true, home, env: {} });
  });

  test("nothing configured exits one and lists the reasons", async () => {
    const skipped = [{ agent: "codex", reason: "codex is not on PATH" }];
    const installMcp = configuring({ configured: [], skipped });
    expect(await runSetup(["--agent", "codex", "--json"], { home, env: {}, installMcp })).toBe(1);
    expect(JSON.parse(io.stdout())).toEqual({ ok: false, configured: [], skipped, auth: "oauth" });

    expect(await runSetup(["--agent", "codex"], { home, env: {}, installMcp })).toBe(1);
    expect(io.stdout()).toContain("• codex: skipped (codex is not on PATH)");
  });

  test("no detected agents prints a hint and exits zero", async () => {
    const installMcp = configuring();
    expect(await runSetup([], { home, env: {}, installMcp })).toBe(0);
    expect(io.stdout()).toContain("No supported agents detected.");
  });
});

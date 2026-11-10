import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MCP_SERVER_URL } from "../src/core/mcp-setup.js";
import { captureOutput } from "./helpers/capture.js";
import { fakeExec } from "./helpers/exec.js";
import { fakeHost, runProgram } from "./helpers/program.js";

const io = captureOutput();

/** The agent each recorded run configured. */
const agentsOf = (exec: ReturnType<typeof fakeExec>) =>
  exec.calls.map((c) => c.args[c.args.indexOf("--agent") + 1]);

describe("setup mcp", () => {
  test("--agent all expands to every supported agent", async () => {
    const exec = fakeExec();
    expect(await runProgram(["setup", "mcp", "--agent", "all"], fakeHost({ exec }))).toBe(0);
    expect(agentsOf(exec)).toEqual(["claude-code", "codex", "cursor"]);
    expect(
      exec.calls.every((c) => c.bin === "/usr/bin/npx" && c.args.includes(MCP_SERVER_URL)),
    ).toBe(true);
    expect(io.stdout()).toContain("✓ claude-code: Tavily MCP server added");
    expect(io.stdout()).toContain("open a browser to sign in to Tavily");
  });

  test("detected agents are the default, --keyless is passed through", async () => {
    const exec = fakeExec();
    const host = fakeHost({ exec, env: { TAVILY_API_KEY: "tvly-x" } });
    mkdirSync(join(host.home, ".codex"));
    expect(await runProgram(["setup", "mcp", "--keyless"], host)).toBe(0);
    expect(agentsOf(exec)).toEqual(["codex"]);
    // Keyless: the URL alone through add-mcp, not `codex mcp add` with the env reference.
    expect(exec.calls[0]?.bin).toBe("/usr/bin/npx");
    expect(exec.calls[0]?.args).not.toContain("--header");
    expect(io.stdout()).toContain("open a browser to sign in to Tavily");
  });

  test("nothing configured exits one and lists the reasons", async () => {
    const which = (name: string) => (name === "codex" ? null : `/usr/bin/${name}`);
    const host = fakeHost({ exec: fakeExec({ which }), env: { TAVILY_API_KEY: "tvly-x" } });
    expect(await runProgram(["setup", "mcp", "--agent", "codex", "--json"], host)).toBe(1);
    const skipped = [{ agent: "codex", reason: "codex is not on PATH" }];
    expect(JSON.parse(io.stdout())).toEqual({ ok: false, configured: [], skipped, auth: "env" });

    expect(await runProgram(["setup", "mcp", "--agent", "codex"], host)).toBe(1);
    expect(io.stdout()).toContain("• codex: skipped (codex is not on PATH)");
  });

  test("no detected agents prints a hint and exits zero", async () => {
    const exec = fakeExec();
    expect(await runProgram(["setup", "mcp"], fakeHost({ exec }))).toBe(0);
    expect(exec.calls).toEqual([]);
    expect(io.stdout()).toContain("No supported agents detected.");
  });
});

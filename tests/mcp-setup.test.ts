import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";
import { installMcp, MCP_SERVER_URL } from "../src/core/mcp-setup.js";

const NPX = "/usr/bin/npx";
const CODEX = "/usr/local/bin/codex";
const ALL = ["claude-code", "codex", "cursor"];
// The literal placeholders are the point: each client expands them from its own environment.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal on purpose
const CLAUDE_HEADER = "Authorization: Bearer ${TAVILY_API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal on purpose
const CURSOR_HEADER = "Authorization: Bearer ${env:TAVILY_API_KEY}";

type Call = { cmd: string; args: string[]; opts: Record<string, unknown> };

function result(status: number, stderr = ""): SpawnSyncReturns<string> {
  return { status, stderr, stdout: "", signal: null, pid: 1, output: [null, "", stderr] };
}

function recorder(calls: Call[], status = () => 0) {
  return ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return result(status(), "Error: write failed\n");
  }) as never;
}

const addMcpArgs = (agent: string, header?: string) => [
  "--yes",
  "add-mcp@1.14.0",
  MCP_SERVER_URL,
  "--name",
  "tavily",
  "--transport",
  "http",
  ...(header ? ["--header", header] : []),
  "--agent",
  agent,
  "--global",
  "--yes",
];

const which = (name: string) => (name === "npx" ? NPX : name === "codex" ? CODEX : null);

describe("installMcp", () => {
  it("with TAVILY_API_KEY exported writes an environment reference, never the key", async () => {
    const calls: Call[] = [];
    const out = await installMcp(ALL, {
      keyless: false,
      env: { TAVILY_API_KEY: "tvly-secret" },
      which,
      spawnImpl: recorder(calls),
      platform: "linux",
    });
    expect(out).toEqual({ configured: ALL, skipped: [], auth: "env" });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      [NPX, ...addMcpArgs("claude-code", CLAUDE_HEADER)],
      [
        CODEX,
        "mcp",
        "add",
        "tavily",
        "--url",
        MCP_SERVER_URL,
        "--bearer-token-env-var",
        "TAVILY_API_KEY",
      ],
      [NPX, ...addMcpArgs("cursor", CURSOR_HEADER)],
    ]);
    // No shell, so the ${...} text reaches add-mcp unexpanded.
    expect(calls.every((c) => c.opts.shell === false)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("tvly-secret");
  });

  it("without a key, or with --keyless, passes the URL alone for OAuth", async () => {
    for (const env of [{}, { TAVILY_API_KEY: "tvly-secret" }]) {
      const calls: Call[] = [];
      const out = await installMcp(ALL, {
        keyless: env.TAVILY_API_KEY !== undefined,
        env,
        which,
        spawnImpl: recorder(calls),
        platform: "linux",
      });
      expect(out).toEqual({ configured: ALL, skipped: [], auth: "oauth" });
      expect(calls.map((c) => c.args)).toEqual(ALL.map((agent) => addMcpArgs(agent)));
    }
  });

  it("skips codex when its binary is missing and still configures the others", async () => {
    const calls: Call[] = [];
    const out = await installMcp(ALL, {
      keyless: false,
      env: { TAVILY_API_KEY: "tvly-secret" },
      which: (name) => (name === "npx" ? NPX : null),
      spawnImpl: recorder(calls),
      platform: "linux",
    });
    expect(out.configured).toEqual(["claude-code", "cursor"]);
    expect(out.skipped).toEqual([{ agent: "codex", reason: "codex is not on PATH" }]);
    expect(calls).toHaveLength(2);
  });

  it("reports an add-mcp failure as a skip with its last output line", async () => {
    const calls: Call[] = [];
    const out = await installMcp(["cursor"], {
      keyless: true,
      env: {},
      which,
      spawnImpl: recorder(calls, () => 1),
    });
    expect(out.skipped).toEqual([{ agent: "cursor", reason: "Error: write failed" }]);
  });

  it("requires npx", async () => {
    await expect(
      installMcp(["cursor"], { keyless: true, env: {}, which: () => null }),
    ).rejects.toThrow(/requires Node\.js/);
  });
});

import { describe, expect, it } from "vitest";
import { installMcp, MCP_SERVER_URL } from "../src/core/mcp-setup.js";
import { fakeExec } from "./helpers/exec.js";

const NPX = "/usr/bin/npx";
const CODEX = "/usr/local/bin/codex";
const ALL = ["claude-code", "codex", "cursor"];
// The literal placeholders are the point: each client expands them from its own environment.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal on purpose
const CLAUDE_HEADER = "Authorization: Bearer ${TAVILY_API_KEY}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal on purpose
const CURSOR_HEADER = "Authorization: Bearer ${env:TAVILY_API_KEY}";

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
    const exec = fakeExec({ which });
    const out = await installMcp(ALL, false, { env: { TAVILY_API_KEY: "tvly-secret" }, exec });
    expect(out).toEqual({ configured: ALL, skipped: [], auth: "env" });
    expect(exec.calls.map((c) => [c.bin, ...c.args])).toEqual([
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
    expect(exec.calls.every((c) => c.opts.timeoutMs === 300_000)).toBe(true);
    expect(JSON.stringify(exec.calls)).not.toContain("tvly-secret");
  });

  it("without a key, or with --keyless, passes the URL alone for OAuth", async () => {
    for (const env of [{}, { TAVILY_API_KEY: "tvly-secret" }]) {
      const exec = fakeExec({ which });
      const out = await installMcp(ALL, env.TAVILY_API_KEY !== undefined, { env, exec });
      expect(out).toEqual({ configured: ALL, skipped: [], auth: "oauth" });
      expect(exec.calls.map((c) => c.args)).toEqual(ALL.map((agent) => addMcpArgs(agent)));
    }
  });

  it("skips codex when its binary is missing and still configures the others", async () => {
    const exec = fakeExec({ which: (name) => (name === "npx" ? NPX : null) });
    const out = await installMcp(ALL, false, { env: { TAVILY_API_KEY: "tvly-secret" }, exec });
    expect(out.configured).toEqual(["claude-code", "cursor"]);
    expect(out.skipped).toEqual([{ agent: "codex", reason: "codex is not on PATH" }]);
    expect(exec.calls).toHaveLength(2);
  });

  it("reports an add-mcp failure as a skip with its failure summary", async () => {
    const exec = fakeExec({ which, run: () => ({ ok: false, failure: "Error: write failed" }) });
    const out = await installMcp(["cursor"], true, { env: {}, exec });
    expect(out.skipped).toEqual([{ agent: "cursor", reason: "Error: write failed" }]);
  });

  it("requires npx", async () => {
    await expect(
      installMcp(["cursor"], true, { env: {}, exec: fakeExec({ which: () => null }) }),
    ).rejects.toThrow(/requires Node\.js/);
  });
});

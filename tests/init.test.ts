import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type InitDeps, run } from "../src/commands/init.js";
import { ExitError } from "../src/errors.js";
import { buildProgram } from "../src/program.js";
import { captureOutput } from "./helpers/capture.js";
import { stubClient } from "./helpers/program.js";

const io = captureOutput();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tvly-init-"));
});

const okClient = stubClient({ search: async () => ({ results: [] }) });

/** Run the real program in-process with `init` bound to `deps`; returns the exit code. */
async function runInit(argv: string[], deps: InitDeps): Promise<number> {
  const program = buildProgram();
  for (const sub of program.commands) {
    if (sub.name() === "init") sub.action((o, c) => run(o, c, deps));
  }
  try {
    await program.parseAsync(["init", ...argv], { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
}

const stdoutJson = () => JSON.parse(io.stdout());

describe("init", () => {
  test("skips skills without detected agents", async () => {
    const installSkills = vi.fn();
    const code = await runInit(["--json"], {
      home,
      env: { TAVILY_API_KEY: "tvly-test" },
      installSkills,
      which: () => "/usr/bin/tvly",
      client: okClient,
    });
    expect(code).toBe(0);
    expect(installSkills).not.toHaveBeenCalled();
    expect(stdoutJson().skills.skipped).toBe(true);
  });

  test("--json reuses environment auth", async () => {
    mkdirSync(join(home, ".codex"));
    const code = await runInit(["--json"], {
      home,
      env: { TAVILY_API_KEY: "tvly-test" },
      installSkills: async (agents) => ({ agents, restartRequired: true }),
      which: () => "/usr/bin/tvly",
      client: okClient,
    });
    expect(code).toBe(0);
    const output = stdoutJson();
    expect(output.ok).toBe(true);
    expect(output.auth).toEqual({ authenticated: true, method: "env" });
    expect(output.skills.agents).toEqual(["codex"]);
    expect(output.skills.restart_required).toBe(true);
    expect(output.skills.source).toBe("tavily-ai/skills");
    expect(output.verification.live_search).toBe(true);
  });

  test("non-interactive auth failure is JSON", async () => {
    const code = await runInit(["--skip-skills", "--json"], {
      home,
      env: {},
      stdinIsTTY: false,
      which: () => "/usr/bin/tvly",
      client: okClient,
    });
    expect(code).toBe(3);
    const output = stdoutJson();
    expect(output.ok).toBe(false);
    expect(output.error.stage).toBe("auth");
    expect(output.skills.skipped).toBe(true);
  });

  test("the OAuth URL is printed with control bytes stripped", async () => {
    const code = await runInit(["--no-browser", "--skip-skills", "--json"], {
      home,
      env: {},
      which: () => "/usr/bin/tvly",
      client: okClient,
      login: async (opts) => {
        opts.onStatus?.("https://mcp.tavily.com/authorize?x=\x1b[2Jy");
        return {
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
      },
    });
    expect(code).toBe(0);
    expect(io.stderr()).toContain(
      "Open this URL to authenticate: https://mcp.tavily.com/authorize?x=[2Jy",
    );
    expect(io.stderr()).not.toContain("\x1b");
  });

  test("live search failure exits four", async () => {
    const code = await runInit(["--skip-auth", "--skip-skills", "--json"], {
      home,
      env: {},
      which: () => "/usr/bin/tvly",
      client: stubClient({ search: async () => ({}) }),
    });
    expect(code).toBe(4);
    expect(stdoutJson().error.stage).toBe("live_search");
  });

  test("never installs skills for an empty agent list", async () => {
    const installSkills = vi.fn();
    const code = await runInit(["--all", "--json"], {
      home,
      env: { TAVILY_API_KEY: "tvly-test" },
      installSkills,
      which: () => "/usr/bin/tvly",
      client: okClient,
    });
    expect(code).toBe(0);
    expect(installSkills).not.toHaveBeenCalled();
    expect(stdoutJson().skills).toMatchObject({ agents: [], skipped: true });
  });

  test("--all with --agent is a usage error", async () => {
    const code = await runInit(["--all", "--agent", "codex"], { home, env: {} });
    expect(code).toBe(2);
    expect(io.stderr()).toContain("error: Use either --all or --agent, not both.");
  });

  test("--agent rejects unknown names and accepts any case", async () => {
    const installSkills = vi.fn();
    const code = await runInit(["--agent", "bogus"], { home, env: {}, installSkills });
    expect(code).toBe(2);
    expect(io.stderr()).toContain("Allowed choices are claude-code, codex, cursor.");
    expect(installSkills).not.toHaveBeenCalled();

    const ok = await runInit(["--agent", "CODEX", "--agent", "codex", "--json"], {
      home,
      env: { TAVILY_API_KEY: "tvly-test" },
      installSkills: async (agents) => ({ agents, restartRequired: false }),
      which: () => "/usr/bin/tvly",
      client: okClient,
    });
    expect(ok).toBe(0);
    expect(stdoutJson().skills.agents).toEqual(["codex"]);
  });

  test("--skip-auth with --api-key is a usage error", async () => {
    const code = await runInit(["--skip-auth", "--api-key", "tvly-x"], { home, env: {} });
    expect(code).toBe(2);
    expect(io.stderr()).toContain("error: Use either --skip-auth or --api-key, not both.");
  });

  test("--skip-skills --skip-auth without a key reports keyless mode", async () => {
    const code = await runInit(["--skip-skills", "--skip-auth", "--json"], {
      home,
      env: {},
      which: () => "/usr/bin/tvly",
      client: okClient,
    });
    expect(code).toBe(0);
    const output = stdoutJson();
    expect(output.mode).toBe("keyless");
    expect(output.skills.skipped).toBe(true);
  });
});

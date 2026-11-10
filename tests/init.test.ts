import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type InitDeps, run } from "../src/commands/init.js";
import { detectPackageManager } from "../src/core/install-detect.js";
import { SKILLS_REPO, WORKFLOWS_REPO } from "../src/core/skills.js";
import { captureOutput } from "./helpers/capture.js";
import { runProgram, stubClient } from "./helpers/program.js";

const io = captureOutput();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tvly-init-"));
});

const okClient = stubClient({ search: async () => ({ results: [] }) });

/** Run the real program in-process with `init` bound to `deps`; returns the exit code. */
const runInit = (argv: string[], deps: InitDeps) =>
  runProgram(["init", ...argv], undefined, { actions: { init: (o, c) => run(o, c, deps) } });

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
    expect(stdoutJson().skills).toMatchObject({ agents: [], skipped: true });
  });

  test("--json reuses environment auth", async () => {
    mkdirSync(join(home, ".codex"));
    const code = await runInit(["--json"], {
      home,
      env: { TAVILY_API_KEY: "tvly-test" },
      installSkills: async (_repo, agents) => ({ agents, restartRequired: true }),
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
      installSkills: async (_repo, agents) => ({ agents, restartRequired: false }),
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

describe("init workflows", () => {
  const WORKFLOWS_QUESTION = `Install the Tavily official workflows (${WORKFLOWS_REPO})?`;

  function setup(answers: { skills?: boolean; workflows?: boolean } = {}) {
    mkdirSync(join(home, ".codex"));
    const confirm = vi.fn(async (question: string, defaultYes?: boolean) =>
      defaultYes === false
        ? false
        : question === WORKFLOWS_QUESTION
          ? (answers.workflows ?? true)
          : (answers.skills ?? true),
    );
    const installSkills = vi.fn(async (_repo: string, agents: string[]) => ({
      agents,
      restartRequired: false,
    }));
    const deps: InitDeps = {
      home,
      env: { TAVILY_API_KEY: "tvly-test" },
      which: () => "/usr/bin/tvly",
      client: okClient,
      stdinIsTTY: true,
      confirm,
      installSkills,
    };
    return { deps, confirm, installSkills };
  }

  test("installs the workflows when the prompt is accepted", async () => {
    const { deps, confirm, installSkills } = setup();
    expect(await runInit([], deps)).toBe(0);
    expect(confirm).toHaveBeenCalledWith(WORKFLOWS_QUESTION);
    expect(installSkills).toHaveBeenCalledWith(SKILLS_REPO, ["codex"]);
    expect(installSkills).toHaveBeenCalledWith(WORKFLOWS_REPO, ["codex"]);
    expect(io.stdout()).toContain("Tavily workflows ready for codex");
  });

  // --json never prompts, so the declined prompts are checked through the human summary.
  test("declining the workflows prompt skips them", async () => {
    const { deps, installSkills } = setup({ workflows: false });
    expect(await runInit([], deps)).toBe(0);
    expect(installSkills).toHaveBeenCalledTimes(1);
    expect(installSkills).toHaveBeenCalledWith(SKILLS_REPO, ["codex"]);
    expect(io.stdout()).toContain("• Workflows skipped");
  });

  test("declining skills still asks about the workflows", async () => {
    const { deps, confirm, installSkills } = setup({ skills: false });
    expect(await runInit([], deps)).toBe(0);
    expect(confirm).toHaveBeenCalledWith(WORKFLOWS_QUESTION);
    expect(installSkills).toHaveBeenCalledTimes(1);
    expect(installSkills).toHaveBeenCalledWith(WORKFLOWS_REPO, ["codex"]);
    expect(io.stdout()).toContain("• Skills skipped");
    expect(io.stdout()).toContain("Tavily workflows ready for codex");
  });

  test("--skip-workflows installs skills only", async () => {
    const { deps, confirm, installSkills } = setup();
    expect(await runInit(["--skip-workflows", "--json"], deps)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(installSkills).toHaveBeenCalledTimes(1);
    expect(installSkills).toHaveBeenCalledWith(SKILLS_REPO, ["codex"]);
    expect(stdoutJson().workflows).toEqual({
      source: WORKFLOWS_REPO,
      agents: [],
      restart_required: false,
      skipped: true,
    });
  });

  test("--yes installs skills and workflows without prompting", async () => {
    const { deps, confirm, installSkills } = setup();
    expect(await runInit(["--yes", "--json"], deps)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(installSkills).toHaveBeenCalledWith(SKILLS_REPO, ["codex"]);
    expect(installSkills).toHaveBeenCalledWith(WORKFLOWS_REPO, ["codex"]);
    expect(stdoutJson().workflows).toMatchObject({ agents: ["codex"], skipped: false });
  });

  test("--skip-skills skips skills and workflows", async () => {
    const { deps, confirm, installSkills } = setup();
    expect(await runInit(["--skip-skills", "--json"], deps)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(installSkills).not.toHaveBeenCalled();
    expect(stdoutJson()).toMatchObject({ skills: { skipped: true }, workflows: { skipped: true } });
  });

  test("a workflows install failure is stage workflows, exit one", async () => {
    const { deps, installSkills } = setup();
    installSkills.mockImplementation(async (repo, agents) => {
      if (repo === WORKFLOWS_REPO) throw new Error("npx skills failed: boom");
      return { agents, restartRequired: false };
    });
    expect(await runInit(["--yes", "--json"], deps)).toBe(1);
    expect(stdoutJson().error).toEqual({ stage: "workflows", message: "npx skills failed: boom" });
  });
});

describe("init mcp", () => {
  const MCP_QUESTION = "Add the Tavily MCP server to codex (hosted, signs in with OAuth)?";

  function setup(answer: boolean) {
    mkdirSync(join(home, ".codex"));
    const confirm = vi.fn(async (question: string) => question === MCP_QUESTION && answer);
    const installMcp = vi.fn(async (agents: string[]) => ({
      configured: agents,
      skipped: [],
      auth: "oauth" as const,
    }));
    const deps: InitDeps = {
      home,
      env: { TAVILY_API_KEY: "tvly-test" },
      which: () => "/usr/bin/tvly",
      client: okClient,
      stdinIsTTY: true,
      confirm,
      installSkills: async (_repo, agents) => ({ agents, restartRequired: false }),
      installMcp,
    };
    return { deps, confirm, installMcp };
  }

  test("the prompt defaults to no, which leaves MCP alone and hints at setup mcp", async () => {
    const { deps, confirm, installMcp } = setup(false);
    expect(await runInit([], deps)).toBe(0);
    expect(confirm).toHaveBeenCalledWith(MCP_QUESTION, false);
    expect(installMcp).not.toHaveBeenCalled();
    expect(io.stdout()).toContain("tvly setup mcp");
  });

  test("accepting the prompt configures MCP, even with --skip-skills", async () => {
    const { deps, installMcp } = setup(true);
    expect(await runInit(["--skip-skills"], deps)).toBe(0);
    expect(installMcp).toHaveBeenCalledWith(["codex"], expect.objectContaining({ keyless: false }));
    expect(io.stdout()).toContain("Tavily MCP server ready for codex");
    expect(io.stdout()).toContain("open a browser to sign in to Tavily");
    expect(io.stdout()).not.toContain("tvly setup mcp");
  });

  test("--yes never configures MCP", async () => {
    const { deps, confirm, installMcp } = setup(true);
    expect(await runInit(["--yes", "--json"], deps)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(installMcp).not.toHaveBeenCalled();
    expect(stdoutJson().mcp).toEqual({ agents: [], skipped: true });
  });
});

describe("init global install", () => {
  function setup(opts: { tvly?: boolean; answer?: boolean; status?: number; tty?: boolean } = {}) {
    const confirm = vi.fn(async () => opts.answer ?? true);
    const spawnImpl = vi.fn((_cmd: string, args: string[]) =>
      args[0] === "prefix" ? { status: 0, stdout: "/opt/npm\n" } : { status: opts.status ?? 0 },
    );
    const deps: InitDeps = {
      home,
      env: { TAVILY_API_KEY: "tvly-test", SHELL: "/bin/zsh" },
      platform: "darwin",
      which: (name) => (name === "tvly" && !opts.tvly ? null : `/usr/bin/${name}`),
      client: okClient,
      stdinIsTTY: opts.tty ?? true,
      confirm,
      spawnImpl: spawnImpl as unknown as NonNullable<InitDeps["spawnImpl"]>,
    };
    return { deps, confirm, spawnImpl };
  }

  test("installs globally with the resolved npm when confirmed", async () => {
    const { deps, confirm, spawnImpl } = setup({ tvly: false });
    expect(await runInit(["--skip-skills"], deps)).toBe(0);
    expect(confirm).toHaveBeenCalledWith("Install tvly globally?");
    expect(spawnImpl).toHaveBeenCalledWith(
      "/usr/bin/npm",
      ["install", "-g", "@tavily/cli@latest"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(io.stdout()).toContain("tvly installed globally (npm)");
  });

  test("declining the install continues and then fails the cli check", async () => {
    const { deps, spawnImpl } = setup({ tvly: false, answer: false });
    expect(await runInit(["--skip-skills"], deps)).toBe(1);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(io.stdout()).toContain("tvly is not available on PATH.");
  });

  test("--yes in a non-interactive run installs without asking", async () => {
    const { deps, confirm, spawnImpl } = setup({ tvly: false, tty: false });
    expect(await runInit(["--skip-skills", "--yes", "--json"], deps)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith(
      "/usr/bin/npm",
      ["install", "-g", "@tavily/cli@latest"],
      expect.anything(),
    );
    expect(stdoutJson().install).toMatchObject({ global: true, manager: "npm" });
  });

  test("adds the global bin dir to the shell rc file once", async () => {
    const line = 'export PATH="/opt/npm/bin:$PATH"';
    for (let i = 0; i < 2; i++) {
      const { deps } = setup({ tvly: false });
      expect(await runInit(["--skip-skills"], deps)).toBe(0);
      expect(io.stdout()).toContain("Added /opt/npm/bin to PATH in ~/.zshrc");
    }
    expect(readFileSync(join(home, ".zshrc"), "utf8").split(line).length - 1).toBe(1);
  });

  test("a failed install continues and exits one", async () => {
    const { deps, spawnImpl } = setup({ tvly: false, status: 1 });
    expect(await runInit(["--skip-skills"], deps)).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(io.stderr()).toContain("Failed to install @tavily/cli globally using npm.");
    expect(io.stderr()).toContain(
      "You can run without a global install: npx @tavily/cli <command>",
    );
    expect(io.stdout()).toContain("Setup incomplete: global CLI installation failed.");
  });
});

describe("detectPackageManager", () => {
  const node = { node: "22.0.0" } as NodeJS.ProcessVersions;
  test.each([
    ["pnpm user agent", { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22" }, [], "pnpm"],
    ["bunx entry", {}, ["bun", "/tmp/bunx-501-@tavily/cli/node_modules/.bin/tvly"], "bun"],
    ["yarn user agent", { npm_config_user_agent: "yarn/4.1.0 npm/? node/v22" }, [], "yarn"],
    ["npm default", { npm_config_user_agent: "npm/10.0.0 node/v22" }, [], "npm"],
  ])("%s", (_name, env, argv, expected) => {
    expect(detectPackageManager(env, argv, node)).toBe(expected);
  });
});

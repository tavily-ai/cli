import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import { run } from "../src/commands/init.js";
import { detectPackageManager } from "../src/core/install-detect.js";
import { MCP_SERVER_URL } from "../src/core/mcp-setup.js";
import { SKILLS_REPO, WORKFLOWS_REPO } from "../src/core/skills.js";
import type { Host } from "../src/host.js";
import { captureOutput } from "./helpers/capture.js";
import { type ExecScript, type FakeExec, fakeExec } from "./helpers/exec.js";
import { clientHost, runProgram } from "./helpers/program.js";

const io = captureOutput();

/** A key in the environment and a live search that works; tvly is already on PATH. */
const initHost = (over: Partial<Host> = {}) =>
  clientHost({ search: async () => ({ results: [] }) }, over);

const runInit = (argv: string[], host: Host) => runProgram(["init", ...argv], host);

const stdoutJson = () => JSON.parse(io.stdout());

const SKILLS_PACKAGE = "skills@1.7.4";

/** The repo each recorded `npx skills add` run installed. */
const skillRepos = (exec: FakeExec) =>
  exec.calls.filter((c) => c.args[1] === SKILLS_PACKAGE).map((c) => c.args[3]);

/** An npx whose skills install writes one skill, so the first install asks for a restart. */
const writingSkills = (home: string) =>
  fakeExec({
    run: (_bin, args) => {
      if (args[1] === SKILLS_PACKAGE) {
        mkdirSync(join(home, ".agents", "skills", "tavily-search"), { recursive: true });
      }
      return undefined;
    },
  });

describe("init", () => {
  test("skips skills without detected agents", async () => {
    const host = initHost();
    expect(await runInit(["--json"], host)).toBe(0);
    expect((host.exec as FakeExec).calls).toEqual([]);
    expect(stdoutJson().skills).toMatchObject({ agents: [], skipped: true });
  });

  test("--json reuses environment auth and installs skills for detected agents", async () => {
    const host = initHost();
    const exec = writingSkills(host.home);
    host.exec = exec;
    mkdirSync(join(host.home, ".codex"));
    expect(await runInit(["--json"], host)).toBe(0);
    const output = stdoutJson();
    expect(output.ok).toBe(true);
    expect(output.auth).toEqual({ authenticated: true, method: "env" });
    expect(output.skills.agents).toEqual(["codex"]);
    expect(output.skills.restart_required).toBe(true);
    expect(output.skills.source).toBe("tavily-ai/skills");
    expect(output.verification.live_search).toBe(true);
    expect(exec.calls[0]).toEqual({
      bin: "/usr/bin/npx",
      args: [
        "--yes",
        SKILLS_PACKAGE,
        "add",
        SKILLS_REPO,
        "--skill",
        "*",
        "--global",
        "--agent",
        "codex",
        "--yes",
      ],
      opts: { timeoutMs: 300_000 },
    });
    expect(skillRepos(exec)).toEqual([SKILLS_REPO, WORKFLOWS_REPO]);
  });

  test("non-interactive auth failure is JSON", async () => {
    const code = await runInit(["--skip-skills", "--json"], initHost({ env: {} }));
    expect(code).toBe(3);
    const output = stdoutJson();
    expect(output.ok).toBe(false);
    expect(output.error.stage).toBe("auth");
    expect(output.skills.skipped).toBe(true);
  });

  test("the OAuth URL is printed with control bytes stripped", async () => {
    const cmd = new Command().option("--json");
    cmd.setOptionValue("json", true);
    const login = vi.fn(async (opts: { onStatus?: (url: string) => void }) => {
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
    });
    await run({ browser: false, skipSkills: true }, cmd, initHost({ env: {} }), { login });
    expect(login).toHaveBeenCalledWith(expect.objectContaining({ openBrowser: false }));
    expect(stdoutJson().auth).toEqual({ authenticated: true, method: "oauth" });
    expect(io.stderr()).toContain(
      "Open this URL to authenticate: https://mcp.tavily.com/authorize?x=[2Jy",
    );
    expect(io.stderr()).not.toContain("\x1b");
  });

  test("live search failure exits four", async () => {
    const host = clientHost({ search: async () => ({}) }, { env: {} });
    expect(await runInit(["--skip-auth", "--skip-skills", "--json"], host)).toBe(4);
    expect(stdoutJson().error.stage).toBe("live_search");
  });

  test("--all with --agent is a usage error", async () => {
    expect(await runInit(["--all", "--agent", "codex"], initHost())).toBe(2);
    expect(io.stderr()).toContain("error: Use either --all or --agent, not both.");
  });

  test("--agent rejects unknown names and accepts any case", async () => {
    const host = initHost();
    expect(await runInit(["--agent", "bogus"], host)).toBe(2);
    expect(io.stderr()).toContain("Allowed choices are claude-code, codex, cursor.");
    expect((host.exec as FakeExec).calls).toEqual([]);

    expect(await runInit(["--agent", "CODEX", "--agent", "codex", "--json"], host)).toBe(0);
    expect(stdoutJson().skills.agents).toEqual(["codex"]);
  });

  test("--skip-auth with --api-key is a usage error", async () => {
    expect(await runInit(["--skip-auth", "--api-key", "tvly-x"], initHost())).toBe(2);
    expect(io.stderr()).toContain("error: Use either --skip-auth or --api-key, not both.");
  });

  test("--skip-skills --skip-auth without a key reports keyless mode", async () => {
    expect(await runInit(["--skip-skills", "--skip-auth", "--json"], initHost({ env: {} }))).toBe(
      0,
    );
    const output = stdoutJson();
    expect(output.mode).toBe("keyless");
    expect(output.skills.skipped).toBe(true);
  });
});

describe("init workflows", () => {
  const WORKFLOWS_QUESTION = `Install the Tavily official workflows (${WORKFLOWS_REPO})?`;

  function setup(answers: { skills?: boolean; workflows?: boolean } = {}, run?: ExecScript) {
    const confirm = vi.fn(async (question: string, defaultYes?: boolean) =>
      defaultYes === false
        ? false
        : question === WORKFLOWS_QUESTION
          ? (answers.workflows ?? true)
          : (answers.skills ?? true),
    );
    const exec = fakeExec(run ? { run } : {});
    const host = initHost({ stdinIsTTY: true, confirm, exec });
    mkdirSync(join(host.home, ".codex"));
    return { host, confirm, exec };
  }

  test("installs the workflows when the prompt is accepted", async () => {
    const { host, confirm, exec } = setup();
    expect(await runInit([], host)).toBe(0);
    expect(confirm).toHaveBeenCalledWith(WORKFLOWS_QUESTION);
    expect(skillRepos(exec)).toEqual([SKILLS_REPO, WORKFLOWS_REPO]);
    expect(exec.calls.every((c) => c.args.includes("codex"))).toBe(true);
    expect(io.stdout()).toContain("Tavily workflows ready for codex");
  });

  // --json never prompts, so the declined prompts are checked through the human summary.
  test("declining the workflows prompt skips them", async () => {
    const { host, exec } = setup({ workflows: false });
    expect(await runInit([], host)).toBe(0);
    expect(skillRepos(exec)).toEqual([SKILLS_REPO]);
    expect(io.stdout()).toContain("• Workflows skipped");
  });

  test("declining skills still asks about the workflows", async () => {
    const { host, confirm, exec } = setup({ skills: false });
    expect(await runInit([], host)).toBe(0);
    expect(confirm).toHaveBeenCalledWith(WORKFLOWS_QUESTION);
    expect(skillRepos(exec)).toEqual([WORKFLOWS_REPO]);
    expect(io.stdout()).toContain("• Skills skipped");
    expect(io.stdout()).toContain("Tavily workflows ready for codex");
  });

  test("--skip-workflows installs skills only", async () => {
    const { host, confirm, exec } = setup();
    expect(await runInit(["--skip-workflows", "--json"], host)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(skillRepos(exec)).toEqual([SKILLS_REPO]);
    expect(stdoutJson().workflows).toEqual({
      source: WORKFLOWS_REPO,
      agents: [],
      restart_required: false,
      skipped: true,
    });
  });

  test("--yes installs skills and workflows without prompting", async () => {
    const { host, confirm, exec } = setup();
    expect(await runInit(["--yes", "--json"], host)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(skillRepos(exec)).toEqual([SKILLS_REPO, WORKFLOWS_REPO]);
    expect(stdoutJson().workflows).toMatchObject({ agents: ["codex"], skipped: false });
  });

  test("--skip-skills skips skills and workflows", async () => {
    const { host, confirm, exec } = setup();
    expect(await runInit(["--skip-skills", "--json"], host)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(exec.calls).toEqual([]);
    expect(stdoutJson()).toMatchObject({ skills: { skipped: true }, workflows: { skipped: true } });
  });

  test("a workflows install failure is stage workflows, exit one", async () => {
    const { host } = setup({}, (_bin, args) =>
      args[3] === WORKFLOWS_REPO ? { ok: false, failure: "boom" } : undefined,
    );
    expect(await runInit(["--yes", "--json"], host)).toBe(1);
    expect(stdoutJson().error).toEqual({ stage: "workflows", message: "npx skills failed: boom" });
  });
});

describe("init mcp", () => {
  const MCP_QUESTION = "Add the Tavily MCP server to codex (hosted, signs in with OAuth)?";

  function setup(answer: boolean) {
    const confirm = vi.fn(async (question: string) => question === MCP_QUESTION && answer);
    const exec = fakeExec();
    const host = initHost({ stdinIsTTY: true, confirm, exec });
    mkdirSync(join(host.home, ".codex"));
    return { host, confirm, exec };
  }

  test("the prompt defaults to no, which leaves MCP alone and hints at setup mcp", async () => {
    const { host, confirm, exec } = setup(false);
    expect(await runInit([], host)).toBe(0);
    expect(confirm).toHaveBeenCalledWith(MCP_QUESTION, false);
    expect(exec.calls).toEqual([]);
    expect(io.stdout()).toContain("tvly setup mcp");
  });

  test("accepting the prompt configures MCP from the environment key, even with --skip-skills", async () => {
    const { host, exec } = setup(true);
    expect(await runInit(["--skip-skills"], host)).toBe(0);
    expect(exec.calls).toEqual([
      {
        bin: "/usr/bin/codex",
        args: [
          "mcp",
          "add",
          "tavily",
          "--url",
          MCP_SERVER_URL,
          "--bearer-token-env-var",
          "TAVILY_API_KEY",
        ],
        opts: { timeoutMs: 300_000 },
      },
    ]);
    expect(io.stdout()).toContain("Tavily MCP server ready for codex");
    expect(io.stdout()).toContain("Using TAVILY_API_KEY from your environment");
    expect(io.stdout()).not.toContain("tvly setup mcp");
  });

  test("--yes never configures MCP", async () => {
    const { host, confirm, exec } = setup(true);
    expect(await runInit(["--yes", "--json"], host)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(exec.calls.map((c) => c.args[1])).toEqual([SKILLS_PACKAGE, SKILLS_PACKAGE]);
    expect(stdoutJson().mcp).toEqual({ agents: [], skipped: true });
  });
});

describe("init global install", () => {
  function setup(opts: { tvly?: boolean; answer?: boolean; failed?: boolean; tty?: boolean } = {}) {
    const confirm = vi.fn(async () => opts.answer ?? true);
    const exec = fakeExec({
      which: (name) => (name === "tvly" && !opts.tvly ? null : `/usr/bin/${name}`),
      run: (_bin, args) =>
        args[0] === "prefix"
          ? { stdout: "/opt/npm\n" }
          : opts.failed
            ? { ok: false, failure: "exit code 1" }
            : undefined,
    });
    const host = initHost({
      env: { TAVILY_API_KEY: "tvly-test", SHELL: "/bin/zsh" },
      platform: "darwin",
      exec,
      stdinIsTTY: opts.tty ?? true,
      confirm,
    });
    return { host, confirm, exec };
  }

  const INSTALL = { bin: "/usr/bin/npm", args: ["install", "-g", "@tavily/cli@latest"] };

  test("installs globally with the resolved npm, streaming its output, when confirmed", async () => {
    const { host, confirm, exec } = setup({ tvly: false });
    expect(await runInit(["--skip-skills"], host)).toBe(0);
    expect(confirm).toHaveBeenCalledWith("Install tvly globally?");
    expect(exec.calls[0]).toEqual({ ...INSTALL, opts: { inherit: true } });
    expect(io.stdout()).toContain("tvly installed globally (npm)");
  });

  test("TAVILY_CLI_PACKAGE replaces the package spec in the install command", async () => {
    const { host, exec } = setup({ tvly: false });
    host.env.TAVILY_CLI_PACKAGE = "/tmp/tavily-cli-0.3.0.tgz";
    expect(await runInit(["--skip-skills"], host)).toBe(0);
    expect(exec.calls[0]?.args).toEqual(["install", "-g", "/tmp/tavily-cli-0.3.0.tgz"]);
  });

  test("declining the install continues and then fails the cli check", async () => {
    const { host, exec } = setup({ tvly: false, answer: false });
    expect(await runInit(["--skip-skills"], host)).toBe(1);
    expect(exec.calls).toEqual([]);
    expect(io.stdout()).toContain("tvly is not available on PATH.");
  });

  test("--yes in a non-interactive --json run installs without asking, keeping stdout", async () => {
    const { host, confirm, exec } = setup({ tvly: false, tty: false });
    expect(await runInit(["--skip-skills", "--yes", "--json"], host)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(exec.calls[0]).toEqual({ ...INSTALL, opts: { inherit: "stderr" } });
    expect(stdoutJson().install).toMatchObject({ global: true, manager: "npm" });
  });

  test("adds the global bin dir to the shell rc file once", async () => {
    const line = 'export PATH="/opt/npm/bin:$PATH"';
    const { host } = setup({ tvly: false });
    for (let i = 0; i < 2; i++) {
      expect(await runInit(["--skip-skills"], host)).toBe(0);
      expect(io.stdout()).toContain("Added /opt/npm/bin to PATH in ~/.zshrc");
    }
    expect(readFileSync(join(host.home, ".zshrc"), "utf8").split(line).length - 1).toBe(1);
  });

  test("a failed install continues and exits one", async () => {
    const { host, exec } = setup({ tvly: false, failed: true });
    expect(await runInit(["--skip-skills"], host)).toBe(1);
    expect(exec.calls).toHaveLength(1);
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
    expect(detectPackageManager({ env, argv }, node)).toBe(expected);
  });
});

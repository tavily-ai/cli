import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import { run } from "../src/commands/init.js";
import { getApiKey } from "../src/core/config.js";
import { detectPackageManager } from "../src/core/install-detect.js";
import { MCP_SERVER_URL } from "../src/core/mcp-setup.js";
import { SKILLS_REPO, WORKFLOWS_REPO } from "../src/core/skills.js";
import { ExitError } from "../src/errors.js";
import type { Host } from "../src/host.js";
import { captureOutput } from "./helpers/capture.js";
import { type ExecScript, type FakeExec, fakeExec } from "./helpers/exec.js";
import { clientHost, fakeHost, runProgram } from "./helpers/program.js";

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
    expect(skillRepos(exec)).toEqual([SKILLS_REPO]);
    expect(output.mcp).toEqual({ agents: ["codex"], skipped: false });
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

describe("init pickers", () => {
  const AGENTS_QUESTION = "Which agents do you want to install to?";
  const INSTALL_QUESTION = "What should I install?";

  /** A TTY host whose pickers answer from `answers` by message, else take the pre-checked default. */
  function setup(
    opts: { agents?: string[]; answers?: Record<string, unknown>; run?: ExecScript } = {},
    over: Partial<Host> = {},
  ) {
    const answers = opts.answers ?? {};
    const multiselect = vi.fn(
      async (message: string, _choices: unknown, initial: string[]) => answers[message] ?? initial,
    );
    const select = vi.fn(
      async (message: string, _choices: unknown, initial?: string) => answers[message] ?? initial,
    );
    const password = vi.fn(async () => "  tvly-abc \n");
    const prompt = {
      ...fakeHost().prompt,
      multiselect,
      select,
      password,
    } as unknown as Host["prompt"];
    const exec = fakeExec(opts.run ? { run: opts.run } : {});
    const host = initHost({ stdinIsTTY: true, stderrIsTTY: true, prompt, exec, ...over });
    for (const dir of opts.agents ?? [".claude", ".codex"]) mkdirSync(join(host.home, dir));
    return { host, exec, multiselect, select };
  }

  /** The `--agent` list of each `npx skills add` run. */
  const skillAgents = (exec: FakeExec) =>
    exec.calls.filter((c) => c.args[1] === SKILLS_PACKAGE).map((c) => c.args.slice(8, -1));

  function expectDefaults(exec: FakeExec) {
    expect(skillRepos(exec)).toEqual([SKILLS_REPO]);
    expect(skillAgents(exec)).toEqual([["claude-code", "codex"]]);
    expect(io.stdout()).toContain("Tavily MCP server ready for claude-code, codex");
  }

  test("defaults install skills and MCP for every detected agent", async () => {
    const { host, exec, multiselect } = setup();
    expect(await runInit([], host)).toBe(0);
    expect(multiselect).toHaveBeenCalledTimes(2);
    expectDefaults(exec);
  });

  test("--yes takes the same defaults without prompting", async () => {
    const { host, exec, multiselect, select } = setup();
    expect(await runInit(["--yes"], host)).toBe(0);
    expect(multiselect).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expectDefaults(exec);
  });

  test.each([
    ["stdin", { stdinIsTTY: false }],
    ["stderr", { stderrIsTTY: false }],
  ])("a run whose %s is not a TTY takes the same defaults", async (_name, tty) => {
    const { host, exec, multiselect, select } = setup({}, tty);
    expect(await runInit([], host)).toBe(0);
    expect(multiselect).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expectDefaults(exec);
  });

  test("workflows install only when picked", async () => {
    const { host, exec } = setup({ answers: { [INSTALL_QUESTION]: ["skills", "workflows"] } });
    expect(await runInit([], host)).toBe(0);
    expect(skillRepos(exec)).toEqual([SKILLS_REPO, WORKFLOWS_REPO]);
    expect(io.stdout()).toContain("Tavily workflows ready for claude-code, codex");
    expect(io.stdout()).not.toContain("MCP server ready");
    expect(io.stdout()).toContain("tvly setup mcp");
  });

  test("--agent cursor skips the agent picker but still asks what to install", async () => {
    const { host, exec, multiselect } = setup();
    expect(await runInit(["--agent", "cursor"], host)).toBe(0);
    expect(multiselect).toHaveBeenCalledOnce();
    expect(multiselect.mock.calls[0]?.[0]).toBe(INSTALL_QUESTION);
    expect(skillAgents(exec)).toEqual([["cursor"]]);
    expect(io.stdout()).toContain("Tavily MCP server ready for cursor");
  });

  test("deselecting every agent installs nothing", async () => {
    const { host, exec, multiselect } = setup({ answers: { [AGENTS_QUESTION]: [] } });
    expect(await runInit([], host)).toBe(0);
    expect(multiselect).toHaveBeenCalledOnce();
    expect(exec.calls).toEqual([]);
    expect(io.stdout()).toContain("• Skills skipped");
  });

  test("no detected agents skips the pickers", async () => {
    const { host, exec, multiselect } = setup({ agents: [] });
    expect(await runInit([], host)).toBe(0);
    expect(multiselect).not.toHaveBeenCalled();
    expect(exec.calls).toEqual([]);
    expect(io.stderr()).toContain("No coding agents found.");
    expect(io.stdout()).toContain("Live search verified");
  });

  test("--skip-workflows removes the workflows choice", async () => {
    const { host, multiselect } = setup();
    expect(await runInit(["--skip-workflows"], host)).toBe(0);
    expect(multiselect).toHaveBeenLastCalledWith(
      INSTALL_QUESTION,
      [expect.objectContaining({ value: "skills" }), expect.objectContaining({ value: "mcp" })],
      ["skills", "mcp"],
    );
  });

  test("sign-in select: paste a key saves it trimmed", async () => {
    const { host } = setup(
      { agents: [], answers: { "How do you want to sign in?": "key" } },
      { env: {} },
    );
    expect(await runInit([], host)).toBe(0);
    expect(await getApiKey(host)).toBe("tvly-abc");
    expect(io.stdout()).toContain("Authenticated via api_key");
  });

  test("sign-in select: keyless continues without a key", async () => {
    const { host } = setup(
      { agents: [], answers: { "How do you want to sign in?": "keyless" } },
      { env: {} },
    );
    const login = vi.fn();
    await run({}, new Command(), host, { login });
    expect(login).not.toHaveBeenCalled();
    expect(io.stdout()).toContain("Keyless mode");
  });

  test("cancel at a prompt exits 1", async () => {
    const { host, multiselect } = setup();
    multiselect.mockRejectedValueOnce(new ExitError(1));
    await expect(run({}, new Command(), host)).rejects.toMatchObject({ code: 1 });
  });

  test("cancel at the sign-in question exits 1, not the auth failure code 3", async () => {
    const { host, select } = setup({ agents: [] }, { env: {} });
    select.mockRejectedValueOnce(new ExitError(1));
    await expect(run({}, new Command(), host)).rejects.toMatchObject({ code: 1 });
    expect(select).toHaveBeenCalledOnce();
  });

  test("--json output is a single JSON object", async () => {
    const { host } = setup();
    expect(await runInit(["--json", "--yes"], host)).toBe(0);
    expect(io.stdout().trim().split("\n")).toHaveLength(1);
    expect(stdoutJson()).toMatchObject({ ok: true, mcp: { skipped: false } });
  });

  test("a workflows install failure is stage workflows, exit one", async () => {
    const { host } = setup({
      answers: { [INSTALL_QUESTION]: ["workflows"] },
      run: (_bin, args) =>
        args[3] === WORKFLOWS_REPO ? { ok: false, failure: "boom" } : undefined,
    });
    expect(await runInit([], host)).toBe(1);
    expect(io.stdout()).toContain("Setup failed: npx skills failed: boom");
  });

  test("--skip-skills leaves agents alone: no skills, workflows, or MCP", async () => {
    const { host, exec } = setup({ agents: [".claude"] });
    expect(await runInit(["--skip-skills", "--yes", "--json"], host)).toBe(0);
    expect(exec.calls).toEqual([]);
    expect(stdoutJson()).toMatchObject({
      skills: { skipped: true },
      workflows: { skipped: true },
      mcp: { agents: [], skipped: true },
    });
  });

  test("MCP uses the environment key for codex", async () => {
    const { host, exec } = setup({ agents: [".codex"], answers: { [INSTALL_QUESTION]: ["mcp"] } });
    expect(await runInit([], host)).toBe(0);
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
      stderrIsTTY: opts.tty ?? true,
      prompt: { ...fakeHost().prompt, confirm },
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

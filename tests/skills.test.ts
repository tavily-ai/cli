import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAgents, installAgentSkills } from "../src/core/skills.js";

const SKILLS = ["tavily-search", "tavily-research"];
const NPX = "/usr/bin/npx";

type Call = { cmd: string; args: string[]; opts: Record<string, unknown> };

function result(status: number, stderr = "", stdout = ""): SpawnSyncReturns<string> {
  return { status, stderr, stdout, signal: null, pid: 1, output: [null, stdout, stderr] };
}

/** Mimic the skills.sh CLI writing skills to the shared directory. */
function fakeNpx(home: string, calls: Call[], opts: { status?: number; content?: string } = {}) {
  return ((cmd: string, args: string[], o: Record<string, unknown>) => {
    calls.push({ cmd, args, opts: o });
    const status = opts.status ?? 0;
    if (status === 0) {
      for (const name of SKILLS) {
        const dir = path.join(home, ".agents", "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n${opts.content ?? ""}`);
      }
    }
    return result(status, "Error: repo not found\n");
  }) as never;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "tvly-skills-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("detectAgents", () => {
  it("only returns existing markers", () => {
    mkdirSync(path.join(home, ".codex"));
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    expect(detectAgents({ home, env: {} })).toEqual(["codex"]);
  });

  it("honors custom agent directories", () => {
    const codex = path.join(home, "custom-codex");
    const claude = path.join(home, "custom-claude");
    mkdirSync(codex);
    mkdirSync(claude);
    const env = { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude };
    expect(detectAgents({ home, env })).toEqual(["claude-code", "codex"]);
  });
});

describe("installAgentSkills", () => {
  const which = () => NPX;

  it("runs npx", async () => {
    const calls: Call[] = [];
    const agents = ["claude-code", "codex", "cursor"];
    const run = (spawnImpl: never) =>
      installAgentSkills(agents, { home, env: {}, which, spawnImpl, platform: "linux" });

    const first = await run(fakeNpx(home, calls));
    const { cmd, args, opts } = calls[0] as Call;
    expect(cmd).toBe(NPX);
    expect(args.slice(0, 4)).toEqual(["--yes", "skills@1.7.4", "add", "tavily-ai/skills"]);
    const at = args.indexOf("--agent");
    expect(args.slice(at + 1, at + 4)).toEqual(agents);
    expect(args).toContain("--global");
    expect(args.filter((a) => a === "--yes")).toHaveLength(2);
    expect([cmd, ...args].every((a) => !a.includes(" ") && !a.includes('"'))).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(opts.timeout).toBe(300_000);
    expect(first.restartRequired).toBe(true);

    expect((await run(fakeNpx(home, calls))).restartRequired).toBe(false);
    expect((await run(fakeNpx(home, calls, { content: "new" }))).restartRequired).toBe(true);

    // A removed or newly added (even empty) skill directory counts; no change does not.
    const removeSkill = (() => {
      rmSync(path.join(home, ".agents", "skills", "tavily-search"), { recursive: true });
      return result(0);
    }) as never;
    expect((await run(removeSkill)).restartRequired).toBe(true);
    const addEmptySkill = (() => {
      mkdirSync(path.join(home, ".agents", "skills", "empty"));
      return result(0);
    }) as never;
    expect((await run(addEmptySkill)).restartRequired).toBe(true);
    expect((await run((() => result(0)) as never)).restartRequired).toBe(false);
  });

  it("counts new agent links", async () => {
    const calls: Call[] = [];
    await installAgentSkills(["codex"], { home, env: {}, which, spawnImpl: fakeNpx(home, calls) });
    const linkSkills = (() => {
      for (const name of SKILLS) {
        const link = path.join(home, ".claude", "skills", name);
        mkdirSync(path.dirname(link), { recursive: true });
        symlinkSync(path.join(home, ".agents", "skills", name), link, "dir");
      }
      return result(0);
    }) as never;

    const out = await installAgentSkills(["claude-code", "codex"], {
      home,
      env: {},
      which,
      spawnImpl: linkSkills,
    });
    expect(out.restartRequired).toBe(true);
  });

  describe("windows", () => {
    const cmd = "C:\\Program Files\\nodejs\\npx.cmd";
    const execPath = "C:\\node\\node.exe";
    const npxCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
    const win = { home, platform: "win32" as const, execPath, which: () => cmd };

    it("runs npx-cli.js through node", async () => {
      const calls: Call[] = [];
      await installAgentSkills(["codex"], {
        ...win,
        home,
        existsSync: () => true,
        spawnImpl: fakeNpx(home, calls),
      });
      const call = calls[0] as Call;
      expect(call.cmd).toBe(execPath);
      expect(call.args.slice(0, 2)).toEqual([npxCli, "--yes"]);
      expect(call.opts.shell).toBe(false);
    });

    it("falls back to the quoted .cmd through the shell", async () => {
      const calls: Call[] = [];
      await installAgentSkills(["codex"], {
        ...win,
        home,
        existsSync: () => false,
        spawnImpl: fakeNpx(home, calls),
      });
      const call = calls[0] as Call;
      expect(call.cmd).toBe(`"${cmd}"`);
      expect(call.args[0]).toBe("--yes");
      expect(call.opts.shell).toBe(true);
    });
  });

  it("reports spawn errors and signals", async () => {
    const err = (() => ({
      ...result(0),
      status: null,
      error: new Error("spawnSync npx ENOBUFS"),
    })) as never;
    await expect(installAgentSkills(["codex"], { home, which, spawnImpl: err })).rejects.toThrow(
      "npx skills failed: spawnSync npx ENOBUFS",
    );
    const sig = (() => ({ ...result(0), status: null, signal: "SIGKILL" })) as never;
    await expect(installAgentSkills(["codex"], { home, which, spawnImpl: sig })).rejects.toThrow(
      "npx skills failed: signal SIGKILL",
    );
  });

  it("requires npx", async () => {
    await expect(
      installAgentSkills(["codex"], { home, env: {}, which: () => null }),
    ).rejects.toThrow(/requires Node\.js/);
  });

  it("reports npx failure", async () => {
    const spawnImpl = fakeNpx(home, [], { status: 1 });
    await expect(
      installAgentSkills(["codex"], { home, env: {}, which, spawnImpl }),
    ).rejects.toThrow("npx skills failed: Error: repo not found");
  });
});

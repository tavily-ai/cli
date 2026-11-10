import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAgents, installAgentSkills, SKILLS_REPO } from "../src/core/skills.js";
import type { Exec } from "../src/util/exec.js";
import { fakeExec } from "./helpers/exec.js";

const SKILLS = ["tavily-search", "tavily-research"];
const NPX = "/usr/bin/npx";

const which = () => NPX;

/** An npx that runs `effect` (the skills.sh CLI touching skill dirs) and then succeeds or fails. */
const npx = (effect: () => void = () => {}, failure?: string) =>
  fakeExec({
    which,
    run: () => {
      if (failure) return { ok: false, failure };
      effect();
      return undefined;
    },
  });

/** Mimic the skills.sh CLI writing skills to the shared directory. */
const writes = (home: string, content = "") =>
  npx(() => {
    for (const name of SKILLS) {
      const dir = path.join(home, ".agents", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n${content}`);
    }
  });

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
  it("runs npx", async () => {
    const agents = ["claude-code", "codex", "cursor"];
    const run = (exec: Exec) => installAgentSkills(SKILLS_REPO, agents, { home, env: {}, exec });

    const exec = writes(home);
    const first = await run(exec);
    const { bin, args, opts } = exec.calls[0] as (typeof exec.calls)[number];
    expect(bin).toBe(NPX);
    expect(args.slice(0, 4)).toEqual(["--yes", "skills@1.7.4", "add", "tavily-ai/skills"]);
    const at = args.indexOf("--agent");
    expect(args.slice(at + 1, at + 4)).toEqual(agents);
    expect(args).toContain("--global");
    expect(args.filter((a) => a === "--yes")).toHaveLength(2);
    // On Windows npx is a .cmd shim, so the command line may be re-parsed by cmd.exe.
    expect([bin, ...args].every((a) => !a.includes(" ") && !a.includes('"'))).toBe(true);
    expect(opts).toEqual({ timeoutMs: 300_000 });
    expect(first.restartRequired).toBe(true);

    expect((await run(writes(home))).restartRequired).toBe(false);
    expect((await run(writes(home, "new"))).restartRequired).toBe(true);

    // A removed or newly added (even empty) skill directory counts; no change does not.
    const removeSkill = npx(() =>
      rmSync(path.join(home, ".agents", "skills", "tavily-search"), { recursive: true }),
    );
    expect((await run(removeSkill)).restartRequired).toBe(true);
    const addEmptySkill = npx(() => mkdirSync(path.join(home, ".agents", "skills", "empty")));
    expect((await run(addEmptySkill)).restartRequired).toBe(true);
    expect((await run(npx())).restartRequired).toBe(false);
  });

  it("counts new agent links", async () => {
    await installAgentSkills(SKILLS_REPO, ["codex"], { home, env: {}, exec: writes(home) });
    const linkSkills = npx(() => {
      for (const name of SKILLS) {
        const link = path.join(home, ".claude", "skills", name);
        mkdirSync(path.dirname(link), { recursive: true });
        symlinkSync(path.join(home, ".agents", "skills", name), link, "dir");
      }
    });
    const out = await installAgentSkills(SKILLS_REPO, ["claude-code", "codex"], {
      home,
      env: {},
      exec: linkSkills,
    });
    expect(out.restartRequired).toBe(true);
  });

  it("requires npx", async () => {
    await expect(
      installAgentSkills(SKILLS_REPO, ["codex"], {
        home,
        env: {},
        exec: fakeExec({ which: () => null }),
      }),
    ).rejects.toThrow(/requires Node\.js/);
  });

  it("reports npx failure", async () => {
    const exec = npx(undefined, "Error: repo not found");
    await expect(
      installAgentSkills(SKILLS_REPO, ["codex"], { home, env: {}, exec }),
    ).rejects.toThrow("npx skills failed: Error: repo not found");
  });
});

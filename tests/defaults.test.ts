import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type DefaultsDeps, runSetDefault, runUnsetDefault } from "../src/commands/defaults.js";
import {
  setClaudeDefault,
  setCodexDefault,
  unsetClaudeDefault,
  unsetCodexDefault,
} from "../src/core/agent-defaults.js";
import { captureOutput } from "./helpers/capture.js";
import { runProgram } from "./helpers/program.js";

const io = captureOutput();

function setup() {
  const home = mkdtempSync(join(tmpdir(), "tvly-defaults-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "tvly-defaults-cwd-"));
  return {
    home,
    cwd,
    claude: join(home, ".claude", "settings.json"),
    codex: join(home, ".codex", "config.toml"),
  };
}

/** Run the real command tree with injected paths and prompt; returns the exit code. */
const run = (argv: string[], deps: DefaultsDeps) =>
  runProgram(argv, undefined, {
    actions: {
      "set-default": (o, c) => runSetDefault(o, c, deps),
      "unset-default": (o, c) => runUnsetDefault(o, c, deps),
    },
  });

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("set-default creates both files", async () => {
  const t = setup();
  const code = await run(["set-default", "--claude", "--codex", "--json"], {
    home: t.home,
    cwd: t.cwd,
    env: {},
  });

  expect(code).toBe(0);
  expect(readJson(t.claude)).toEqual({ permissions: { deny: ["WebSearch", "WebFetch"] } });
  expect(readFileSync(t.codex, "utf8")).toBe('web_search = "disabled"\n');
  const payload = JSON.parse(io.stdout());
  expect(payload.ok).toBe(true);
  expect(payload.results.every((r: { changed: boolean }) => r.changed)).toBe(true);
});

test("claude round trip preserves existing settings", () => {
  const t = setup();
  mkdirSync(join(t.home, ".claude"));
  const original = {
    model: "opus",
    permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)", "WebFetch"] },
  };
  writeFileSync(t.claude, JSON.stringify(original));

  expect(setClaudeDefault(t.claude)).toBe(true);
  expect(readJson(t.claude).permissions.deny).toEqual(["Read(.env)", "WebFetch", "WebSearch"]);
  expect(setClaudeDefault(t.claude)).toBe(false);

  expect(unsetClaudeDefault(t.claude)).toBe(true);
  expect(readJson(t.claude)).toEqual({
    model: "opus",
    permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"] },
  });
  expect(unsetClaudeDefault(t.claude)).toBe(false);
});

test("claude unset drops empty permissions", () => {
  const t = setup();
  mkdirSync(join(t.home, ".claude"));
  writeFileSync(t.claude, JSON.stringify({ model: "opus" }));

  setClaudeDefault(t.claude);
  unsetClaudeDefault(t.claude);

  expect(readJson(t.claude)).toEqual({ model: "opus" });
});

test("claude invalid json is not overwritten", async () => {
  const t = setup();
  mkdirSync(join(t.home, ".claude"));
  writeFileSync(t.claude, "{not json");

  const code = await run(["set-default", "--claude"], { home: t.home, cwd: t.cwd, env: {} });

  expect(code).not.toBe(0);
  expect(readFileSync(t.claude, "utf8")).toBe("{not json");
  expect(io.stderr()).toContain("is not valid JSON");
});

test("codex round trip keeps tables", () => {
  const t = setup();
  mkdirSync(join(t.home, ".codex"));
  const original = 'model = "gpt-5"\n\n[profiles.work]\nweb_search = "live"\n';
  writeFileSync(t.codex, original);

  expect(setCodexDefault(t.codex)).toBe(true);
  expect(readFileSync(t.codex, "utf8")).toBe(`web_search = "disabled"\n${original}`);
  expect(setCodexDefault(t.codex)).toBe(false);

  expect(unsetCodexDefault(t.codex)).toBe(true);
  expect(readFileSync(t.codex, "utf8")).toBe(original);
  expect(unsetCodexDefault(t.codex)).toBe(false);
});

test("codex set replaces existing top-level value", () => {
  const t = setup();
  mkdirSync(join(t.home, ".codex"));
  writeFileSync(t.codex, 'model = "gpt-5"\nweb_search = "live"\n');

  expect(setCodexDefault(t.codex)).toBe(true);
  expect(readFileSync(t.codex, "utf8")).toBe('model = "gpt-5"\nweb_search = "disabled"\n');
});

test("prompts per agent when no flags are given", async () => {
  const t = setup();
  const questions: string[] = [];
  const answers = [true, false];
  const code = await run(["set-default"], {
    home: t.home,
    cwd: t.cwd,
    env: {},
    isTTY: true,
    confirm: async (q) => {
      questions.push(q);
      return answers.shift() as boolean;
    },
  });

  expect(code).toBe(0);
  expect(questions).toEqual([
    "Make Tavily the default web tool for Claude Code?",
    "Make Tavily the default web tool for Codex?",
  ]);
  expect(existsSync(t.claude)).toBe(true);
  expect(existsSync(t.codex)).toBe(false);
});

test("no flags in a non-interactive run is a usage error", async () => {
  const t = setup();
  const code = await run(["unset-default"], { home: t.home, cwd: t.cwd, env: {}, isTTY: false });

  expect(code).toBe(2);
  expect(io.stderr()).toContain("--claude");
});

test("project scope writes to cwd", async () => {
  const t = setup();
  const deps = { home: t.home, cwd: t.cwd, env: {} };

  const code = await run(["set-default", "--claude", "--codex", "--project", "--json"], deps);

  expect(code).toBe(0);
  const claude = join(t.cwd, ".claude", "settings.local.json");
  const codex = join(t.cwd, ".codex", "config.toml");
  expect(readJson(claude)).toEqual({ permissions: { deny: ["WebSearch", "WebFetch"] } });
  expect(readFileSync(codex, "utf8")).toBe('web_search = "disabled"\n');
  expect(existsSync(t.claude)).toBe(false);
  expect(existsSync(t.codex)).toBe(false);
  const scopes = JSON.parse(io.stdout()).results.map((r: { scope: string }) => r.scope);
  expect(new Set(scopes)).toEqual(new Set(["project"]));

  expect(await run(["unset-default", "--claude", "--codex", "--project"], deps)).toBe(0);
  expect(readJson(claude)).toEqual({});
  expect(readFileSync(codex, "utf8")).toBe("");
});

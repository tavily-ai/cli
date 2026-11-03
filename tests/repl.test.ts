import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { Command } from "commander";
import { expect, test, vi } from "vitest";
import { ExitError } from "../src/errors.js";
import { runRepl } from "../src/repl.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\x1b\[[0-9;]*m/g;

function setup(program: () => Command, lines: string[], rawLog?: Array<boolean | string>) {
  const input = new PassThrough();
  if (rawLog) {
    // A fake TTY stays open (like a real terminal); `exit` ends the session.
    Object.assign(input, {
      isTTY: true,
      setRawMode: (mode: boolean) => rawLog.push(mode),
    });
  }
  let text = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  });
  if (lines.length > 0) input.write(`${lines.join("\n")}\n`);
  if (!rawLog) input.end();
  const home = mkdtempSync(join(tmpdir(), "tvly-repl-"));
  const env = { TAVILY_API_KEY: "" } as NodeJS.ProcessEnv;
  return {
    run: () => runRepl({ input, output, program, home, env }),
    text: () => text.replace(ANSI, ""),
  };
}

function stubProgram(calls: string[][], behaviors: Record<string, () => void> = {}) {
  return () => {
    const p = new Command().exitOverride();
    for (const name of ["search", "boom", "fail"]) {
      p.command(name)
        .argument("[args...]")
        .action((args: string[]) => {
          calls.push([name, ...args]);
          behaviors[name]?.();
        });
    }
    return p;
  };
}

test("help lists init and update; banner promotes init and login", async () => {
  const t = setup(stubProgram([]), ["help", "exit"]);
  await t.run();
  const out = t.text();
  expect(out).toContain("Guided setup and skill installation");
  expect(out).toContain("Check for or install CLI updates");
  expect(out).toContain("Type init for guided setup and skill installation.");
  expect(out).toContain("Type login for browser authentication only.");
  expect(out).toContain("Goodbye!");
});

test("leading tvly is stripped and args are passed", async () => {
  const calls: string[][] = [];
  const t = setup(stubProgram(calls), ["tvly search 'two words'", "exit"]);
  await t.run();
  expect(calls).toEqual([["search", "two words"]]);
});

test("unterminated quote prints Parse error and continues", async () => {
  const calls: string[][] = [];
  const t = setup(stubProgram(calls), ['search "oops', "search ok", "exit"]);
  await t.run();
  expect(t.text()).toContain("Parse error: No closing quotation");
  expect(calls).toEqual([["search", "ok"]]);
});

test("ExitError, thrown errors and usage errors do not end the loop", async () => {
  const calls: string[][] = [];
  const t = setup(
    stubProgram(calls, {
      fail: () => {
        throw new ExitError(4);
      },
      boom: () => {
        throw new Error("kaboom\x07");
      },
    }),
    ["fail", "boom", "nosuch", "search done", "exit"],
  );
  await t.run();
  const out = t.text();
  expect(out).toContain("> Error: kaboom");
  expect(out).not.toContain("\x07");
  expect(out).toContain("> error: unknown command 'nosuch'");
  expect(calls).toEqual([["fail"], ["boom"], ["search", "done"]]);
});

test("EOF ends the loop like exit", async () => {
  const t = setup(stubProgram([]), []);
  await t.run();
  expect(t.text()).toContain("Goodbye!");
});

test("quit and q exit; blank lines are skipped", async () => {
  const calls: string[][] = [];
  const t = setup(stubProgram(calls), ["", "   ", "q", "search never"]);
  await t.run();
  expect(calls).toEqual([]);
});

test("raw mode is off while a command runs on a TTY and back on after", async () => {
  const log: Array<boolean | string> = [];
  const t = setup(stubProgram([], { search: () => log.push("cmd") }), ["search x", "exit"], log);
  await t.run();
  const i = log.indexOf("cmd");
  expect(i).toBeGreaterThan(0);
  expect(log[i - 1]).toBe(false);
  expect(log[i + 1]).toBe(true);
});

test("a non-TTY input never gets setRawMode calls", async () => {
  const input = new PassThrough();
  const setRawMode = vi.fn();
  Object.assign(input, { setRawMode });
  input.end("search x\nexit\n");
  const output = new Writable({ write: (_c, _e, cb) => cb() });
  const home = mkdtempSync(join(tmpdir(), "tvly-repl-"));
  await runRepl({
    input,
    output,
    program: stubProgram([]),
    home,
    env: { TAVILY_API_KEY: "" } as NodeJS.ProcessEnv,
  });
  expect(setRawMode).not.toHaveBeenCalled();
});

test("a usage error is printed once, by the REPL only", async () => {
  const stderrWrites: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  });
  try {
    const t = setup(stubProgram([]), ["search --bogus", "exit"]);
    await t.run();
    expect(t.text().split("unknown option '--bogus'").length - 1).toBe(1);
    expect(stderrWrites.join("")).not.toContain("unknown option");
  } finally {
    spy.mockRestore();
  }
});

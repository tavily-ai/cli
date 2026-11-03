import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runCli } from "./helpers/run-cli.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

test("--version prints name and version", async () => {
  const { stdout, code } = await runCli(["--version"]);
  expect(code).toBe(0);
  expect(stdout.trim()).toBe(`tavily-cli ${VERSION}`);
});

test("--version --json prints {version}", async () => {
  const { stdout } = await runCli(["--version", "--json"]);
  expect(JSON.parse(stdout)).toEqual({ version: VERSION });
});

test("unknown command exits 2", async () => {
  expect((await runCli(["bogus"])).code).toBe(2);
});

test("--status --json reports authenticated via env key", async () => {
  const home = mkdtempSync(join(tmpdir(), "tvly-home-"));
  const { stdout, code } = await runCli(["--status", "--json"], {
    env: { TAVILY_API_KEY: "tvly-x", HOME: home, USERPROFILE: home },
  });
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ version: VERSION, authenticated: true });
});

test("--status piped under CI has no color unless FORCE_COLOR is set", async () => {
  const home = mkdtempSync(join(tmpdir(), "tvly-home-"));
  const env = { CI: "true", FORCE_COLOR: "", NO_COLOR: "", HOME: home, USERPROFILE: home };
  const plain = await runCli(["--status"], { env: { ...env, TAVILY_API_KEY: "tvly-x" } });
  expect(plain.code).toBe(0);
  expect(plain.stdout).toContain("Authenticated via TAVILY_API_KEY");
  expect(plain.stdout).not.toContain("\x1b");
  const forced = await runCli(["--status"], {
    env: { ...env, FORCE_COLOR: "1", TAVILY_API_KEY: "tvly-x" },
  });
  expect(forced.stdout).toContain("\x1b");
  const off = await runCli(["--status"], {
    env: { ...env, FORCE_COLOR: "0", TAVILY_API_KEY: "tvly-x" },
  });
  expect(off.stdout).toContain("Authenticated via TAVILY_API_KEY");
  expect(off.stdout).not.toContain("\x1b");
});

test("colorEnabled: FORCE_COLOR=0 and NO_COLOR win over a TTY; other FORCE_COLOR values force color", async () => {
  const { colorEnabled } = await import("../src/ui/theme.js");
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(colorEnabled({})).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" })).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1" })).toBe(false);
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(colorEnabled({})).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "" })).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" })).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "3" })).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "true" })).toBe(true);
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

test("subcommand help lists the global --json flag", async () => {
  for (const args of [
    ["search", "--help"],
    ["research", "run", "--help"],
  ]) {
    const { stdout } = await runCli(args);
    expect(stdout).toContain("Global Options:");
    expect(stdout).toMatch(/^ {2}--json\s/m);
  }
});

test("--help lists every command and the setup hint", async () => {
  const { stdout } = await runCli(["--help"]);
  for (const name of [
    "init",
    "login",
    "logout",
    "auth",
    "search",
    "extract",
    "crawl",
    "map",
    "research",
    "update",
    "set-default",
    "unset-default",
  ]) {
    expect(stdout).toMatch(new RegExp(`^  ${name}[ |]`, "m"));
  }
  expect(stdout).toContain("First-time setup: tvly init");
});

test("dist/cli.js statically reaches no SDK, axios, lockfile, or markdown chunk", () => {
  const dist = new URL("../dist/", import.meta.url);
  const seen = new Set<string>();
  const queue = ["cli.js"];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(new URL(file, dist), "utf8");
    for (const banned of [
      'from "@tavily/core',
      'from "axios"',
      'from "proper-lockfile"',
      'from "marked',
    ]) {
      expect(src, `${file} contains ${banned}`).not.toContain(banned);
    }
    // Static imports only: `import ... from "./chunk-x.js"` and bare `import "./chunk-x.js"`.
    for (const m of src.matchAll(/^import\s+(?:[^"';]*?\s+from\s+)?"\.\/(chunk-[\w-]+\.js)"/gm)) {
      queue.push(m[1] as string);
    }
  }
  expect(seen.size).toBeGreaterThan(1);
});

test("an unexpected exception is printed with control bytes stripped", async () => {
  vi.resetModules();
  vi.doMock("../src/program.js", () => ({
    buildProgram: () => ({
      parseAsync: async () => {
        throw new Error("bad\x1b]0;title\x07 thing");
      },
    }),
  }));
  const printed: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
    printed.push(line);
  });
  try {
    const { main } = await import("../src/cli.js");
    expect(await main(["node", "tvly"])).toBe(1);
  } finally {
    spy.mockRestore();
    vi.doUnmock("../src/program.js");
  }
  expect(printed).toEqual(["  > Error: bad]0;title thing"]);
});

test("cli.ts sets exitCode instead of calling process.exit", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  expect(src).not.toContain("process.exit(");
});

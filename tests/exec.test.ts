import type { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createExec, whichOnPath } from "../src/util/exec.js";

type Spawn = typeof spawnSync;
type Spawned = ReturnType<Spawn>;

const spawned = (over: Partial<Spawned>): Spawned =>
  ({ status: 0, stdout: "", stderr: "", signal: null, ...over }) as Spawned;

function make(platform: NodeJS.Platform, exists = false, reply: Partial<Spawned> = {}) {
  const spawn = vi.fn(() => spawned(reply)) as unknown as Spawn;
  const exec = createExec({
    spawn,
    exists: () => exists,
    env: {},
    platform,
    execPath: platform === "win32" ? "C:\\node\\node.exe" : "/usr/bin/node",
  });
  const lastCall = () => (spawn as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
  return { exec, lastCall };
}

describe("run", () => {
  test("captures output with the shared spawn settings", () => {
    const { exec, lastCall } = make("linux", false, { stdout: "out\n", stderr: "warn\n" });
    const r = exec.run("/usr/bin/npm", ["root", "-g"], { timeoutMs: 15_000 });
    expect(r).toEqual({ ok: true, stdout: "out\n", stderr: "warn\n", failure: null });
    expect(lastCall()).toEqual([
      "/usr/bin/npm",
      ["root", "-g"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        shell: false,
      },
    ]);
  });

  test("inherit streams to the terminal, or to stderr only, and yields empty output", () => {
    const { exec, lastCall } = make("linux", false, {
      stdout: null as never,
      stderr: null as never,
    });
    expect(exec.run("/usr/bin/npm", ["i"], { inherit: true })).toMatchObject({
      stdout: "",
      stderr: "",
    });
    expect(lastCall()[2]).toMatchObject({ stdio: "inherit", timeout: undefined });
    const quiet = make("linux");
    quiet.exec.run("/usr/bin/npm", ["i"], { inherit: "stderr" });
    expect(quiet.lastCall()[2]).toMatchObject({ stdio: ["ignore", 2, 2] });
  });

  test.each([
    ["exit 0", {}, null],
    ["a timeout", { error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) }, "timed out"],
    ["a spawn error", { error: new Error("spawn npm ENOENT") }, "spawn npm ENOENT"],
    [
      "the last stderr line",
      { status: 1, stderr: "a\n\nError: boom\n\n", stdout: "x" },
      "Error: boom",
    ],
    ["the last stdout line when stderr is empty", { status: 1, stdout: "one\ntwo\n" }, "two"],
    ["the signal", { status: null, signal: "SIGKILL" }, "signal SIGKILL"],
    ["the exit code", { status: 3 }, "exit code 3"],
  ] as const)("failure reports %s", (_name, reply, failure) => {
    const { exec } = make("linux", false, reply as Partial<Spawned>);
    const r = exec.run("/usr/bin/npm", [], { timeoutMs: 1 });
    expect(r.failure).toBe(failure);
    expect(r.ok).toBe(failure === null);
  });
});

describe("run on Windows", () => {
  const NPX = "C:\\Program Files\\nodejs\\npx.cmd";

  test("a .cmd shim is quoted and run through the shell", () => {
    const { exec, lastCall } = make("win32");
    exec.run("C:\\tools\\codex.cmd", ["mcp", "add"], { timeoutMs: 1 });
    expect(lastCall().slice(0, 2)).toEqual(['"C:\\tools\\codex.cmd"', ["mcp", "add"]]);
    expect(lastCall()[2]).toMatchObject({ shell: true });
  });

  test("npm's shims run their cli.js through node when it exists", () => {
    const { exec, lastCall } = make("win32", true);
    exec.run(NPX, ["--yes", "add-mcp", "--header", "Authorization: Bearer x"], { timeoutMs: 1 });
    expect(lastCall().slice(0, 2)).toEqual([
      "C:\\node\\node.exe",
      [
        "C:\\node\\node_modules\\npm\\bin\\npx-cli.js",
        "--yes",
        "add-mcp",
        "--header",
        "Authorization: Bearer x",
      ],
    ]);
    expect(lastCall()[2]).toMatchObject({ shell: false });
    const npm = make("win32", true);
    npm.exec.run("C:\\Program Files\\nodejs\\npm.cmd", ["install"], { timeoutMs: 1 });
    expect(npm.lastCall()[0]).toBe("C:\\node\\node.exe");
    expect((npm.lastCall()[1] as string[])[0]).toMatch(/npm-cli\.js$/);
  });

  test("npx falls back to the quoted .cmd through the shell without npx-cli.js", () => {
    const { exec, lastCall } = make("win32", false);
    exec.run(NPX, ["--yes"], { timeoutMs: 1 });
    expect(lastCall().slice(0, 2)).toEqual([`"${NPX}"`, ["--yes"]]);
    expect(lastCall()[2]).toMatchObject({ shell: true });
  });

  test("an .exe runs directly", () => {
    const { exec, lastCall } = make("win32");
    exec.run("C:\\tools\\codex.exe", [], { timeoutMs: 1 });
    expect(lastCall()[0]).toBe("C:\\tools\\codex.exe");
    expect(lastCall()[2]).toMatchObject({ shell: false });
  });
});

describe("whichOnPath", () => {
  test.skipIf(process.platform === "win32")(
    "finds an executable, skips the npx cache, and honors PATHEXT on Windows",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "tvly-which-"));
      const bin = path.join(root, "bin");
      const npx = path.join(root, "_npx", "abc", "node_modules", ".bin");
      for (const dir of [bin, npx]) mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(bin, "tvly"), "");
      chmodSync(path.join(bin, "tvly"), 0o755);
      writeFileSync(path.join(npx, "tvly"), "");
      chmodSync(path.join(npx, "tvly"), 0o755);
      writeFileSync(path.join(bin, "npm.cmd"), "");
      chmodSync(path.join(bin, "npm.cmd"), 0o755);
      const PATH = [npx, bin].join(path.delimiter);
      expect(whichOnPath("tvly", { PATH }, false)).toBe(path.join(bin, "tvly"));
      expect(whichOnPath("npm", { PATH }, false)).toBeNull();
      expect(whichOnPath("npm", { PATH, PATHEXT: ".EXE;.cmd" }, true)).toBe(
        path.join(bin, "npm.cmd"),
      );
      expect(whichOnPath("missing", { PATH }, false)).toBeNull();
    },
  );
});

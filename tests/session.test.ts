import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { grandparentPid, pidAlive, resolveSessionId } from "../src/core/session.js";
import { fakeExec } from "./helpers/exec.js";

function tempDir(sessions?: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tvly-session-"));
  if (sessions) writeFileSync(path.join(dir, "session.json"), JSON.stringify(sessions));
  return dir;
}

function readSessions(dir: string): Record<string, string> {
  return JSON.parse(readFileSync(path.join(dir, "session.json"), "utf8"));
}

test("returns stored id for a known ppid without calling gppid", () => {
  const configDir = tempDir({ "100": "abc" });
  const gppid = vi.fn(() => 5);
  const id = resolveSessionId({ configDir, ppid: 100, gppid, pidAlive: () => true });
  expect(id).toBe("abc");
  expect(gppid).not.toHaveBeenCalled();
});

test("returns stored id for a known live gppid", () => {
  const configDir = tempDir({ "5": "grand" });
  const id = resolveSessionId({ configDir, ppid: 100, gppid: () => 5, pidAlive: () => true });
  expect(id).toBe("grand");
});

test("ignores a known gppid that is dead and mints a new id", () => {
  const configDir = tempDir({ "5": "grand" });
  const id = resolveSessionId({ configDir, ppid: 100, gppid: () => 5, pidAlive: () => false });
  expect(id).not.toBe("grand");
  expect(readSessions(configDir)).toEqual({ "100": id, "5": id });
});

test("mints a new id, writes it under both pids, and prunes dead pids", () => {
  const configDir = tempDir({ "1": "dead", "2": "live" });
  const id = resolveSessionId({
    configDir,
    ppid: 100,
    gppid: () => 5,
    pidAlive: (pid) => pid !== 1,
  });
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(readSessions(configDir)).toEqual({ "2": "live", "100": id, "5": id });
});

test("stores only ppid when gppid is null and treats a corrupt file as empty", () => {
  const configDir = tempDir();
  writeFileSync(path.join(configDir, "session.json"), "{not json");
  const id = resolveSessionId({ configDir, ppid: 100, gppid: () => null, pidAlive: () => true });
  expect(readSessions(configDir)).toEqual({ "100": id });
});

test("grandparentPid parses /proc stat on linux", () => {
  const readFile = vi.fn(() => "1234 (node) S 42 1234 1234 0 -1");
  expect(grandparentPid(1234, { platform: "linux", exec: fakeExec() }, readFile)).toBe(42);
  expect(readFile).toHaveBeenCalledWith("/proc/1234/stat");
});

test("grandparentPid handles parentheses in the linux command name", () => {
  const readFile = () => "1234 (a) b) S 42 1 1";
  expect(grandparentPid(1234, { platform: "linux", exec: fakeExec() }, readFile)).toBe(42);
});

test("grandparentPid parses ps output on darwin", () => {
  const exec = fakeExec({ run: () => ({ stdout: "  77\n" }) });
  expect(grandparentPid(9, { platform: "darwin", exec })).toBe(77);
  expect(exec.calls).toEqual([
    { bin: "ps", args: ["-o", "ppid=", "-p", "9"], opts: { timeoutMs: 2000 } },
  ]);
});

test("grandparentPid parses PowerShell output on win32", () => {
  const exec = fakeExec({ run: () => ({ stdout: "808\r\n" }) });
  expect(grandparentPid(9, { platform: "win32", exec })).toBe(808);
  expect(exec.calls[0]).toMatchObject({
    bin: "powershell",
    args: [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Process -Filter 'ProcessId=9').ParentProcessId",
    ],
  });
});

test("grandparentPid returns null on a failed run or non-integer output", () => {
  const failed = fakeExec({ run: () => ({ ok: false, stdout: "3\n", failure: "ENOENT" }) });
  expect(grandparentPid(9, { platform: "darwin", exec: failed })).toBeNull();
  const junk = fakeExec({ run: () => ({ stdout: "abc\n" }) });
  expect(grandparentPid(9, { platform: "darwin", exec: junk })).toBeNull();
  expect(grandparentPid(9, { platform: "win32", exec: fakeExec() })).toBeNull();
  const throws = () => {
    throw new Error("nope");
  };
  expect(grandparentPid(9, { platform: "linux", exec: fakeExec() }, throws)).toBeNull();
});

test("pidAlive is true for this process and false for an impossible pid", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22 + 12345)).toBe(false);
});

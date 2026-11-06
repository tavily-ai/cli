import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { grandparentPid, pidAlive, resolveSessionId } from "../src/core/session.js";

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
  expect(grandparentPid(1234, { platform: "linux", readFile })).toBe(42);
  expect(readFile).toHaveBeenCalledWith("/proc/1234/stat");
});

test("grandparentPid handles parentheses in the linux command name", () => {
  const readFile = () => "1234 (a) b) S 42 1 1";
  expect(grandparentPid(1234, { platform: "linux", readFile })).toBe(42);
});

test("grandparentPid parses ps output on darwin", () => {
  const spawnSync = vi.fn(() => ({ status: 0, stdout: "  77\n" }));
  const got = grandparentPid(9, { platform: "darwin", spawnSync: spawnSync as never });
  expect(got).toBe(77);
  expect(spawnSync.mock.calls[0]?.slice(0, 2)).toEqual(["ps", ["-o", "ppid=", "-p", "9"]]);
});

test("grandparentPid parses PowerShell output on win32", () => {
  const spawnSync = vi.fn(() => ({ status: 0, stdout: "808\r\n" }));
  const got = grandparentPid(9, { platform: "win32", spawnSync: spawnSync as never });
  expect(got).toBe(808);
  const [cmd, args] = spawnSync.mock.calls[0] as unknown as [string, string[]];
  expect(cmd).toBe("powershell");
  expect(args).toEqual([
    "-NoProfile",
    "-Command",
    "(Get-CimInstance Win32_Process -Filter 'ProcessId=9').ParentProcessId",
  ]);
});

test("grandparentPid returns null on spawn failure, bad exit, or non-integer output", () => {
  const fail = () => ({ status: null, stdout: "", error: new Error("ENOENT") });
  expect(grandparentPid(9, { platform: "darwin", spawnSync: fail as never })).toBeNull();
  const bad = () => ({ status: 1, stdout: "3\n" });
  expect(grandparentPid(9, { platform: "darwin", spawnSync: bad as never })).toBeNull();
  const junk = () => ({ status: 0, stdout: "abc\n" });
  expect(grandparentPid(9, { platform: "darwin", spawnSync: junk as never })).toBeNull();
  const empty = () => ({ status: 0, stdout: "" });
  expect(grandparentPid(9, { platform: "win32", spawnSync: empty as never })).toBeNull();
  const throws = () => {
    throw new Error("nope");
  };
  expect(grandparentPid(9, { platform: "linux", readFile: throws })).toBeNull();
});

test("pidAlive is true for this process and false for an impossible pid", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22 + 12345)).toBe(false);
});

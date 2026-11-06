import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isObject } from "../errors.js";

type Sessions = Record<string, string>;

export interface GrandparentOptions {
  spawnSync?: typeof childProcess.spawnSync;
  platform?: NodeJS.Platform;
  readFile?: (p: string) => string;
}

export interface ResolveOptions {
  configDir: string;
  ppid: number;
  gppid: () => number | null;
  pidAlive: (pid: number) => boolean;
}

function newId(): string {
  return randomUUID().replace(/-/g, "");
}

function parsePid(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function grandparentPid(ppid: number, opts: GrandparentOptions = {}): number | null {
  const platform = opts.platform ?? process.platform;
  const spawnSync = opts.spawnSync ?? childProcess.spawnSync;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    if (platform === "linux") {
      const stat = readFile(`/proc/${ppid}/stat`);
      // Fields after the ")" closing the command name: state, ppid, ...
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      return parsePid(fields[1] ?? "");
    }
    const [cmd, args] =
      platform === "win32"
        ? [
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter 'ProcessId=${ppid}').ParentProcessId`,
            ],
          ]
        : ["ps", ["-o", "ppid=", "-p", String(ppid)]];
    const res = spawnSync(cmd as string, args as string[], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return null;
    return parsePid(String(res.stdout));
  } catch {
    return null;
  }
}

function readSessions(file: string): Sessions {
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObject(data) ? (data as Sessions) : {};
  } catch {
    return {};
  }
}

function writeSessions(configDir: string, file: string, sessions: Sessions): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
}

export function resolveSessionId(opts: ResolveOptions): string {
  const file = path.join(opts.configDir, "session.json");
  const sessions = readSessions(file);
  const ppid = String(opts.ppid);

  const byParent = sessions[ppid];
  if (byParent !== undefined) return byParent;

  const gppid = opts.gppid();
  const byGrandparent = gppid === null ? undefined : sessions[String(gppid)];
  if (gppid !== null && byGrandparent !== undefined && opts.pidAlive(gppid)) return byGrandparent;

  const alive: Sessions = {};
  for (const [pid, sid] of Object.entries(sessions)) {
    if (opts.pidAlive(Number(pid))) alive[pid] = sid;
  }
  const id = newId();
  alive[ppid] = id;
  if (gppid !== null) alive[String(gppid)] = id;
  writeSessions(opts.configDir, file, alive);
  return id;
}

let cached: string | undefined;

export function getSessionId(): string {
  if (cached === undefined) {
    try {
      cached = resolveSessionId({
        configDir: path.join(homedir(), ".tavily"),
        ppid: process.ppid,
        gppid: () => grandparentPid(process.ppid),
        pidAlive,
      });
    } catch {
      cached = newId();
    }
  }
  return cached;
}

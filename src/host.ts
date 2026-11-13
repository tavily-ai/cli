/** Everything the CLI reads from the machine, in one value; tests substitute a fake. */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { TavilyClientLike } from "./core/tavily-client.js";
import { clackPrompter, type Prompter } from "./ui/prompts.js";
import { type Exec, exec } from "./util/exec.js";

export interface Host {
  home: string;
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  now(): number;
  fetch: typeof fetch;
  exec: Exec;
  prompt: Prompter;
  openUrl(url: string): void;
  resolveClient(key: string | null, clientName?: string): Promise<TavilyClientLike>;
}

/** Best-effort browser launch; failures are ignored because the URL was already printed. */
export function openBrowser(url: string, platform: NodeJS.Platform, spawnImpl = spawn): void {
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnImpl(cmd as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore
  }
}

/** The running process's machine. The SDK loads only when a command calls the API. */
export function realHost(): Host {
  const host: Host = {
    home: homedir(),
    cwd: process.cwd(),
    argv: process.argv,
    env: process.env,
    platform: process.platform,
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    now: Date.now,
    fetch: globalThis.fetch,
    exec,
    prompt: clackPrompter,
    openUrl: (url) => openBrowser(url, process.platform),
    resolveClient: async (key, clientName) =>
      (await import("./core/client-factory.js")).buildClient(key, clientName, host),
  };
  return host;
}

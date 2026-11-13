/** The deprecated Python tavily-cli installs a `tvly` that can shadow this one on PATH. */
import type { Host } from "../host.js";

export interface LegacyCli {
  path: string;
  version: string;
  /** The owning tool's uninstall command, or null when neither uv nor pipx claims the package. */
  uninstall: [string, ...string[]] | null;
}

const PACKAGE = "tavily-cli";

/** A `tvly` on PATH that reports a pre-1.0 version is the Python CLI. */
export function findLegacyCli(host: Pick<Host, "exec">): LegacyCli | null {
  const path = host.exec.which("tvly");
  if (!path) return null;
  const res = host.exec.run(path, ["--version"], { timeoutMs: 5000 });
  const version = res.stdout.trim().split(/\s+/).pop() ?? "";
  if (!res.ok || !/^0\.\d/.test(version)) return null;
  return { path, version, uninstall: uninstallCommand(host) };
}

/** `pip` is left out: it may resolve to an interpreter other than the one that installed the CLI. */
function uninstallCommand(host: Pick<Host, "exec">): [string, ...string[]] | null {
  const tools: [string, string[], string[]][] = [
    ["uv", ["tool", "list"], ["tool", "uninstall", PACKAGE]],
    ["pipx", ["list", "--short"], ["uninstall", PACKAGE]],
  ];
  for (const [tool, list, uninstall] of tools) {
    const bin = host.exec.which(tool);
    if (bin && host.exec.run(bin, list, { timeoutMs: 10_000 }).stdout.includes(PACKAGE)) {
      return [bin, ...uninstall];
    }
  }
  return null;
}

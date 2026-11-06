/** tvly update — check for or install the latest Tavily CLI release. */
import * as childProcess from "node:child_process";
import { realpathSync } from "node:fs";
import type { Command } from "commander";
import { detectInstall, fetchLatestVersion, type InstallInfo } from "../core/install-detect.js";
import { ExitError, messageOf } from "../errors.js";
import { sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";
import { runManager, type SpawnFn } from "../util/process.js";
import { compareVersions, isNewer } from "../util/semver.js";
import { VERSION } from "../version.js";
import { resolveJson } from "./options.js";

export interface UpdateDeps {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  detectInstall?: () => InstallInfo;
  spawnImpl?: SpawnFn;
  argv1?: string;
  realpath?: (p: string) => string;
  platform?: NodeJS.Platform;
}

interface UpdateOptions {
  check?: boolean;
}

export async function run(opts: UpdateOptions, cmd: Command, deps: UpdateDeps = {}): Promise<void> {
  const json = resolveJson(cmd);
  const current = deps.currentVersion ?? VERSION;

  let latest: string;
  let updateAvailable: boolean;
  try {
    latest = await fetchLatestVersion(deps.fetchImpl);
    updateAvailable = isNewer(latest, current);
  } catch (e) {
    return fail("check", messageOf(e), 4, json);
  }

  let install: InstallInfo;
  try {
    install = (deps.detectInstall ?? detectInstall)();
  } catch (e) {
    return fail("install_method", messageOf(e), 1, json);
  }

  if (opts.check || !updateAvailable) {
    printResult(result(current, latest, install, false), current, json, opts.check === true);
    return;
  }

  if (install.command === null) {
    return fail("install_method", install.blockedReason ?? "", 1, json);
  }

  if (!json) out(`Updating Tavily CLI via ${install.method}...`);

  const spawnImpl: SpawnFn = deps.spawnImpl ?? childProcess.spawnSync;
  // The manager's resolved path; Windows runs its .cmd shim through the shell.
  const [file = "", ...args] = install.command;
  const completed = runManager(
    spawnImpl,
    file,
    args,
    (deps.platform ?? process.platform) === "win32",
  );
  if (completed.error) {
    return fail("update", completed.error.message, 1, json);
  }
  if (completed.status !== 0) {
    const detail =
      String(completed.stderr ?? "").trim() ||
      String(completed.stdout ?? "").trim() ||
      (completed.status === null
        ? `Terminated by signal ${completed.signal}.`
        : `Exited with status ${completed.status}.`);
    return fail("update", detail.slice(-2000), 1, json);
  }

  let installed: string;
  try {
    installed = installedVersion(deps, spawnImpl);
    if (isNewer(latest, installed)) {
      let message =
        `The package manager completed, but Tavily CLI is still ${installed}; latest is ${latest}. ` +
        "The installation may be pinned.";
      const hint = managerHint(completed);
      if (hint) message += ` Package manager reported: ${hint}`;
      throw new Error(message);
    }
  } catch (e) {
    return fail("verify", messageOf(e), 1, json);
  }

  printResult(
    result(installed, latest, install, compareVersions(installed, current) !== 0),
    current,
    json,
    false,
  );
}

/** Ask the (possibly upgraded) installed binary for its version: `node <entry> --version`. */
function installedVersion(deps: UpdateDeps, spawnImpl: SpawnFn): string {
  const realpath = deps.realpath ?? realpathSync;
  const entry = realpath(deps.argv1 ?? process.argv[1] ?? "");
  const r = spawnImpl(process.execPath, [entry, "--version"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (r.error)
    throw new Error(`Could not read the installed Tavily CLI version: ${r.error.message}`);
  const token = sanitizeControl(r.stdout ?? "")
    .trim()
    .split(/\s+/)
    .pop();
  if (r.status !== 0 || !token) {
    throw new Error("Could not read the installed Tavily CLI version.");
  }
  return token;
}

/** A bounded package-manager hint, without echoing arbitrary command output. */
function managerHint(completed: { stderr?: unknown; stdout?: unknown }): string | null {
  for (const output of [completed.stderr, completed.stdout]) {
    const lines = String(output ?? "").split(/\r?\n/);
    for (const line of lines.reverse()) {
      const candidate = sanitizeControl(line).trim();
      if (candidate.toLowerCase().startsWith("hint:")) return candidate.slice(0, 1000);
    }
  }
  return null;
}

function result(current: string, latest: string, install: InstallInfo, updated: boolean) {
  return {
    ok: true,
    current_version: current,
    latest_version: latest,
    update_available: isNewer(latest, current),
    install_method: install.method,
    can_update: install.command !== null,
    blocked_reason: install.command === null ? install.blockedReason : null,
    updated,
  };
}

function fail(stage: string, message: string, code: number, json: boolean): never {
  const safe = sanitizeControl(message);
  if (json) out(JSON.stringify({ ok: false, error: { stage, message: safe } }));
  else err(`  ${colors.pink("> Update failed:")} ${safe}`);
  throw new ExitError(code);
}

function printResult(
  r: ReturnType<typeof result>,
  started: string,
  json: boolean,
  checkOnly: boolean,
): void {
  if (json) {
    out(JSON.stringify(r));
  } else if (r.updated) {
    out(`Updated Tavily CLI: ${started} -> ${r.current_version}`);
  } else if (r.update_available) {
    out(`Tavily CLI update available: ${r.current_version} -> ${r.latest_version}`);
    if (checkOnly) {
      if (r.can_update) out("Run `tvly update` to install it.");
      else out(`Self-update unavailable: ${sanitizeControl(r.blocked_reason)}`);
    }
  } else {
    out(`Tavily CLI ${r.current_version} is up to date.`);
  }
}

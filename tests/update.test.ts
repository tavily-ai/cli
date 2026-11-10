import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  detectInstall,
  fetchLatestVersion,
  npmRootGlobalDefault,
} from "../src/core/install-detect.js";
import type { Host } from "../src/host.js";
import { compareVersions, isNewer } from "../src/util/semver.js";
import { VERSION } from "../src/version.js";
import { captureOutput } from "./helpers/capture.js";
import { type FakeExec, fakeExec, type ExecScript as Run } from "./helpers/exec.js";
import { fakeHost, runProgram } from "./helpers/program.js";

const io = captureOutput();

const found = (name: string) => `/usr/bin/${name}`;
const NPM_ROOT = "/opt/u/lib/node_modules";
const NPM_ENTRY = `${NPM_ROOT}/@tavily/cli/dist/cli.js`;
const SOURCE_ENTRY = "/work/tavily-cli/dist/cli.js";
const SOURCE_REASON =
  "This is a source or direct-URL installation. Update it from its original source.";

/** `npm root -g` prints `root` (or fails); other runs follow `rest`, defaulting to silent success. */
const npmExec = (root: string | null = NPM_ROOT, rest: Run = () => undefined) =>
  fakeExec({
    which: found,
    run: (bin, args) =>
      args[0] === "root"
        ? root
          ? { stdout: `${root}\n` }
          : { ok: false, failure: "exit code 1" }
        : rest(bin, args),
  });

const detect = (argv1: string, over: Partial<Host> = {}) =>
  detectInstall(fakeHost({ argv: ["node", argv1], exec: npmExec(), ...over }));

describe("detectInstall", () => {
  test.each([
    [NPM_ENTRY, "npm", ["/usr/bin/npm", "install", "-g", "@tavily/cli@latest"]],
    [
      "/opt/u/.local/share/pnpm/global/5/node_modules/@tavily/cli/dist/cli.js",
      "pnpm",
      ["/usr/bin/pnpm", "add", "-g", "@tavily/cli@latest"],
    ],
    [
      "/opt/u/.config/yarn/global/node_modules/@tavily/cli/dist/cli.js",
      "yarn",
      ["/usr/bin/yarn", "global", "add", "@tavily/cli@latest"],
    ],
    [
      "/opt/u/.yarn/global/node_modules/@tavily/cli/dist/cli.js",
      "yarn",
      ["/usr/bin/yarn", "global", "add", "@tavily/cli@latest"],
    ],
    [
      "/opt/u/.bun/install/global/node_modules/@tavily/cli/dist/cli.js",
      "bun",
      ["/usr/bin/bun", "add", "-g", "@tavily/cli@latest"],
    ],
  ])("%s is %s", (argv1, method, command) => {
    expect(detect(argv1)).toEqual({ method, command, blockedReason: null });
  });

  test("Windows npm global path is classified as npm and runs the resolved npm", () => {
    const npm = "C:\\Program Files\\nodejs\\npm.cmd";
    const exec = fakeExec({
      which: () => npm,
      run: () => ({ stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\n" }),
    });
    const info = detect(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@tavily\\cli\\dist\\cli.js",
      {
        exec,
      },
    );
    expect(info.method).toBe("npm");
    expect(info.command).toEqual([npm, "install", "-g", "@tavily/cli@latest"]);
  });

  test("npm root -g runs the resolved npm with a short timeout", () => {
    const exec = npmExec();
    expect(npmRootGlobalDefault({ exec })).toBe(NPM_ROOT);
    expect(exec.calls).toEqual([
      { bin: "/usr/bin/npm", args: ["root", "-g"], opts: { timeoutMs: 15_000 } },
    ]);
    expect(npmRootGlobalDefault({ exec: npmExec(null) })).toBeNull();
  });

  test("PNPM_HOME marks a pnpm install", () => {
    const info = detect("/custom/pnpmhome/global/5/node_modules/@tavily/cli/dist/cli.js", {
      env: { PNPM_HOME: "/custom/pnpmhome" },
      exec: npmExec(null),
    });
    expect(info.method).toBe("pnpm");
  });

  test("npx cache is blocked", () => {
    const info = detect("/opt/u/.npm/_npx/abc123/node_modules/@tavily/cli/dist/cli.js");
    expect(info.method).toBe("npx");
    expect(info.command).toBeNull();
    expect(info.blockedReason).toContain("npx @tavily/cli@latest");
  });

  test("a checkout outside node_modules is a source install", () => {
    expect(detect(SOURCE_ENTRY)).toEqual({
      method: "source",
      command: null,
      blockedReason: SOURCE_REASON,
    });
  });

  test.skipIf(process.platform === "win32")("an npm link symlink is a source install", () => {
    const root = mkdtempSync(join(tmpdir(), "tvly-link-"));
    const checkout = join(root, "work", "tavily-cli");
    mkdirSync(join(checkout, "dist"), { recursive: true });
    writeFileSync(join(checkout, "dist", "cli.js"), "");
    const scope = join(root, "lib", "node_modules", "@tavily");
    mkdirSync(scope, { recursive: true });
    symlinkSync(checkout, join(scope, "cli"), "dir");
    const info = detect(join(scope, "cli", "dist", "cli.js"), {
      exec: npmExec(join(root, "lib", "node_modules")),
    });
    expect(info.method).toBe("source");
  });

  test("an unrecognised node_modules location is unknown and blocked", () => {
    const info = detect("/opt/app/node_modules/@tavily/cli/dist/cli.js", { exec: npmExec(null) });
    expect(info.method).toBe("unknown");
    expect(info.command).toBeNull();
    expect(info.blockedReason).toContain("Could not determine how Tavily CLI was installed");
  });

  test("a missing manager binary blocks the update", () => {
    const host = fakeHost({ argv: ["node", NPM_ENTRY], exec: fakeExec({ which: () => null }) });
    const info = detectInstall(host, () => NPM_ROOT);
    expect(info.method).toBe("npm");
    expect(info.command).toBeNull();
    expect(info.blockedReason).toBe(
      "This installation is managed by npm, but npm is not available on PATH.",
    );
  });
});

const jsonReply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("fetchLatestVersion", () => {
  test("reads .version from the registry without following redirects", async () => {
    const spy = vi.fn(jsonReply({ version: "1.2.3" }));
    expect(await fetchLatestVersion(spy)).toBe("1.2.3");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://registry.npmjs.org/@tavily/cli/latest");
    expect(init.redirect).toBe("manual");
  });

  test("an invalid version is rejected", async () => {
    await expect(fetchLatestVersion(jsonReply({ version: "nope" }))).rejects.toThrow(
      "npm returned an invalid Tavily CLI version.",
    );
    await expect(fetchLatestVersion(jsonReply({}))).rejects.toThrow(
      "npm returned an invalid Tavily CLI version.",
    );
  });
});

const NEWER = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));

/** npm succeeds; the re-read `--version` prints the given installed version. */
const upgradeTo =
  (installed: string, npmStdout = ""): Run =>
  (bin) =>
    bin === process.execPath ? { stdout: `tavily-cli ${installed}\n` } : { stdout: npmStdout };

/** An npm-installed CLI whose registry says `NEWER`; `run` scripts the manager and the re-read. */
const base = (over: Partial<Host> = {}, run: Run = upgradeTo(NEWER)) =>
  fakeHost({
    argv: ["node", NPM_ENTRY],
    fetch: jsonReply({ version: NEWER }),
    exec: npmExec(NPM_ROOT, run),
    ...over,
  });

const failedRun =
  (failure: string): Run =>
  () => ({ ok: false, failure });

/** The recorded runs after the `npm root -g` of install detection. */
const installs = (host: Host) => (host.exec as FakeExec).calls.filter((c) => c.args[0] !== "root");

describe("update command", () => {
  test("--check --json is read-only", async () => {
    const host = base();
    expect(await runProgram(["--json", "update", "--check"], host)).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: true,
      current_version: VERSION,
      latest_version: NEWER,
      update_available: true,
      install_method: "npm",
      can_update: true,
      blocked_reason: null,
      updated: false,
    });
    expect(installs(host)).toEqual([]);
  });

  test("--check reports a source install as blocked", async () => {
    await runProgram(["--json", "update", "--check"], base({ argv: ["node", SOURCE_ENTRY] }));
    const out = JSON.parse(io.stdout());
    expect(out.can_update).toBe(false);
    expect(out.blocked_reason).toBe(SOURCE_REASON);
  });

  test("--check human output recommends tvly update only when allowed", async () => {
    await runProgram(["update", "--check"], base());
    expect(io.stdout()).toContain(`Tavily CLI update available: ${VERSION} -> ${NEWER}`);
    expect(io.stdout()).toContain("Run `tvly update` to install it.");
  });

  test("--check human output does not recommend a blocked self-update", async () => {
    await runProgram(["update", "--check"], base({ argv: ["node", SOURCE_ENTRY] }));
    expect(io.stdout()).toContain("Self-update unavailable:");
    expect(io.stdout()).not.toContain("Run `tvly update`");
  });

  test("does nothing when current", async () => {
    const host = base({ fetch: jsonReply({ version: VERSION }) });
    expect(await runProgram(["--json", "update"], host)).toBe(0);
    expect(JSON.parse(io.stdout()).update_available).toBe(false);
    expect(installs(host)).toEqual([]);
  });

  test("runs the detected manager and verifies the installed version", async () => {
    const host = base({}, upgradeTo(NEWER, "updated"));
    expect(await runProgram(["--json", "update"], host)).toBe(0);
    expect(installs(host)).toEqual([
      {
        bin: "/usr/bin/npm",
        args: ["install", "-g", "@tavily/cli@latest"],
        opts: { timeoutMs: 300_000 },
      },
      { bin: process.execPath, args: [NPM_ENTRY, "--version"], opts: { timeoutMs: 30_000 } },
    ]);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: true,
      current_version: NEWER,
      latest_version: NEWER,
      update_available: false,
      install_method: "npm",
      can_update: true,
      blocked_reason: null,
      updated: true,
    });
  });

  test("control bytes in the re-read version are stripped before it is parsed or printed", async () => {
    const run: Run = (bin) =>
      bin === process.execPath ? { stdout: `tavily-cli ${NEWER}\x07\n` } : undefined;
    expect(await runProgram(["--json", "update"], base({}, run))).toBe(0);
    expect(JSON.parse(io.stdout()).current_version).toBe(NEWER);
  });

  test("human flow prints progress and result", async () => {
    await runProgram(["update"], base());
    expect(io.stdout()).toContain("Updating Tavily CLI via npm...");
    expect(io.stdout()).toContain(`Updated Tavily CLI: ${VERSION} -> ${NEWER}`);
  });

  test("refuses a blocked install with stage install_method", async () => {
    const host = base({ argv: ["node", SOURCE_ENTRY] });
    expect(await runProgram(["--json", "update"], host)).toBe(1);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: false,
      error: { stage: "install_method", message: SOURCE_REASON },
    });
  });

  test("update failure is the shared failure summary, structured and sanitized", async () => {
    expect(await runProgram(["--json", "update"], base({}, failedRun("failed\x1b[2J")))).toBe(1);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: false,
      error: { stage: "update", message: "failed[2J" },
    });
    expect(await runProgram(["--json", "update"], base({}, failedRun("exit code 2")))).toBe(1);
    expect(JSON.parse(io.stdout().trim().split("\n").at(-1) ?? "").error.message).toBe(
      "exit code 2",
    );
  });

  test("a failure to start the manager is reported at the update stage", async () => {
    expect(await runProgram(["--json", "update"], base({}, failedRun("spawn npm ENOENT")))).toBe(1);
    const out = JSON.parse(io.stdout());
    expect(out.error.stage).toBe("update");
    expect(out.error.message).toContain("ENOENT");
  });

  test("verifies the manager changed the version", async () => {
    expect(await runProgram(["--json", "update"], base({}, upgradeTo(VERSION)))).toBe(1);
    const out = JSON.parse(io.stdout());
    expect(out.error.stage).toBe("verify");
    expect(out.error.message).toContain("may be pinned");
  });

  test("surfaces the manager hint when a successful upgrade is pinned", async () => {
    const run = upgradeTo(VERSION, "Nothing to upgrade\nhint: pin set in .npmrc\n");
    await runProgram(["--json", "update"], base({}, run));
    expect(JSON.parse(io.stdout()).error.message).toContain(
      "Package manager reported: hint: pin set in .npmrc",
    );
  });

  test("does not echo non-hint output after a successful no-op", async () => {
    const run = upgradeTo(
      VERSION,
      "Registry: https://user:secret@example.com/\nNothing to upgrade\n",
    );
    await runProgram(["--json", "update"], base({}, run));
    expect(io.stdout()).not.toContain("secret");
  });

  test("check failure is structured and exits 4", async () => {
    const host = base({ fetch: jsonReply({}, 503) });
    expect(await runProgram(["--json", "update", "--check"], host)).toBe(4);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: false,
      error: { stage: "check", message: "Could not check npm for Tavily CLI updates." },
    });
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await runProgram(["--json", "update", "--check"], base({ fetch: down }))).toBe(4);
  });

  test("install detection failure is not reported as a network error", async () => {
    const exec = fakeExec({
      run: () => {
        throw new Error("Package metadata unavailable");
      },
    });
    expect(await runProgram(["--json", "update", "--check"], base({ exec }))).toBe(1);
    expect(JSON.parse(io.stdout()).error).toEqual({
      stage: "install_method",
      message: "Package metadata unavailable",
    });
  });

  test("human failure goes to stderr", async () => {
    await runProgram(["update"], base({}, failedRun("boom")));
    expect(io.stderr()).toContain("Update failed:");
    expect(io.stderr()).toContain("boom");
  });
});

describe("semver", () => {
  test("compares numerically per component", () => {
    expect(compareVersions("0.3.0", "0.2.1")).toBe(1);
    expect(compareVersions("0.2.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("a release ranks above its prerelease; prerelease identifiers compare per identifier", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.9")).toBe(1);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareVersions("1.0.0-rc", "1.0.0-rc.1")).toBe(-1);
  });

  test("unparsable versions throw", () => {
    expect(() => isNewer("0.3.0", "abc")).toThrow("The installed Tavily CLI version is invalid.");
    expect(() => compareVersions("abc", "1.0.0")).toThrow(
      "The installed Tavily CLI version is invalid.",
    );
  });
});

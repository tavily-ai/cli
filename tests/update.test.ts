import { describe, expect, test, vi } from "vitest";
import { run, type UpdateDeps } from "../src/commands/update.js";
import {
  detectInstall,
  fetchLatestVersion,
  npmRootGlobalDefault,
} from "../src/core/install-detect.js";
import { compareVersions, isNewer } from "../src/util/semver.js";
import { captureOutput } from "./helpers/capture.js";
import { fakeExec } from "./helpers/exec.js";
import { runProgram } from "./helpers/program.js";

const io = captureOutput();

const ids = (p: string) => p;
const found = (name: string) => `/usr/bin/${name}`;

function detect(argv1: string, extra: Partial<Parameters<typeof detectInstall>[0]> = {}) {
  return detectInstall({
    argv1,
    realpath: ids,
    npmRootGlobal: () => "/usr/local/lib/node_modules",
    env: {},
    exec: fakeExec({ which: found }),
    ...extra,
  });
}

describe("detectInstall", () => {
  test.each([
    [
      "/usr/local/lib/node_modules/@tavily/cli/dist/cli.js",
      "npm",
      ["/usr/bin/npm", "install", "-g", "@tavily/cli@latest"],
    ],
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
    const info = detect(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@tavily\\cli\\dist\\cli.js",
      {
        npmRootGlobal: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules",
        exec: fakeExec({ which: () => "C:\\Program Files\\nodejs\\npm.cmd" }),
      },
    );
    expect(info.method).toBe("npm");
    expect(info.command).toEqual([
      "C:\\Program Files\\nodejs\\npm.cmd",
      "install",
      "-g",
      "@tavily/cli@latest",
    ]);
  });

  test("npm root -g runs the resolved npm with a short timeout", () => {
    const exec = fakeExec({
      which: found,
      run: () => ({ stdout: "/usr/local/lib/node_modules\n" }),
    });
    expect(npmRootGlobalDefault({ exec })).toBe("/usr/local/lib/node_modules");
    expect(exec.calls).toEqual([
      { bin: "/usr/bin/npm", args: ["root", "-g"], opts: { timeoutMs: 15_000 } },
    ]);
    const failing = fakeExec({ which: found, run: () => ({ ok: false, failure: "exit code 1" }) });
    expect(npmRootGlobalDefault({ exec: failing })).toBeNull();
  });

  test("PNPM_HOME marks a pnpm install", () => {
    const info = detect("/custom/pnpmhome/global/5/node_modules/@tavily/cli/dist/cli.js", {
      env: { PNPM_HOME: "/custom/pnpmhome" },
      npmRootGlobal: () => null,
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
    expect(detect("/work/tavily-cli/dist/cli.js")).toEqual({
      method: "source",
      command: null,
      blockedReason:
        "This is a source or direct-URL installation. Update it from its original source.",
    });
  });

  test("an npm link symlink is a source install", () => {
    const info = detect("/usr/local/lib/node_modules/@tavily/cli/dist/cli.js", {
      realpath: () =>
        "/usr/local/lib/node_modules/@tavily/cli/dist/cli.js".replace(
          "/usr/local/lib/node_modules/@tavily/cli",
          "/work/tavily-cli",
        ),
    });
    expect(info.method).toBe("source");
  });

  test("an unrecognised node_modules location is unknown and blocked", () => {
    const info = detect("/opt/app/node_modules/@tavily/cli/dist/cli.js", {
      npmRootGlobal: () => null,
    });
    expect(info.method).toBe("unknown");
    expect(info.command).toBeNull();
    expect(info.blockedReason).toContain("Could not determine how Tavily CLI was installed");
  });

  test("a missing manager binary blocks the update", () => {
    const info = detect("/usr/local/lib/node_modules/@tavily/cli/dist/cli.js", {
      exec: fakeExec({ which: () => null }),
    });
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

const NPM = {
  method: "npm" as const,
  command: ["/usr/bin/npm", "install", "-g", "@tavily/cli@latest"],
  blockedReason: null,
};
const BLOCKED_SOURCE = {
  method: "source" as const,
  command: null,
  blockedReason: "This is a source or direct-URL installation. Update it from its original source.",
};

const runUpdate = (argv: string[], deps: UpdateDeps) =>
  runProgram(argv, undefined, { actions: { update: (o, c) => run(o, c, deps) } });

const neverRun = fakeExec({
  run: () => {
    throw new Error("must not run");
  },
});

const base = (over: Partial<UpdateDeps> = {}): UpdateDeps => ({
  currentVersion: "1.0.0",
  fetchImpl: jsonReply({ version: "1.1.0" }),
  detectInstall: () => NPM,
  argv1: "/x/cli.js",
  realpath: ids,
  exec: neverRun,
  ...over,
});

/** npm succeeds; the re-read `--version` prints the given installed version. */
const upgradeTo = (installed: string, npmStdout = "") =>
  fakeExec({
    run: (bin) =>
      bin === process.execPath ? { stdout: `tavily-cli ${installed}\n` } : { stdout: npmStdout },
  });

const failedRun = (failure: string) => fakeExec({ run: () => ({ ok: false, failure }) });

describe("update command", () => {
  test("--check --json is read-only", async () => {
    expect(await runUpdate(["--json", "update", "--check"], base())).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: true,
      current_version: "1.0.0",
      latest_version: "1.1.0",
      update_available: true,
      install_method: "npm",
      can_update: true,
      blocked_reason: null,
      updated: false,
    });
  });

  test("--check reports a source install as blocked", async () => {
    await runUpdate(["--json", "update", "--check"], base({ detectInstall: () => BLOCKED_SOURCE }));
    const out = JSON.parse(io.stdout());
    expect(out.can_update).toBe(false);
    expect(out.blocked_reason).toBe(BLOCKED_SOURCE.blockedReason);
  });

  test("--check human output recommends tvly update only when allowed", async () => {
    await runUpdate(["update", "--check"], base());
    expect(io.stdout()).toContain("Tavily CLI update available: 1.0.0 -> 1.1.0");
    expect(io.stdout()).toContain("Run `tvly update` to install it.");
  });

  test("--check human output does not recommend a blocked self-update", async () => {
    await runUpdate(["update", "--check"], base({ detectInstall: () => BLOCKED_SOURCE }));
    expect(io.stdout()).toContain("Self-update unavailable:");
    expect(io.stdout()).not.toContain("Run `tvly update`");
  });

  test("does nothing when current", async () => {
    expect(await runUpdate(["--json", "update"], base({ currentVersion: "1.1.0" }))).toBe(0);
    expect(JSON.parse(io.stdout()).update_available).toBe(false);
  });

  test("runs the detected manager and verifies the installed version", async () => {
    const exec = upgradeTo("1.1.0", "updated");
    expect(await runUpdate(["--json", "update"], base({ exec }))).toBe(0);
    expect(exec.calls).toEqual([
      {
        bin: "/usr/bin/npm",
        args: ["install", "-g", "@tavily/cli@latest"],
        opts: { timeoutMs: 300_000 },
      },
      { bin: process.execPath, args: ["/x/cli.js", "--version"], opts: { timeoutMs: 30_000 } },
    ]);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: true,
      current_version: "1.1.0",
      latest_version: "1.1.0",
      update_available: false,
      install_method: "npm",
      can_update: true,
      blocked_reason: null,
      updated: true,
    });
  });

  test("control bytes in the re-read version are stripped before it is parsed or printed", async () => {
    const exec = fakeExec({
      run: (bin) => (bin === process.execPath ? { stdout: "tavily-cli 1.1.0\x07\n" } : undefined),
    });
    expect(await runUpdate(["--json", "update"], base({ exec }))).toBe(0);
    expect(JSON.parse(io.stdout()).current_version).toBe("1.1.0");
  });

  test("human flow prints progress and result", async () => {
    await runUpdate(["update"], base({ exec: upgradeTo("1.1.0") }));
    expect(io.stdout()).toContain("Updating Tavily CLI via npm...");
    expect(io.stdout()).toContain("Updated Tavily CLI: 1.0.0 -> 1.1.0");
  });

  test("refuses a blocked install with stage install_method", async () => {
    expect(
      await runUpdate(["--json", "update"], base({ detectInstall: () => BLOCKED_SOURCE })),
    ).toBe(1);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: false,
      error: { stage: "install_method", message: BLOCKED_SOURCE.blockedReason },
    });
  });

  test("update failure is the shared failure summary, structured and sanitized", async () => {
    const exec = failedRun("failed\x1b[2J");
    expect(await runUpdate(["--json", "update"], base({ exec }))).toBe(1);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: false,
      error: { stage: "update", message: "failed[2J" },
    });
    expect(await runUpdate(["--json", "update"], base({ exec: failedRun("exit code 2") }))).toBe(1);
    expect(JSON.parse(io.stdout().trim().split("\n").at(-1) ?? "").error.message).toBe(
      "exit code 2",
    );
  });

  test("a failure to start the manager is reported at the update stage", async () => {
    const exec = failedRun("spawn npm ENOENT");
    expect(await runUpdate(["--json", "update"], base({ exec }))).toBe(1);
    const out = JSON.parse(io.stdout());
    expect(out.error.stage).toBe("update");
    expect(out.error.message).toContain("ENOENT");
  });

  test("verifies the manager changed the version", async () => {
    expect(await runUpdate(["--json", "update"], base({ exec: upgradeTo("1.0.0") }))).toBe(1);
    const out = JSON.parse(io.stdout());
    expect(out.error.stage).toBe("verify");
    expect(out.error.message).toContain("may be pinned");
  });

  test("surfaces the manager hint when a successful upgrade is pinned", async () => {
    const exec = upgradeTo("1.0.0", "Nothing to upgrade\nhint: pin set in .npmrc\n");
    await runUpdate(["--json", "update"], base({ exec }));
    expect(JSON.parse(io.stdout()).error.message).toContain(
      "Package manager reported: hint: pin set in .npmrc",
    );
  });

  test("does not echo non-hint output after a successful no-op", async () => {
    const exec = upgradeTo(
      "1.0.0",
      "Registry: https://user:secret@example.com/\nNothing to upgrade\n",
    );
    await runUpdate(["--json", "update"], base({ exec }));
    expect(io.stdout()).not.toContain("secret");
  });

  test("check failure is structured and exits 4", async () => {
    const fetchImpl = jsonReply({}, 503);
    expect(await runUpdate(["--json", "update", "--check"], base({ fetchImpl }))).toBe(4);
    expect(JSON.parse(io.stdout())).toEqual({
      ok: false,
      error: { stage: "check", message: "Could not check npm for Tavily CLI updates." },
    });
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await runUpdate(["--json", "update", "--check"], base({ fetchImpl: down }))).toBe(4);
  });

  test("install detection failure is not reported as a network error", async () => {
    const detect = () => {
      throw new Error("Package metadata unavailable");
    };
    expect(await runUpdate(["--json", "update", "--check"], base({ detectInstall: detect }))).toBe(
      1,
    );
    expect(JSON.parse(io.stdout()).error).toEqual({
      stage: "install_method",
      message: "Package metadata unavailable",
    });
  });

  test("human failure goes to stderr", async () => {
    await runUpdate(["update"], base({ exec: failedRun("boom") }));
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

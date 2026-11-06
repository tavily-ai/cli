import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, test } from "vitest";

const INSTALL_SCRIPT = path.resolve(import.meta.dirname, "..", "install.sh");
const HAS_SCRIPT_CMD = process.platform !== "win32";

const tempDirs: string[] = [];

// Tests run concurrently, so sandboxes are removed once at the end rather than after each test.
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  bin: string;
  env: Record<string, string>;
  calls: () => string[];
}

function writeBin(box: Sandbox, name: string, body: string): void {
  const file = path.join(box.bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** A fake that logs its argv, then runs `body` for canned output and exit codes. */
function writeLogged(box: Sandbox, name: string, body = "exit 0"): void {
  writeBin(box, name, `printf '${name} %s\\n' "$*" >> "$TVLY_INSTALL_TEST_LOG"\n${body}`);
}

interface Options {
  node?: string | null;
  initExit?: number;
  managers?: string[];
  owner?: string | null;
  listOutput?: string;
  installExit?: number;
  tvlyVersion?: string;
}

function sandbox(options: Options = {}): Sandbox {
  const {
    node = "22.3.0",
    initExit = 0,
    managers = ["npm"],
    owner = null,
    listOutput,
    installExit = 0,
    tvlyVersion = "0.3.0",
  } = options;
  const dir = mkdtempSync(path.join(tmpdir(), "tvly-install-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "calls.log");
  const box: Sandbox = {
    bin,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      TVLY_INSTALL_TEST_LOG: log,
      TVLY_INIT_EXIT: String(initExit),
      CI: "",
      SSH_CONNECTION: "",
      SSH_TTY: "",
    },
    calls: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
  if (node !== null) writeBin(box, "node", `printf '${node}\\n'`);
  for (const manager of managers) {
    // Only the owning manager reports the package from its list command.
    const report =
      manager === owner
        ? 'printf "@tavily/cli@0.3.0\\n"'
        : listOutput
          ? `printf "${listOutput}\\n"`
          : ":";
    writeLogged(
      box,
      manager,
      `case "$*" in "ls "*|"list "*|"pm ls"*|"global list"*) ${report} ;; esac\ncase "$*" in *install*|*" add "*) exit ${installExit} ;; esac\nexit 0`,
    );
  }
  writeLogged(
    box,
    "tvly",
    `if [ "$1" = "--version" ]; then printf 'tavily-cli ${tvlyVersion}\\n'; exit 0; fi
if [ "$1" = "init" ] && [ "$2" != "--help" ]; then exit "$TVLY_INIT_EXIT"; fi
exit 0`,
  );
  return box;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const runPlain = (box: Sandbox) => run("sh", [INSTALL_SCRIPT], box.env);

/** Run under a pseudo terminal via script(1); BSD and util-linux differ in flags. */
async function runWithTerminal(box: Sandbox, pipeScript = false) {
  const inner = pipeScript
    ? ["sh", "-c", 'cat "$1" | sh', "sh", INSTALL_SCRIPT]
    : ["sh", INSTALL_SCRIPT];
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", ...inner]
      : ["-qec", inner.map((part) => `'${part}'`).join(" "), "/dev/null"];
  const result = await run("script", args, { ...box.env, DISPLAY: ":0" });
  return { status: result.status, output: result.stdout };
}

const FRESH_NPM_CALLS = [
  "npm ls -g --depth=0 @tavily/cli",
  "npm install -g @tavily/cli",
  "tvly --version",
  "npm ls -g --depth=0 @tavily/cli",
];

describe.concurrent("install.sh", () => {
  test("test_noninteractive_install_prints_init_without_running_it", async ({ expect }) => {
    const box = sandbox();
    const result = await runPlain(box);

    expect(result.status).toBe(0);
    expect(box.calls()).toEqual(FRESH_NPM_CALLS);
    expect(result.stdout).toContain("Success! tavily-cli 0.3.0 is installed.");
    expect(result.stdout).not.toContain("tavily-cli tavily-cli");
    expect(result.stdout).toContain("tvly init");
  });

  describe.skipIf(!HAS_SCRIPT_CMD)("with a terminal", () => {
    test("test_fresh_interactive_install_hands_off_to_init", async ({ expect }) => {
      const box = sandbox();
      const { status, output } = await runWithTerminal(box, true);

      expect(status).toBe(0);
      expect(box.calls()).toEqual([...FRESH_NPM_CALLS, "tvly init --help", "tvly init"]);
      expect(output).toContain("Starting guided Tavily setup");
      expect(output).not.toContain("guided authentication and skill setup");
    });

    test("test_init_failure_does_not_fail_successful_install", async ({ expect }) => {
      const box = sandbox({ initExit: 3 });
      const { status, output } = await runWithTerminal(box);

      expect(status).toBe(0);
      expect(output).toContain("Guided setup did not complete");
      expect(output).toContain("tvly init");
    });

    test("an upgrade of an existing install does not run init", async ({ expect }) => {
      const box = sandbox({ owner: "npm" });
      const { status, output } = await runWithTerminal(box);

      expect(status).toBe(0);
      expect(box.calls()).toEqual([
        "npm ls -g --depth=0 @tavily/cli",
        "npm install -g @tavily/cli@latest",
        "tvly --version",
        "npm ls -g --depth=0 @tavily/cli",
      ]);
      expect(output).not.toContain("Starting guided Tavily setup");
    });

    test.for(["CI", "SSH_CONNECTION", "SSH_TTY"])(
      "test_automation_and_remote_sessions_do_not_run_init (%s)",
      async (variable, { expect }) => {
        const box = sandbox();
        box.env[variable] = "set";
        const { status, output } = await runWithTerminal(box);

        expect(status).toBe(0);
        expect(box.calls()).toEqual(FRESH_NPM_CALLS);
        expect(output).not.toContain("Starting guided Tavily setup");
        expect(output).toContain("tvly init");
      },
    );
  });

  test("an older tvly earlier on PATH is reported as shadowing the npm install", async ({
    expect,
  }) => {
    const box = sandbox({ owner: "npm", tvlyVersion: "0.2.1" });
    const result = await runPlain(box);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "warning: 'tvly --version' reports 0.2.1, but @tavily/cli 0.3.0 was just installed.",
    );
    expect(result.stdout).toContain(`An older tvly earlier on PATH (${box.bin}/tvly) is shadowing`);
    expect(result.stdout).toContain("uv tool uninstall tavily-cli");
    expect(result.stdout).toContain("pipx uninstall tavily-cli");
  });

  test("a failed fresh install exits non-zero and never runs init", async ({ expect }) => {
    const box = sandbox({ installExit: 1 });
    const result = await runPlain(box);

    expect(result.status).not.toBe(0);
    expect(box.calls()).toEqual(["npm ls -g --depth=0 @tavily/cli", "npm install -g @tavily/cli"]);
  });

  test("existing pnpm install wins over available npm", async ({ expect }) => {
    const box = sandbox({ managers: ["npm", "pnpm"], owner: "pnpm" });
    const result = await runPlain(box);

    expect(result.status).toBe(0);
    const calls = box.calls();
    expect(calls).toContain("pnpm add -g @tavily/cli@latest");
    expect(calls.some((call) => call.startsWith("npm install"))).toBe(false);
  });

  test("existing yarn install upgrades via yarn global add", async ({ expect }) => {
    const box = sandbox({ managers: ["yarn"], owner: "yarn" });
    const result = await runPlain(box);

    expect(result.status).toBe(0);
    expect(box.calls()).toEqual([
      "yarn global list",
      "yarn global add @tavily/cli@latest",
      "tvly --version",
      "yarn global list",
    ]);
  });

  test("a sibling package name does not count as an existing install", async ({ expect }) => {
    const box = sandbox({
      managers: ["yarn"],
      listOutput: 'info \\"@tavily/cli-extras@1.0.0\\" has binaries',
    });
    const result = await runPlain(box);

    expect(result.status).toBe(0);
    expect(box.calls()).toEqual([
      "yarn global list",
      "yarn global add @tavily/cli",
      "tvly --version",
      "yarn global list",
    ]);
  });

  test("fresh install uses the first manager on PATH", async ({ expect }) => {
    const box = sandbox({ managers: ["bun"] });
    const result = await runPlain(box);

    expect(result.status).toBe(0);
    expect(box.calls()).toEqual([
      "bun pm ls -g",
      "bun add -g @tavily/cli",
      "tvly --version",
      "bun pm ls -g",
    ]);
  });

  test("no node prints the nodejs.org link and exits 1", async ({ expect }) => {
    const box = sandbox({ node: null });
    const result = await runPlain(box);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: Node.js 20.1+ is required but not found.");
    expect(result.stderr).toContain("https://nodejs.org/");
    expect(box.calls()).toEqual([]);
  });

  test("node 20.0 is rejected and 20.1 accepted", async ({ expect }) => {
    const old = await runPlain(sandbox({ node: "20.0.0" }));
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("Node.js 20.1+ is required");
    expect((await runPlain(sandbox({ node: "20.1.0" }))).status).toBe(0);
  });
});

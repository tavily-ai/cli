/**
 * Contract test: the TypeScript CLI must print what the Python CLI (tavily-cli 0.2.1) printed.
 *
 * tests/helpers/record-python.sh ran the Python CLI once per case in
 * tests/fixtures/contract/cases.json, with and without --json, against
 * tests/helpers/fixture-server.ts serving tests/fixtures/contract/api.json, and committed its stdout
 * and exit code as <case>-<json|plain>.python.{stdout,exit}. This test replays dist/cli.js live
 * against the same server in the same kind of environment (fresh HOME with a config file holding
 * tvly-fixture-key, no TAVILY_* variables except TAVILY_API_BASE_URL, a stub `tvly` on PATH for
 * `init`'s check) and compares.
 *
 * Comparison rules:
 * - Both outputs are normalized first: each CLI's own version becomes <version>, and the temp HOME
 *   (/tmp/tvly-XXXXXX) becomes $HOME.
 * - --json cases compare parsed objects. Byte equality is not asserted: Python prints `1.0` where
 *   JS prints `1`, and key order and indentation differ between the two (accepted).
 * - Plain cases (stdout piped, no --json) compare stdout text exactly. Plain output never prints
 *   response_time, and the fixture uses non-integer response times anyway.
 * - Exit codes must match.
 * - update --check: the Python run queried PyPI (latest was 0.2.1, its own version); the TypeScript
 *   run's hard-coded npm registry request is redirected by tests/helpers/fetch-redirect.mjs to
 *   the fixture server, which answers with the TypeScript CLI's own version, so both are "up to
 *   date". install_method and blocked_reason describe the installation (uvx vs. a checkout) and are
 *   compared by type only; every other key, the key set, and the plain text are compared.
 *
 * Accepted differences that are not cases here: `search --help` text, and the exit codes of keyed
 * 429/432 responses.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { type Routes, startFixtureServer } from "./helpers/fixture-server.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/contract/", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REDIRECT = fileURLToPath(new URL("./helpers/fetch-redirect.mjs", import.meta.url));
const PYTHON_VERSION = "0.2.1";
const HOME_PATTERN = /\/tmp\/tvly-[A-Za-z0-9]{6}/g;
const INSTALL_SPECIFIC = ["install_method", "blocked_reason"];

const cases = JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8")) as Record<
  string,
  string[]
>;
const routes = JSON.parse(readFileSync(join(FIXTURES, "api.json"), "utf8")) as Routes;

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let binDir: string;

beforeAll(async () => {
  server = await startFixtureServer({
    ...routes,
    "GET /@tavily/cli/latest": { name: "@tavily/cli", version: VERSION },
  });
  binDir = mkdtempSync(join(tmpdir(), "tvly-contract-bin-"));
  writeFileSync(join(binDir, "tvly"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "tvly"), 0o755);
});

afterAll(async () => {
  await server.close();
  rmSync(binDir, { recursive: true, force: true });
});

function normalize(text: string, version: string): string {
  return text.replaceAll(version, "<version>").replace(HOME_PATTERN, "$HOME");
}

function runTs(args: string[]): Promise<{ stdout: string; code: number }> {
  // Short HOME under /tmp, as in the recording, so a Rich-wrapped path cannot differ by length.
  const home = mkdtempSync("/tmp/tvly-");
  mkdirSync(join(home, ".tavily"));
  writeFileSync(join(home, ".tavily", "config.json"), '{"api_key": "tvly-fixture-key"}\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", REDIRECT, CLI, ...args], {
      env: {
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        LANG: "en_US.UTF-8",
        TAVILY_API_BASE_URL: server.url,
        TVLY_FIXTURE_URL: server.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ stdout, code: code ?? 1 });
    });
  });
}

function recorded(name: string): { stdout: string; code: number } {
  return {
    stdout: readFileSync(join(FIXTURES, `${name}.python.stdout`), "utf8"),
    code: Number(readFileSync(join(FIXTURES, `${name}.python.exit`), "utf8").trim()),
  };
}

function withoutInstallKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !INSTALL_SPECIFIC.includes(k)));
}

describe("JSON and plain output match the Python CLI", () => {
  for (const [base, args] of Object.entries(cases)) {
    it(`${base} --json`, async () => {
      const py = recorded(`${base}-json`);
      const ts = await runTs([...args, "--json"]);
      expect(ts.code).toBe(py.code);
      const expected = JSON.parse(normalize(py.stdout, PYTHON_VERSION));
      const actual = JSON.parse(normalize(ts.stdout, VERSION));
      if (base === "update-check") {
        expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
        expect(withoutInstallKeys(actual)).toEqual(withoutInstallKeys(expected));
        for (const key of INSTALL_SPECIFIC) {
          expect(typeof actual[key]).toBe(typeof expected[key]);
        }
      } else if (base === "init") {
        // `install` and `workflows` are new in the TypeScript CLI: the global-install and
        // official-workflows steps.
        const { install, workflows, ...rest } = actual;
        expect(install).toEqual({
          global: false,
          manager: null,
          on_path: true,
          path_updated: false,
        });
        expect(workflows).toEqual({
          source: "tavily-ai/official-workflows",
          agents: [],
          restart_required: false,
          skipped: true,
        });
        expect(rest).toEqual(expected);
      } else {
        expect(actual).toEqual(expected);
      }
    });

    it(`${base} (plain)`, async () => {
      const py = recorded(`${base}-plain`);
      const ts = await runTs(args);
      expect(ts.code).toBe(py.code);
      // The workflows line is new in the TypeScript CLI's init summary.
      const stdout = base === "init" ? ts.stdout.replace(/.*Workflows skipped.*\n/, "") : ts.stdout;
      expect(normalize(stdout, VERSION)).toBe(normalize(py.stdout, PYTHON_VERSION));
    });
  }
});

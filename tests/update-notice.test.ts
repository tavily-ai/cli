import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startUpdateCheck, type UpdateNoticeDeps } from "../src/core/update-notice.js";
import { captureOutput } from "./helpers/capture.js";

const io = captureOutput();
afterEach(() => vi.useRealTimers());

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const NOTICE = "Tavily CLI update available: 1.0.0 -> 1.1.0. Run `tvly update`.";

const reply = (version: string) =>
  vi.fn(async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch;
const neverFetch = vi.fn(() => {
  throw new Error("must not fetch");
}) as unknown as typeof fetch;

function setup(over: Partial<UpdateNoticeDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "tvly-notice-"));
  const deps: UpdateNoticeDeps = {
    home,
    env: {},
    argv: ["node", "cli.js", "search", "q"],
    now: () => NOW,
    stderrIsTTY: true,
    currentVersion: "1.0.0",
    installMethod: () => "npm",
    fetchImpl: neverFetch,
    ...over,
  };
  const file = join(home, ".tavily", "update-check.json");
  const state = () => JSON.parse(readFileSync(file, "utf8"));
  const seed = (checkedAt: number, latest: string | null) => {
    mkdirSync(join(home, ".tavily"));
    writeFileSync(file, JSON.stringify({ checked_at: checkedAt, latest }));
  };
  return { deps, state, seed };
}

test("a fresh state file with a newer version prints the notice without fetching", async () => {
  const { deps, seed } = setup();
  seed(NOW - HOUR, "1.1.0");
  await startUpdateCheck(deps)();
  expect(io.stderr()).toBe(`\n${NOTICE}\n`);
  expect(io.stdout()).toBe("");
});

test("a fresh state file with the current version is silent", async () => {
  const { deps, seed } = setup();
  seed(NOW - HOUR, "1.0.0");
  await startUpdateCheck(deps)();
  expect(io.stderr()).toBe("");
});

test("a stale state file fetches, records the answer and prints when newer", async () => {
  const { deps, state, seed } = setup({ fetchImpl: reply("1.1.0") });
  seed(NOW - 25 * HOUR, "1.0.0");
  await startUpdateCheck(deps)();
  expect(state()).toEqual({ checked_at: NOW, latest: "1.1.0" });
  expect(io.stderr()).toContain(NOTICE);
});

test("a failed fetch records latest: null and is silent", async () => {
  const down = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
  const { deps, state } = setup({ fetchImpl: down });
  await startUpdateCheck(deps)();
  expect(state()).toEqual({ checked_at: NOW, latest: null });
  expect(io.stderr()).toBe("");
});

test("a fetch slower than the race is silent and does not block the exit", async () => {
  vi.useFakeTimers();
  const { deps, state } = setup({ fetchImpl: (() => new Promise(() => {})) as typeof fetch });
  const finish = startUpdateCheck(deps)();
  await vi.advanceTimersByTimeAsync(1500);
  await finish;
  expect(state()).toEqual({ checked_at: NOW, latest: null });
  expect(io.stderr()).toBe("");
});

test.each<[string, Partial<UpdateNoticeDeps>]>([
  ["CI", { env: { CI: "1" } }],
  ["NO_UPDATE_NOTIFIER", { env: { NO_UPDATE_NOTIFIER: "1" } }],
  ["stderr not a TTY", { stderrIsTTY: false }],
  ["--json", { argv: ["node", "cli.js", "search", "q", "--json"] }],
  ["the update command", { argv: ["node", "cli.js", "update"] }],
  ["an npx install", { installMethod: () => "npx" }],
])("skips under %s", async (_name, over) => {
  const fetchImpl = reply("1.1.0");
  const { deps } = setup({ ...over, fetchImpl });
  await startUpdateCheck(deps)();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(io.stderr()).toBe("");
});

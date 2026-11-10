import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startUpdateCheck } from "../src/core/update-notice.js";
import type { Host } from "../src/host.js";
import { VERSION } from "../src/version.js";
import { captureOutput } from "./helpers/capture.js";
import { fakeHost, NOW } from "./helpers/host.js";

const io = captureOutput();
afterEach(() => vi.useRealTimers());

const HOUR = 60 * 60 * 1000;
const NEWER = VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));
const NOTICE = `Tavily CLI update available: ${VERSION} -> ${NEWER}. Run \`tvly update\`.`;

const reply = (version: string) =>
  vi.fn(async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch;

function setup(over: Partial<Host> = {}) {
  const host = fakeHost({ argv: ["node", "cli.js", "search", "q"], stderrIsTTY: true, ...over });
  const file = join(host.home, ".tavily", "update-check.json");
  const state = () => JSON.parse(readFileSync(file, "utf8"));
  const seed = (checkedAt: number, latest: string | null) => {
    mkdirSync(join(host.home, ".tavily"));
    writeFileSync(file, JSON.stringify({ checked_at: checkedAt, latest }));
  };
  return { host, state, seed };
}

test("a fresh state file with a newer version prints the notice without fetching", async () => {
  const { host, seed } = setup();
  seed(NOW - HOUR, NEWER);
  await startUpdateCheck(host)();
  expect(io.stderr()).toBe(`\n${NOTICE}\n`);
  expect(io.stdout()).toBe("");
});

test("a fresh state file with the current version is silent", async () => {
  const { host, seed } = setup();
  seed(NOW - HOUR, VERSION);
  await startUpdateCheck(host)();
  expect(io.stderr()).toBe("");
});

test("a stale state file fetches, records the answer and prints when newer", async () => {
  const { host, state, seed } = setup({ fetch: reply(NEWER) });
  seed(NOW - 25 * HOUR, VERSION);
  await startUpdateCheck(host)();
  expect(state()).toEqual({ checked_at: NOW, latest: NEWER });
  expect(io.stderr()).toContain(NOTICE);
});

test("a failed fetch records latest: null and is silent", async () => {
  const down = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
  const { host, state } = setup({ fetch: down });
  await startUpdateCheck(host)();
  expect(state()).toEqual({ checked_at: NOW, latest: null });
  expect(io.stderr()).toBe("");
});

test("a fetch slower than the race is silent and does not block the exit", async () => {
  vi.useFakeTimers();
  const { host, state } = setup({ fetch: (() => new Promise(() => {})) as typeof fetch });
  const finish = startUpdateCheck(host)();
  await vi.advanceTimersByTimeAsync(1500);
  await finish;
  expect(state()).toEqual({ checked_at: NOW, latest: null });
  expect(io.stderr()).toBe("");
});

test("a fetch still pending at finish is aborted", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const hang = ((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise(() => {});
  }) as unknown as typeof fetch;
  const finish = startUpdateCheck(setup({ fetch: hang }).host)();
  await vi.advanceTimersByTimeAsync(1500);
  await finish;
  expect(signal?.aborted).toBe(true);
});

test.each<[string, Partial<Host>]>([
  ["CI", { env: { CI: "1" } }],
  ["NO_UPDATE_NOTIFIER", { env: { NO_UPDATE_NOTIFIER: "1" } }],
  ["stderr not a TTY", { stderrIsTTY: false }],
  ["--json", { argv: ["node", "cli.js", "search", "q", "--json"] }],
  ["the update command", { argv: ["node", "cli.js", "update"] }],
  ["an npx install", { argv: ["node", "/u/.npm/_npx/abc/node_modules/@tavily/cli/dist/cli.js"] }],
])("skips under %s", async (_name, over) => {
  const fetch = reply(NEWER);
  const { host } = setup({ ...over, fetch });
  await startUpdateCheck(host)();
  expect(fetch).not.toHaveBeenCalled();
  expect(host.exec).toMatchObject({ calls: [] });
  expect(io.stderr()).toBe("");
});

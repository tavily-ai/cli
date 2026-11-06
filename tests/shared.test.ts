import { TavilyKeylessLimitError, TavilyRequestError } from "@tavily/core";
import { Command } from "commander";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { handleOauthRefreshError } from "../src/commands/common.js";
import { addClientNameOption, addOutputOption, resolveJson } from "../src/commands/options.js";
import {
  handleApiError,
  handleKeylessCapHit,
  keylessCapError,
  printKeylessCapHit,
  readQueryArg,
  runWithApiErrors,
  splitCsv,
} from "../src/commands/shared.js";
import { authSource } from "../src/core/config.js";
import { ExitError, OAuthError } from "../src/errors.js";
import { resolveOutput } from "../src/ui/render/emit.js";

const ANSI = new RegExp(
  `${String.fromCharCode(27)}(\\[[0-9;]*m|\\]8;;[^${String.fromCharCode(27)}]*${String.fromCharCode(27)}\\\\)`,
  "g",
);
const strip = (s: string) => s.replace(ANSI, "");
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function exitCode(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
  throw new Error("did not exit");
}

const capError = () =>
  new TavilyKeylessLimitError({
    message: "Daily cap",
    capType: "daily",
    retryAfter: 3600,
    bonusEligible: false,
    continuationPaths: [{ type: "signup", url: "https://tavily.com/signup" }],
    window: "day",
  });

test("handleApiError JSON mode writes the error to stdout and exits 4", () => {
  expect(exitCode(() => handleApiError(new Error("boom"), true))).toBe(4);
  expect(JSON.parse(stdout.join(""))).toEqual({ error: "boom" });
  expect(stderr).toEqual([]);
});

test("handleApiError human mode prints to stderr and exits 4", () => {
  expect(exitCode(() => handleApiError(new Error("bo\x1b[2Jom"), false))).toBe(4);
  expect(strip(stderr.join(""))).toBe("  > Error: bo[2Jom\n");
  expect(stdout).toEqual([]);
});

test("limit statuses 429 and 432 print the upgrade block and exit 3", () => {
  for (const status of [429, 432]) {
    stderr = [];
    const e = new TavilyRequestError({
      status,
      body: null,
      message: "Plan limit",
      docs: "https://docs.tavily.com/x",
    });
    expect(exitCode(() => handleApiError(e, false))).toBe(3);
    expect(strip(stderr.join("")).split("\n")).toEqual([
      "",
      "  > Plan limit",
      "",
      "  Upgrade your plan at tavily.com",
      "  Docs: https://docs.tavily.com/x",
      "",
      "",
    ]);
  }
  const limit = new TavilyRequestError({ status: 432, body: null, message: "m" });
  expect(exitCode(() => handleApiError(limit, true))).toBe(3);
  expect(JSON.parse(stdout.join(""))).toEqual({ error: "m" });
});

test("keylessCapError maps SDK fields, including window, in the Python key order", () => {
  const payload = keylessCapError(capError());
  expect(Object.keys(payload)).toEqual([
    "code",
    "message",
    "window",
    "retry_after_seconds",
    "next_actions",
  ]);
  expect(payload).toEqual({
    code: "daily",
    message: "Daily cap",
    window: "day",
    retry_after_seconds: 3600,
    next_actions: [{ type: "signup", url: "https://tavily.com/signup" }],
  });
});

test("handleKeylessCapHit JSON and human modes exit 3", () => {
  expect(exitCode(() => handleKeylessCapHit(capError(), true))).toBe(3);
  expect(JSON.parse(stdout.join(""))).toEqual({ error: keylessCapError(capError()) });
  expect(exitCode(() => handleKeylessCapHit(capError(), false))).toBe(3);
  const text = strip(stderr.join(""));
  expect(text).toContain("  > Tavily rate limit reached.");
  expect(text).toContain("    Retry after: 1h (3600s)");
  expect(text).toContain("      - Sign up for a Tavily API key:  https://tavily.com/signup");
  expect(text).toContain("  Run tvly login to authenticate and remove this cap.");
});

test("printKeylessCapHit does not throw", () => {
  printKeylessCapHit(capError());
  expect(strip(stderr.join("")).startsWith("\n  > Tavily rate limit reached.\n")).toBe(true);
});

test("handleOauthRefreshError", () => {
  expect(exitCode(() => handleOauthRefreshError(new OAuthError("expired"), true))).toBe(3);
  expect(JSON.parse(stdout.join(""))).toEqual({
    error: { code: "oauth_refresh_failed", message: "expired" },
  });
  expect(exitCode(() => handleOauthRefreshError(new OAuthError("expired"), false))).toBe(3);
  expect(strip(stderr.join(""))).toBe("  > OAuth refresh failed: expired\n");
});

test("runWithApiErrors routes keyless, OAuth, other, and passes results and ExitError through", async () => {
  expect(await runWithApiErrors(true, async () => 5)).toBe(5);
  const run = async (e: unknown) => {
    try {
      await runWithApiErrors(true, async () => {
        throw e;
      });
    } catch (x) {
      return (x as ExitError).code;
    }
    return -1;
  };
  expect(await run(capError())).toBe(3);
  expect(JSON.parse(stdout.at(-1) ?? "").error.code).toBe("daily");
  expect(await run(new OAuthError("x"))).toBe(3);
  expect(JSON.parse(stdout.at(-1) ?? "").error.code).toBe("oauth_refresh_failed");
  expect(await run(new Error("y"))).toBe(4);
  expect(await run(new ExitError(7))).toBe(7);
});

function parse(args: string[]) {
  const cmd = addOutputOption(addClientNameOption(new Command("x")));
  cmd.parse(args, { from: "user" });
  return cmd.opts<{ clientName?: string; output?: string }>();
}

test("--client-name beats TAVILY_CLIENT_NAME; env is the fallback; neither is undefined", () => {
  vi.stubEnv("TAVILY_CLIENT_NAME", "env");
  expect(parse(["--client-name", "flag"]).clientName).toBe("flag");
  expect(parse([]).clientName).toBe("env");
  vi.stubEnv("TAVILY_CLIENT_NAME", undefined);
  expect(parse([]).clientName).toBeUndefined();
});

test("-o yields undefined, empty string when bare, or the path", () => {
  expect(parse([]).output).toBeUndefined();
  expect(parse(["-o"]).output).toBe("");
  expect(parse(["--output"]).output).toBe("");
  expect(parse(["-o", "f.json"]).output).toBe("f.json");
});

test("resolveJson reads the global flag from a parent", () => {
  const root = new Command("root").option("--json");
  const sub = root.command("sub").action(() => {});
  root.parse(["--json", "sub"], { from: "user" });
  expect(resolveJson(sub)).toBe(true);
  const root2 = new Command("root").option("--json");
  const sub2 = root2.command("sub").action(() => {});
  root2.parse(["sub"], { from: "user" });
  expect(resolveJson(sub2)).toBe(false);
});

test("splitCsv", () => {
  expect(splitCsv(undefined)).toBeUndefined();
  expect(splitCsv("")).toBeUndefined();
  expect(splitCsv("a.com, b.com")).toEqual(["a.com", "b.com"]);
});

test("readQueryArg (stdin cases are in research.test.ts)", () => {
  const cmd = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  expect(readQueryArg(" hello ", cmd)).toBe("hello");
  for (const q of [undefined, "", "  "]) {
    expect(() => readQueryArg(q, cmd)).toThrow(
      "error: QUERY is required. Pass a query string or use '-' to read from stdin.",
    );
  }
});

test("resolveOutput", () => {
  const a = resolveOutput("", "search", "Rust 2024 edition");
  const b = resolveOutput("", "search", "Rust 2024 edition");
  expect(a).toMatch(/^\.tavily\/search-rust-2024-edition-\d{6}-[0-9a-f]{6}\.json$/);
  expect(a).not.toBe(b);
  expect(resolveOutput("out.json", "search", "x")).toBe("out.json");
  expect(resolveOutput(undefined, "search", "x")).toBeUndefined();
  expect(resolveOutput("", "extract", "!!!")).toMatch(/^\.tavily\/extract-result-\d{6}-/);
  expect(resolveOutput("", "x", "a".repeat(60))).toContain(`x-${"a".repeat(40)}-`);
  expect(resolveOutput("", "c", "l", new Date(2026, 0, 2, 3, 4, 5), () => "abcdef")).toBe(
    ".tavily/c-l-030405-abcdef.json",
  );
});

test("authSource", () => {
  expect(authSource("tvly-x", { TAVILY_API_KEY: "tvly-x" })).toBe("TAVILY_API_KEY");
  expect(authSource("tvly-x", {})).toBe("API key");
  const jwt = `a.${Buffer.from("{}").toString("base64url")}.c`;
  expect(authSource(jwt, {})).toBe("OAuth (tvly login)");
});

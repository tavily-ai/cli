import path from "node:path";
import {
  keylessLimitErrorFromEnvelope,
  type TavilyContinuationPath,
  TavilyKeylessLimitError,
  TavilyRequestError,
} from "@tavily/core";
import { Command } from "commander";
import { afterEach, describe, expect, test, vi } from "vitest";
import { handleOauthRefreshError } from "../src/commands/common.js";
import { addClientNameOption, addOutputOption } from "../src/commands/options.js";
import { handleApiError, readQueryArg, runWithApiErrors } from "../src/commands/shared.js";
import { authSource } from "../src/core/config.js";
import { ExitError, OAuthError } from "../src/errors.js";
import {
  formatKeylessEnvelopeForTerminal,
  formatSeconds,
  keylessCapError,
} from "../src/ui/keyless.js";
import { resolveOutput } from "../src/ui/render/emit.js";
import { captureOutput, visible } from "./helpers/capture.js";

const io = captureOutput();
afterEach(() => vi.unstubAllEnvs());

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

test("handleApiError human mode prints to stderr and exits 4", () => {
  expect(exitCode(() => handleApiError(new Error("bo\x1b[2Jom"), false))).toBe(4);
  expect(visible(io.stderr())).toBe("  > Error: bo[2Jom\n");
  expect(io.stdout()).toBe("");
});

test("limit statuses 429 and 432 print the upgrade block and exit 3", () => {
  for (const status of [429, 432]) {
    const before = io.stderr().length;
    const e = new TavilyRequestError({
      status,
      body: null,
      message: "Plan limit",
      docs: "https://docs.tavily.com/x",
    });
    expect(exitCode(() => handleApiError(e, false))).toBe(3);
    expect(visible(io.stderr().slice(before)).split("\n")).toEqual([
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
  expect(JSON.parse(io.stdout())).toEqual({ error: "m" });
});

test("auth statuses 401 and 403 keep the API message and exit 3", () => {
  const message = "Unauthorized: missing or invalid API key.";
  for (const status of [401, 403]) {
    const e = new TavilyRequestError({ status, body: null, message });
    const before = io.stderr().length;
    expect(exitCode(() => handleApiError(e, false))).toBe(3);
    expect(visible(io.stderr().slice(before))).toBe(`  > Error: ${message}\n`);
  }
  const e = new TavilyRequestError({ status: 401, body: null, message });
  expect(exitCode(() => handleApiError(e, true))).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual({ error: message });
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

test("a keyless cap hit in runWithApiErrors exits 3 in JSON and human modes", async () => {
  const hit = (json: boolean) =>
    runWithApiErrors(json, async () => {
      throw capError();
    }).catch((e: ExitError) => e.code);
  expect(await hit(true)).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual({ error: keylessCapError(capError()) });
  expect(await hit(false)).toBe(3);
  const text = visible(io.stderr());
  expect(text).toContain("  > Tavily rate limit reached.");
  expect(text).toContain("    Retry after: 1h (3600s)");
  expect(text).toContain("      - Sign up for a Tavily API key:  https://tavily.com/signup");
  expect(text).toContain("  Run tvly login to authenticate and remove this cap.");
});

test("handleOauthRefreshError", () => {
  expect(exitCode(() => handleOauthRefreshError(new OAuthError("expired"), true))).toBe(3);
  expect(JSON.parse(io.stdout())).toEqual({
    error: { code: "oauth_refresh_failed", message: "expired" },
  });
  expect(exitCode(() => handleOauthRefreshError(new OAuthError("expired"), false))).toBe(3);
  expect(visible(io.stderr())).toBe("  > OAuth refresh failed: expired\n");
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
  const resolve = (...args: Parameters<typeof resolveOutput>) =>
    resolveOutput(...args)
      ?.split(path.sep)
      .join("/");
  const a = resolve("", "search", "Rust 2024 edition");
  const b = resolve("", "search", "Rust 2024 edition");
  expect(a).toMatch(/^\.tavily\/search-rust-2024-edition-\d{6}-[0-9a-f]{6}\.json$/);
  expect(a).not.toBe(b);
  expect(resolve("out.json", "search", "x")).toBe("out.json");
  expect(resolve(undefined, "search", "x")).toBeUndefined();
  expect(resolve("", "extract", "!!!")).toMatch(/^\.tavily\/extract-result-\d{6}-/);
  expect(resolve("", "x", "a".repeat(60))).toContain(`x-${"a".repeat(40)}-`);
  expect(resolve("", "c", "l", new Date(2026, 0, 2, 3, 4, 5), () => "abcdef")).toBe(
    ".tavily/c-l-030405-abcdef.json",
  );
});

test("authSource", () => {
  expect(authSource("tvly-x", { TAVILY_API_KEY: "tvly-x" })).toBe("TAVILY_API_KEY");
  expect(authSource("tvly-x", {})).toBe("API key");
  const jwt = `a.${Buffer.from("{}").toString("base64url")}.c`;
  expect(authSource(jwt, {})).toBe("OAuth (tvly login)");
});

describe("keyless cap rendering", () => {
  const capHit = (fields: {
    message?: string;
    retryAfter?: number | null;
    continuationPaths?: TavilyContinuationPath[];
  }) =>
    new TavilyKeylessLimitError({
      message: "",
      capType: "hourly",
      retryAfter: null,
      bonusEligible: false,
      continuationPaths: [],
      ...fields,
    });

  test("formatSeconds", () => {
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(90)).toBe("1m 30s");
    expect(formatSeconds(120)).toBe("2m");
    expect(formatSeconds(3600)).toBe("1h");
    expect(formatSeconds(5400)).toBe("1h 30m");
    expect(formatSeconds(90000)).toBe("1d 1h");
    expect(formatSeconds(86400)).toBe("1d");
  });

  test("envelope with signup, payment, and bonus actions", () => {
    const block = formatKeylessEnvelopeForTerminal(
      capHit({
        message: "  Hourly cap reached.  ",
        retryAfter: 90,
        continuationPaths: [
          { type: "signup", url: "https://app.tavily.com" },
          { type: "agentic_payment", scheme: "x402", details: "pay here" },
          {
            type: "bonus_credits",
            eligible: true,
            credits_on_completion: 50,
            questions: ["Who are you?", "What do you build?"],
            endpoint: "/v1/keyless/bonus",
          },
        ],
      }),
    );
    expect(block.split("\n")).toEqual([
      "Tavily rate limit reached.",
      "Hourly cap reached.",
      "",
      "Retry after: 1m 30s (90s)",
      "",
      "Continuation options:",
      "  - Sign up for a Tavily API key:  https://app.tavily.com",
      "  - Pay via x402 agentic payment:  pay here",
      "  - Earn 50 bonus credits by answering 2 questions:",
      "      1. Who are you?",
      "      2. What do you build?",
      "    POST your answers to: /v1/keyless/bonus",
    ]);
  });

  test("envelope defaults, ineligible bonus, and empty input", () => {
    expect(formatKeylessEnvelopeForTerminal(capHit({}))).toBe("Tavily rate limit reached.");
    const block = formatKeylessEnvelopeForTerminal(
      capHit({
        retryAfter: 0,
        continuationPaths: [
          { type: "signup" },
          { type: "agentic_payment" },
          { type: "bonus_credits", eligible: false, questions: ["q"] },
          // The SDK passes envelope entries through unchecked.
          "junk" as unknown as TavilyContinuationPath,
        ],
      }),
    );
    expect(block.split("\n")).toEqual([
      "Tavily rate limit reached.",
      "",
      "Continuation options:",
      "  - Sign up for a Tavily API key:  https://tavily.com",
      "  - Pay via x402 agentic payment",
    ]);
    const bonus = formatKeylessEnvelopeForTerminal(
      capHit({
        continuationPaths: [{ type: "bonus_credits", eligible: true, questions: ["only"] }],
      }),
    );
    expect(bonus).toContain("  - Earn bonus credits by answering 1 question:");
    expect(bonus).toContain("    POST your answers to: /v1/keyless/bonus");
  });

  test("production envelope renders each resource and instruction", () => {
    const block = formatKeylessEnvelopeForTerminal(
      keylessLimitErrorFromEnvelope({
        error: {
          code: "daily_cap_reached",
          message: "...",
          window: "day",
          retry_after_seconds: 480,
          next_actions: [
            {
              type: "agentic_payment",
              resource: "https://docs.tavily.com/documentation/machine-payments/x402",
              instruction:
                "Pay for this request using the x402 agentic payment protocol to continue immediately.",
            },
            {
              type: "signup",
              resource: "https://tavily.com",
              instruction:
                "Ask the user to sign up at tavily.com and retry with the API key in the Authorization header as: Bearer tvly-YOUR_API_KEY",
            },
          ],
        },
      }),
    );
    expect(block.split("\n").slice(-5)).toEqual([
      "Continuation options:",
      "  - Sign up for a Tavily API key:  https://tavily.com",
      "      Ask the user to sign up at tavily.com and retry with the API key in the Authorization header as: Bearer tvly-YOUR_API_KEY",
      "  - Pay via x402 agentic payment:  https://docs.tavily.com/documentation/machine-payments/x402",
      "      Pay for this request using the x402 agentic payment protocol to continue immediately.",
    ]);
    expect(block).not.toContain("TBD");
  });
});

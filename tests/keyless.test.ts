import { type TavilyContinuationPath, TavilyKeylessLimitError } from "@tavily/core";
import { expect, test } from "vitest";
import { formatKeylessEnvelopeForTerminal, formatSeconds } from "../src/ui/keyless.js";

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
    "  - Pay via x402 agentic payment:  TBD",
  ]);
  const bonus = formatKeylessEnvelopeForTerminal(
    capHit({ continuationPaths: [{ type: "bonus_credits", eligible: true, questions: ["only"] }] }),
  );
  expect(bonus).toContain("  - Earn bonus credits by answering 1 question:");
  expect(bonus).toContain("    POST your answers to: /v1/keyless/bonus");
});

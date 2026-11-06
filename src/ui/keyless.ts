/** Terminal rendering for the Tavily API's keyless rate-limit envelope. */
import type { TavilyKeylessLimitError } from "@tavily/core";
import { isObject } from "../errors.js";
import { sanitizeControl } from "./text.js";
import { colors, err } from "./theme.js";

/** Compact human duration for retry-after hints. */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

type Action = Record<string, unknown>;

/** Python truthiness for the `or` defaults the envelope fields use. */
const orDefault = (value: unknown, fallback: string): string => (value ? String(value) : fallback);

/** The `--json` error object for a keyless cap hit. */
export function keylessCapError(e: TavilyKeylessLimitError) {
  return {
    code: e.capType,
    message: e.message,
    window: e.window,
    retry_after_seconds: e.retryAfter,
    next_actions: e.continuationPaths,
  };
}

/** Print the keyless cap-hit message, retry delay, continuation options and login hint to stderr. */
export function printKeylessCapHit(e: TavilyKeylessLimitError): void {
  err();
  sanitizeControl(formatKeylessEnvelopeForTerminal(e))
    .split("\n")
    .forEach((line, i) => {
      if (i === 0) err(`  ${colors.yellow(">")} ${colors.bold(line)}`);
      else err(line ? `    ${line}` : "");
    });
  err();
  err(
    `  ${colors.dim("Run ")}${colors.green("tvly login")}${colors.dim(" to authenticate and remove this cap.")}`,
  );
  err();
}

/** Render the keyless rate-limit envelope as a plain-text block (first line is the title). */
export function formatKeylessEnvelopeForTerminal(
  e: Pick<TavilyKeylessLimitError, "message" | "retryAfter" | "continuationPaths">,
): string {
  const lines = ["Tavily rate limit reached."];

  if (e.message.trim()) lines.push(e.message.trim());

  const retry = e.retryAfter;
  if (typeof retry === "number" && Number.isInteger(retry) && retry > 0) {
    lines.push("", `Retry after: ${formatSeconds(retry)} (${retry}s)`);
  }

  // The SDK passes the envelope's entries through unchecked, so non-objects are skipped.
  const actions = (e.continuationPaths as unknown[]).filter(isObject);
  const last = (type: string, accept: (a: Action) => boolean = () => true) =>
    [...actions].reverse().find((a) => a.type === type && accept(a));
  const signup = last("signup");
  const payment = last("agentic_payment");
  const bonus = last("bonus_credits", (a) => Boolean(a.eligible));

  if (signup || payment || bonus) {
    lines.push("", "Continuation options:");
    if (signup) {
      lines.push(
        `  - Sign up for a Tavily API key:  ${orDefault(signup.url, "https://tavily.com")}`,
      );
    }
    if (payment) {
      lines.push(
        `  - Pay via ${orDefault(payment.scheme, "x402")} agentic payment:  ${orDefault(payment.details, "TBD")}`,
      );
    }
    if (bonus) {
      const questions = Array.isArray(bonus.questions) ? bonus.questions : [];
      if (questions.length > 0) {
        const credits = bonus.credits_on_completion;
        const noun = `${questions.length} question${questions.length !== 1 ? "s" : ""}`;
        lines.push(
          typeof credits === "number" && Number.isInteger(credits)
            ? `  - Earn ${credits} bonus credits by answering ${noun}:`
            : `  - Earn bonus credits by answering ${noun}:`,
        );
        questions.forEach((q, i) => {
          if (typeof q === "string") lines.push(`      ${i + 1}. ${q}`);
        });
        lines.push(`    POST your answers to: ${orDefault(bonus.endpoint, "/v1/keyless/bonus")}`);
      }
    }
  }
  return lines.join("\n");
}

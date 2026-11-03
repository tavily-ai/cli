/** Terminal rendering for the Tavily API's keyless rate-limit envelope. */

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

function isAction(value: unknown): value is Action {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness for the `or` defaults the envelope fields use. */
const orDefault = (value: unknown, fallback: string): string => (value ? String(value) : fallback);

/** Render the keyless rate-limit envelope as a plain-text block (first line is the title). */
export function formatKeylessEnvelopeForTerminal(opts: {
  message?: string;
  retryAfterSeconds?: number | null;
  nextActions?: unknown[];
}): string {
  const lines = ["Tavily rate limit reached."];

  if (typeof opts.message === "string" && opts.message.trim()) lines.push(opts.message.trim());

  const retry = opts.retryAfterSeconds;
  if (typeof retry === "number" && Number.isInteger(retry) && retry > 0) {
    lines.push("", `Retry after: ${formatSeconds(retry)} (${retry}s)`);
  }

  const actions = (opts.nextActions ?? []).filter(isAction);
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

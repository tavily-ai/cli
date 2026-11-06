/** Thrown by commands to request a process exit code; only `cli.ts` calls `process.exit`. */
export class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
    this.name = "ExitError";
  }
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/** A non-null, non-array object, such as parsed JSON's `{...}`. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An Error's message, or the thrown value as a string. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

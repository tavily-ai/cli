/** Option helpers that load only commander, so the CLI entry point stays free of the SDK. */
import { type Command, InvalidArgumentError, Option } from "commander";

/** `--json` anywhere up the command chain. */
export function resolveJson(cmd: Command): boolean {
  return cmd.optsWithGlobals().json === true;
}

export function addClientNameOption(cmd: Command): Command {
  return cmd.addOption(
    new Option("--client-name <name>", "Set optional client_name for request attribution.").env(
      "TAVILY_CLIENT_NAME",
    ),
  );
}

/** `-o, --output [file]`: the value is the path, or "" when the flag is bare. */
export function addOutputOption(cmd: Command): Command {
  return cmd.addOption(
    new Option(
      "-o, --output [file]",
      "Save the full JSON response to this file. With no value, save it under .tavily/ with a generated name.",
    ).preset(""),
  );
}

/** Parse a numeric option value; bounds errors name the `minimum <n>` / `maximum <n>` they break. */
export function parseNumberArg(
  raw: string,
  opts: { integer?: boolean; minimum?: number; maximum?: number } = {},
): number {
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  if (Number.isNaN(n)) throw new InvalidArgumentError("Not a number.");
  if (opts.integer && !Number.isInteger(n)) throw new InvalidArgumentError("Not an integer.");
  if (opts.minimum !== undefined && n < opts.minimum) {
    throw new InvalidArgumentError(`${n} is below the minimum ${opts.minimum}.`);
  }
  if (opts.maximum !== undefined && n > opts.maximum) {
    throw new InvalidArgumentError(`${n} is above the maximum ${opts.maximum}.`);
  }
  return n;
}

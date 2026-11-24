/** Where `--api-key` gets the key from: argv (visible in shell history), a hidden prompt, or stdin. */
import type { Host } from "../host.js";
import { colors, err } from "../ui/theme.js";

/**
 * `--api-key <key>` still works, but a key typed on the command line lands in shell history and
 * the process list, so it prints a hint (not under `--json`). `--api-key` with no value asks for
 * it (hidden) on a terminal, or reads it from stdin when piped (first non-empty line);
 * `--api-key -` always reads stdin.
 */
export async function resolveApiKeyOption(
  value: string | boolean | undefined,
  host: Host,
  json: boolean,
): Promise<string | undefined> {
  if (value === undefined || value === false) return undefined;
  let key: string;
  if (typeof value === "string" && value !== "-") {
    key = value;
    if (!json) {
      err(`  ${colors.yellow(">")} A key on the command line can end up in your shell history.`);
      err(
        `    ${colors.dim("Next time set TAVILY_API_KEY, or pass")} ${colors.green("--api-key")} ${colors.dim("with no value and paste the key when asked.")}`,
      );
    }
  } else if (value === true && host.stdinIsTTY) {
    key = await host.prompt.password("API key");
  } else {
    // Some runners hand over a pipe that never closes, so say what we are waiting for.
    err(
      json
        ? JSON.stringify({ event: "reading_api_key", source: "stdin" })
        : `  ${colors.dim("Reading API key from stdin...")}`,
    );
    key = await host.readStdin();
  }
  // A piped secret may carry extra lines (`pass` entries do); the key is the first non-empty one.
  key =
    key
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? "";
  if (!key)
    throw new Error(
      "No API key provided. Pipe it in with --api-key -, or pass --api-key on a terminal and paste it when asked.",
    );
  return key;
}

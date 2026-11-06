/** JSON output and `-o` file naming, the shared plain-text page echo, and the footer rule. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { plain } from "../text.js";
import { colors, err, out } from "../theme.js";

export type Json = Record<string, unknown>;
export type Page = { url?: string; raw_content?: string | null };

const DEFAULT_OUTPUT_DIR = ".tavily";

export const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/**
 * Write JSON to stdout, or to `outputFile` (creating its folder; a new `.tavily` folder gets a
 * `.gitignore` of `*` so saved results stay out of git). JSON.stringify escapes control bytes.
 */
export function emit(
  data: unknown,
  opts: { outputFile?: string | undefined; pretty: boolean },
): void {
  const text = JSON.stringify(data, null, opts.pretty ? 2 : undefined);
  if (!opts.outputFile) {
    out(text);
    return;
  }
  const folder = path.dirname(opts.outputFile);
  if (!existsSync(folder)) {
    mkdirSync(folder, { recursive: true });
    if (path.basename(path.normalize(folder)) === DEFAULT_OUTPUT_DIR) {
      writeFileSync(path.join(folder, ".gitignore"), "*\n");
    }
  }
  writeFileSync(opts.outputFile, `${text}\n`);
  err(`Output saved to ${opts.outputFile}`);
}

/** For `--json` or `-o`: save/print the JSON and report true; false means render for people. */
export function emitIfRequested(
  data: unknown,
  opts: { json: boolean; outputFile?: string | undefined },
): boolean {
  if (!opts.json && !opts.outputFile) return false;
  emit(data, { outputFile: opts.outputFile, pretty: true });
  return true;
}

/** A dim rule across the terminal with the count and response time centred in it. */
export function footer(count: number, unit: string, responseTime?: unknown): void {
  const parts = [`${count} ${unit}`];
  if (typeof responseTime === "number" && responseTime) parts.push(`${responseTime.toFixed(2)}s`);
  const label = ` ${parts.join(" | ")} `;
  const fill = Math.max(0, (process.stdout.columns ?? 80) - label.length);
  const left = Math.floor(fill / 2);
  out();
  out(colors.dim(`${"─".repeat(left)}${label}${"─".repeat(fill - left)}`));
}

/** Each page as `# <url>`, a blank line, and its whole content. */
export function echoPages(pages: Page[]): void {
  for (const page of pages) {
    out(`# ${plain(page.url ?? "")}\n`);
    out(`${plain(page.raw_content || "(no content)")}\n`);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Turn a bare `-o` (empty string) into `.tavily/<command>-<label>-<HHMMSS>-<random>.json`; a given
 * path or no `-o` passes through. The name is picked before the request runs, so the random suffix
 * keeps overlapping commands from choosing the same file.
 */
export function resolveOutput(
  outputFile: string | undefined,
  command: string,
  label: unknown,
  now: Date = new Date(),
  random: () => string = () => randomBytes(3).toString("hex"),
): string | undefined {
  if (outputFile !== "") return outputFile;
  const slug =
    (
      String(label)
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? []
    )
      .join("-")
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") || "result";
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return path.join(DEFAULT_OUTPUT_DIR, `${command}-${slug}-${time}-${random()}.json`);
}

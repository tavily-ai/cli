import { randomBytes } from "node:crypto";
import path from "node:path";

export const DEFAULT_OUTPUT_DIR = ".tavily";

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

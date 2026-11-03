import pc from "picocolors";

export const AQUA = "#5CD9E6";
export const PINK = "#FAA2FB";
export const YELLOW = "#FFC769";
export const PURPLE = "#8385F9";
export const GREEN = "#9BC0AE";

/**
 * Color only for a terminal: NO_COLOR and FORCE_COLOR=0 turn it off, any other non-empty
 * FORCE_COLOR turns it on, otherwise stdout must be a TTY. picocolors' own detection also enables
 * color on Windows and under CI, even when piped.
 */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR || env.FORCE_COLOR === "0") return false;
  return Boolean(env.FORCE_COLOR) || process.stdout.isTTY === true;
}

// The environment is read per call so output reflects it when it is produced.
function paint(color: string, s: string): string {
  if (!colorEnabled()) return s;
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
  const cube = (c: number) => Math.round((c / 255) * 5);
  const code = ["truecolor", "24bit"].includes(process.env.COLORTERM ?? "")
    ? `38;2;${r};${g};${b}`
    : `38;5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}`;
  return `\x1b[${code}m${s}\x1b[39m`;
}

export const colors = {
  aqua: (s: string): string => paint(AQUA, s),
  pink: (s: string): string => paint(PINK, s),
  yellow: (s: string): string => paint(YELLOW, s),
  purple: (s: string): string => paint(PURPLE, s),
  green: (s: string): string => paint(GREEN, s),
  dim: (s: string): string => pc.createColors(colorEnabled()).dim(s),
  bold: (s: string): string => pc.createColors(colorEnabled()).bold(s),
};

export const LOGO = [
  colors.aqua("   _              _ _       "),
  colors.pink("  | |_ __ ___   _(_) |_   _ "),
  colors.yellow("  | __/ _` \\ \\ / / | | | | |"),
  colors.purple("  | || (_| |\\ V /| | | |_| |"),
  colors.green("   \\__\\__,_| \\_/ |_|_|\\__, |"),
  colors.dim("                       |___/ "),
].join("\n");

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function err(line = ""): void {
  process.stderr.write(`${line}\n`);
}

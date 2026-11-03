// Identical to Python's sanitize_control: C0 controls except \t \n \r, plus DEL and C1.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
// Python's (?:[ \t]*\n){3,} anchored on a newline: it can only start at "\n", so it stays linear on
// long space runs, and it ends at a newline, so the line after the run keeps its indentation.
const BLANK_RUNS = /\n(?:[ \t]*\n){2,}/g;

export function sanitizeControl(value: unknown): string {
  return String(value).replace(CONTROL_CHARS, "");
}

export function plain(value: unknown): string {
  return sanitizeControl(value).replace(BLANK_RUNS, "\n\n").trim();
}

export function snippet(content: unknown, maxChars: number): string {
  const text = sanitizeControl(content).split(/\s+/).filter(Boolean).join(" ");
  return maxChars && text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

let terminalOverride: boolean | null = null;

export function setTerminalOverride(value: boolean | null): void {
  terminalOverride = value;
}

export function isTerminal(stream: NodeJS.WriteStream = process.stdout): boolean {
  return terminalOverride ?? Boolean(stream.isTTY);
}

export function terminalWidth(stream: NodeJS.WriteStream): number {
  return stream.columns ?? 80;
}

export function safeLink(
  url: unknown,
  label?: unknown,
  opts: { stream?: NodeJS.WriteStream } = {},
): string {
  const cleanUrl = sanitizeControl(url);
  const display = label === undefined ? cleanUrl : sanitizeControl(label);
  let protocol = "";
  try {
    protocol = new URL(cleanUrl).protocol;
  } catch {
    // malformed, attacker-controlled URLs render as plain text
  }
  const linkable = protocol === "http:" || protocol === "https:";
  if (!linkable || !isTerminal(opts.stream ?? process.stderr)) return display;
  return `\x1b]8;;${cleanUrl}\x1b\\${display}\x1b]8;;\x1b\\`;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The URL's host (with any port), or the input when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Callers must sanitize labels (sanitizeControl) before passing them in. */
export function tree(root: string, nodes: Array<{ label: string; children?: string[] }>): string {
  const lines = [root];
  nodes.forEach((node, i) => {
    const last = i === nodes.length - 1;
    lines.push(`${last ? "└── " : "├── "}${node.label}`);
    const kids = node.children ?? [];
    kids.forEach((kid, j) => {
      lines.push(`${last ? "    " : "│   "}${j === kids.length - 1 ? "└── " : "├── "}${kid}`);
    });
  });
  return lines.join("\n");
}

/** Callers must sanitize headers and cells (sanitizeControl) before passing them in. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const fmt = (cells: string[]) => cells.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join(" ");
  return [fmt(headers), widths.map((w) => "─".repeat(w)).join(" "), ...rows.map(fmt)].join("\n");
}

export async function renderMarkdown(markdown: string): Promise<string> {
  const input = sanitizeControl(markdown);
  const [{ Marked }, { markedTerminal }] = await Promise.all([
    import("marked"),
    import("marked-terminal"),
  ]);
  const width = Math.min(process.stdout.columns ?? 80, 100);
  const marked = new Marked(markedTerminal({ width, reflowText: true }));
  return (await marked.parse(input)).trimEnd();
}

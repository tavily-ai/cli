const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', "\\"]);

/** Split a line into words using POSIX `shlex.split` rules. */
export function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let i = 0;

  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      i++;
    } else if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error("No closing quotation");
      current += line.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (ch === '"') {
      inWord = true;
      i++;
      for (;;) {
        if (i >= line.length) throw new Error("No closing quotation");
        const c = line.charAt(i);
        if (c === '"') {
          i++;
          break;
        }
        const next = line.charAt(i + 1);
        if (c === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(next)) {
          current += next;
          i += 2;
        } else {
          current += c;
          i++;
        }
      }
    } else if (ch === "\\") {
      if (i + 1 >= line.length) throw new Error("No escaped character");
      current += line.charAt(i + 1);
      inWord = true;
      i += 2;
    } else {
      current += ch;
      inWord = true;
      i++;
    }
  }

  if (inWord) words.push(current);
  return words;
}

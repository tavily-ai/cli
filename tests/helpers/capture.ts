import { afterEach, beforeEach, vi } from "vitest";
import { setTerminalOverride } from "../../src/ui/text.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\]8;[^${ESC}]*${ESC}\\\\|${ESC}\\[[0-9;]*m`, "g");

/** Visible text only: hyperlink targets and colours removed. */
export const visible = (s: string): string => s.replace(ANSI, "");

/** Capture process.stdout/stderr writes for every test in the file; resets the terminal override. */
export function captureOutput(): { stdout: () => string; stderr: () => string } {
  let out: string[] = [];
  let errs: string[] = [];
  beforeEach(() => {
    out = [];
    errs = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      errs.push(String(s));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setTerminalOverride(null);
  });
  return { stdout: () => out.join(""), stderr: () => errs.join("") };
}

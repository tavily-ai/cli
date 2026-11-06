import { isTerminal } from "./text.js";

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const INTERVAL_MS = 80;

/** A stderr spinner, drawn only when `enabled` and stderr is a terminal. Callers must sanitize
 * `message` (sanitizeControl) if it contains untrusted text. */
export function spinner(
  message: string,
  enabled: boolean,
): { update(message: string): void; stop(): void } {
  const stream = process.stderr;
  if (!enabled || !isTerminal(stream)) return { update() {}, stop() {} };

  let frame = 0;
  const draw = () => stream.write(`\r${FRAMES[frame++ % FRAMES.length]} ${message}`);
  draw();
  const timer = setInterval(draw, INTERVAL_MS);
  let stopped = false;
  return {
    update(next) {
      message = next;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write("\r\x1b[2K");
    },
  };
}

export async function withSpinner<T>(
  message: string,
  enabled: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const s = spinner(message, enabled);
  try {
    return await fn();
  } finally {
    s.stop();
  }
}

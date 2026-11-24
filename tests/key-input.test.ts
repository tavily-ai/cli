import { describe, expect, test } from "vitest";
import { resolveApiKeyOption } from "../src/core/key-input.js";
import { ExitError } from "../src/errors.js";
import { captureOutput, visible } from "./helpers/capture.js";
import { fakeHost } from "./helpers/host.js";

const io = captureOutput();

describe("resolveApiKeyOption", () => {
  test("a bare flag on a terminal asks for the key at a hidden prompt", async () => {
    const asked: string[] = [];
    const host = fakeHost({
      stdinIsTTY: true,
      prompt: {
        ...fakeHost().prompt,
        password: async (message) => {
          asked.push(message);
          return "  tvly-typed \n";
        },
      },
    });
    expect(await resolveApiKeyOption(true, host, true)).toBe("tvly-typed");
    expect(asked).toEqual(["API key"]);
  });

  test("a dash always reads stdin, even on a terminal", async () => {
    const host = fakeHost({ stdinIsTTY: true, readStdin: async () => "tvly-dash\n" });
    expect(await resolveApiKeyOption("-", host, true)).toBe("tvly-dash");
  });

  test("a literal key warns about shell history", async () => {
    expect(await resolveApiKeyOption("tvly-abc", fakeHost(), true)).toBe("tvly-abc");
    expect(visible(io.stderr())).toContain("shell history");
  });

  test("a key from stdin or a dash does not warn about shell history", async () => {
    const host = fakeHost({ readStdin: async () => "tvly-abc" });
    await resolveApiKeyOption(true, host, true);
    await resolveApiKeyOption("-", host, true);
    expect(visible(io.stderr())).not.toContain("shell history");
  });

  test("a literal key is silent when warn is off", async () => {
    expect(await resolveApiKeyOption("tvly-abc", fakeHost(), false)).toBe("tvly-abc");
    expect(visible(io.stderr())).not.toContain("shell history");
  });

  test("reading stdin says so on stderr, so a pipe that never closes is not a silent hang", async () => {
    await resolveApiKeyOption(true, fakeHost({ readStdin: async () => "tvly-abc" }), true);
    expect(visible(io.stderr())).toContain("Reading API key from stdin");
  });

  test("multi-line stdin yields only the first non-empty line", async () => {
    const host = fakeHost({ readStdin: async () => "tvly-abc\nurl: tavily.com\n" });
    expect(await resolveApiKeyOption("-", host, true)).toBe("tvly-abc");
    const leading = fakeHost({ readStdin: async () => "\n  tvly-abc  \r\nlogin: me\r\n" });
    expect(await resolveApiKeyOption(true, leading, true)).toBe("tvly-abc");
  });

  test("an empty answer is an error", async () => {
    await expect(
      resolveApiKeyOption(true, fakeHost({ readStdin: async () => " \n" }), true),
    ).rejects.toThrow("No API key provided");
  });

  test("a literal empty string is an error", async () => {
    await expect(resolveApiKeyOption("", fakeHost(), true)).rejects.toThrow("No API key provided");
  });

  test("a cancelled prompt passes its ExitError through unchanged", async () => {
    const cancelled = new ExitError(1);
    const host = fakeHost({
      stdinIsTTY: true,
      prompt: {
        ...fakeHost().prompt,
        password: async () => {
          throw cancelled;
        },
      },
    });
    await expect(resolveApiKeyOption(true, host, true)).rejects.toBe(cancelled);
  });
});

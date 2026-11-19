import { describe, expect, test } from "vitest";
import { resolveApiKeyOption } from "../src/core/key-input.js";
import { fakeHost } from "./helpers/host.js";

describe("resolveApiKeyOption", () => {
  test("no flag means no key", async () => {
    expect(await resolveApiKeyOption(undefined, fakeHost(), true)).toBeUndefined();
    expect(await resolveApiKeyOption(false, fakeHost(), true)).toBeUndefined();
  });

  test("a literal key is used as given", async () => {
    expect(await resolveApiKeyOption("tvly-abc", fakeHost(), false)).toBe("tvly-abc");
  });

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

  test("a bare flag without a terminal reads stdin", async () => {
    const host = fakeHost({ stdinIsTTY: false, readStdin: async () => "tvly-piped\n" });
    expect(await resolveApiKeyOption(true, host, true)).toBe("tvly-piped");
  });

  test("a dash always reads stdin, even on a terminal", async () => {
    const host = fakeHost({ stdinIsTTY: true, readStdin: async () => "tvly-dash\n" });
    expect(await resolveApiKeyOption("-", host, true)).toBe("tvly-dash");
  });

  test("an empty answer is an error", async () => {
    await expect(
      resolveApiKeyOption(true, fakeHost({ readStdin: async () => " \n" }), true),
    ).rejects.toThrow("No API key provided");
  });
});

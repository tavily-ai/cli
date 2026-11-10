import type { spawn } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { openBrowser } from "../src/host.js";

describe("openBrowser", () => {
  test.each([
    ["darwin", "open", ["https://x/y"]],
    ["linux", "xdg-open", ["https://x/y"]],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler", "https://x/y"]],
  ] as const)("%s", (platform, cmd, args) => {
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref, on: vi.fn() })) as unknown as typeof spawn;
    openBrowser("https://x/y", platform, spawnImpl);
    expect(spawnImpl).toHaveBeenCalledWith(cmd, args, { detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalled();
  });
});

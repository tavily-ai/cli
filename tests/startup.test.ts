import { expect, test } from "vitest";
import { runCli } from "./helpers/run-cli.js";

// A local guard; CI machines are too noisy for timing, so the import-graph test in cli.test.ts guards there.
test.skipIf(Boolean(process.env.CI))("cold start of --version is under 150ms", async () => {
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await runCli(["--version"]);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  expect(times[2]).toBeLessThan(150);
});

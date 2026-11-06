/** Vitest global setup: build dist/ so the spawn-based tests (contract, cli) never run stale code. */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export default function buildDist(): void {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const tsup = createRequire(import.meta.url).resolve("tsup/dist/cli-default.js");
  execFileSync(process.execPath, [tsup, "--silent"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

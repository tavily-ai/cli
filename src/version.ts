import { readFileSync } from "node:fs";

declare const __VERSION__: string;

// tsup replaces __VERSION__ at build time; source-mode imports fall back to package.json.
export const VERSION: string =
  typeof __VERSION__ === "string"
    ? __VERSION__
    : (
        JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
          version: string;
        }
      ).version;

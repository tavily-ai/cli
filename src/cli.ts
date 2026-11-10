import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { startUpdateCheck } from "./core/update-notice.js";
import { ExitError, messageOf } from "./errors.js";
import { buildProgram } from "./program.js";
import { sanitizeControl } from "./ui/text.js";

export async function main(argv: string[]): Promise<number> {
  const finishUpdateCheck = startUpdateCheck({ argv });
  try {
    await buildProgram().parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof ExitError) return err.code;
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
    console.error(`  > Error: ${sanitizeControl(messageOf(err))}`);
    return 1;
  } finally {
    await finishUpdateCheck();
  }
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv);
}

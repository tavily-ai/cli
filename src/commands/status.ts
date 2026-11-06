/** `tvly --status`: version and how the user is authenticated. */
import { authSource, type ConfigOptions } from "../core/config.js";
import { colors, out } from "../ui/theme.js";
import { VERSION } from "../version.js";
import { getApiKeyOrExit } from "./shared.js";

export async function printStatus(json: boolean, deps: ConfigOptions = {}): Promise<void> {
  const key = await getApiKeyOrExit(json, deps);
  if (json) {
    out(JSON.stringify({ version: VERSION, authenticated: key !== null }));
    return;
  }
  out(`  ${colors.bold(colors.green("tavily"))} v${VERSION}`);
  out();
  if (key !== null) {
    out(`  ${colors.green(">")} Authenticated via ${authSource(key, deps.env)}`);
  } else {
    out(`  ${colors.pink(">")} Not authenticated`);
    out("    Run: tvly login");
  }
}

/** `tvly --status`: version and how the user is authenticated. */
import { authSource, type ConfigHost } from "../core/config.js";
import { colors, out } from "../ui/theme.js";
import { VERSION } from "../version.js";
import { getApiKeyOrExit } from "./credential.js";

export async function printStatus(json: boolean, host: ConfigHost): Promise<void> {
  const key = await getApiKeyOrExit(json, host);
  if (json) {
    out(JSON.stringify({ version: VERSION, authenticated: key !== null }));
    return;
  }
  out(`  ${colors.bold(colors.green("tavily"))} v${VERSION}`);
  out();
  if (key !== null) {
    out(`  ${colors.green(">")} Authenticated via ${authSource(key, host.env)}`);
  } else {
    out(`  ${colors.pink(">")} Not authenticated`);
    out("    Run: tvly login");
  }
}

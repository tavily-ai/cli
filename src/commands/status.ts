/** `tvly --status`: version and how the user is authenticated. */
import { authSource, type ConfigOptions, getApiKey } from "../core/config.js";
import { OAuthError } from "../errors.js";
import { colors, out } from "../ui/theme.js";
import { VERSION } from "../version.js";
import { handleOauthRefreshError } from "./shared.js";

export async function printStatus(json: boolean, deps: ConfigOptions = {}): Promise<void> {
  let key: string | null;
  try {
    key = await getApiKey(deps);
  } catch (e) {
    if (e instanceof OAuthError) handleOauthRefreshError(e, json);
    throw e;
  }
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

/** Credential helpers for commands that never call the API, so they stay free of the SDK. */
import { type ConfigHost, getApiKey } from "../core/config.js";
import { ExitError, messageOf, OAuthError } from "../errors.js";
import { sanitizeControl } from "../ui/text.js";
import { colors, err, out } from "../ui/theme.js";

/** Render a stored OAuth refresh failure without treating it as logout. */
export function handleOauthRefreshError(e: unknown, json: boolean): never {
  const text = sanitizeControl(messageOf(e));
  if (json) {
    out(JSON.stringify({ error: { code: "oauth_refresh_failed", message: text } }));
  } else {
    err(`  ${colors.pink("> OAuth refresh failed:")} ${text}`);
  }
  throw new ExitError(3);
}

/** The stored/env credential, or null; a failed OAuth refresh exits 3. */
export async function getApiKeyOrExit(json: boolean, host: ConfigHost): Promise<string | null> {
  try {
    return await getApiKey(host);
  } catch (e) {
    if (e instanceof OAuthError) handleOauthRefreshError(e, json);
    throw e;
  }
}

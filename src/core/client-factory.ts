import { getApiKeyOrExit } from "../commands/common.js";
import { ExitError } from "../errors.js";
import { safeLink } from "../ui/text.js";
import { colors, err } from "../ui/theme.js";
import { getApiBaseUrl, getApiKey, getHumanId, isOauthToken } from "./config.js";
import { createMcpClient } from "./mcp-client.js";
import { getSessionId } from "./session.js";
import { createTavilyClient, type TavilyClientLike } from "./tavily-client.js";

/** An MCP client for an OAuth token, otherwise an SDK client (keyless when `key` is null). */
function buildClient(key: string | null, clientName: string | undefined): TavilyClientLike {
  const humanId = getHumanId();
  const ids = {
    sessionId: getSessionId(),
    ...(humanId ? { humanId } : {}),
    ...(clientName ? { clientName } : {}),
  };
  if (key && isOauthToken(key)) return createMcpClient({ token: key, ...ids });
  const apiBaseUrl = getApiBaseUrl();
  return createTavilyClient({
    ...ids,
    apiKey: key ?? undefined,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

/** A keyed client; without a key, prints why `command` needs one and exits 3. */
export async function getKeyedClient(
  command: string,
  opts: { json: boolean; clientName?: string | undefined },
): Promise<TavilyClientLike> {
  const key = await getApiKeyOrExit(opts.json);
  if (key) return buildClient(key, opts.clientName);
  err();
  err(`  ${colors.pink(">")} The ${colors.bold(command)} command requires a Tavily API key.`);
  err();
  err(`  Sign up for a free key at ${safeLink("https://tavily.com")}`);
  err(
    `  Then run ${colors.green("tvly login")} or ${colors.green("tvly login --api-key tvly-YOUR_KEY")}`,
  );
  err();
  err(
    colors.dim(
      `  Tip: ${colors.green("tvly search")} and ${colors.green("tvly extract")} work without an API key (subject to a rate-limit cap).`,
    ),
  );
  err();
  throw new ExitError(3);
}

/** A keyed client when credentials exist, otherwise a keyless one. */
export async function getClientOrKeyless(
  clientName: string | undefined,
): Promise<TavilyClientLike> {
  return buildClient(await getApiKey(), clientName);
}

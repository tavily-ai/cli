import { handleOauthRefreshError } from "../commands/shared.js";
import { ExitError, OAuthError } from "../errors.js";
import { safeLink } from "../ui/text.js";
import { colors, err } from "../ui/theme.js";
import { getApiBaseUrl, getApiKey, getHumanId, isOauthToken } from "./config.js";
import { createMcpClient } from "./mcp-client.js";
import { getSessionId } from "./session.js";
import { createTavilyClient, type TavilyClientLike } from "./tavily-client.js";

/** The stored/env credential, or null; a failed OAuth refresh exits 3. */
async function resolveKey(json: boolean): Promise<string | null> {
  try {
    return await getApiKey();
  } catch (e) {
    if (e instanceof OAuthError) return handleOauthRefreshError(e, json);
    throw e;
  }
}

function buildKeyedClient(key: string, clientName: string | undefined): TavilyClientLike {
  const humanId = getHumanId();
  if (isOauthToken(key)) {
    return createMcpClient({
      token: key,
      sessionId: getSessionId(),
      ...(humanId ? { humanId } : {}),
      ...(clientName ? { clientName } : {}),
    });
  }
  const apiBaseUrl = getApiBaseUrl();
  return createTavilyClient({
    apiKey: key,
    sessionId: getSessionId(),
    ...(humanId ? { humanId } : {}),
    ...(clientName ? { clientName } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  });
}

/** A keyed client (SDK or MCP by credential type); prints a help block and exits 3 without a key. */
export async function getClient(opts: {
  clientName?: string;
  json: boolean;
}): Promise<TavilyClientLike> {
  const key = await resolveKey(opts.json);
  if (!key) {
    err(`  ${colors.pink("> Error:")} No Tavily API key found.`);
    err();
    err("  Authenticate using one of:");
    err(`    ${colors.green("tvly login")}`);
    err(`    ${colors.green("tvly login --api-key tvly-YOUR_KEY")}`);
    err(`    ${colors.dim("export TAVILY_API_KEY=tvly-YOUR_KEY")}`);
    err();
    err(`  Get a key at ${safeLink("https://tavily.com", "tavily.com")}`);
    throw new ExitError(3);
  }
  return buildKeyedClient(key, opts.clientName);
}

/** A keyed client when credentials exist, otherwise a keyless one. */
export async function getClientOrKeyless(opts: {
  clientName?: string | undefined;
}): Promise<{ client: TavilyClientLike; keyless: boolean }> {
  const key = await getApiKey();
  if (key) return { client: buildKeyedClient(key, opts.clientName), keyless: false };
  const humanId = getHumanId();
  const apiBaseUrl = getApiBaseUrl();
  return {
    client: createTavilyClient({
      sessionId: getSessionId(),
      ...(humanId ? { humanId } : {}),
      ...(opts.clientName ? { clientName: opts.clientName } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    }),
    keyless: true,
  };
}

/** The API key, or a friendly message and exit 3 for commands that cannot run keyless. */
export async function requireApiKeyFriendly(
  commandName: string,
  opts: { json: boolean },
): Promise<string> {
  const key = await resolveKey(opts.json);
  if (key) return key;
  err();
  err(`  ${colors.pink(">")} The ${colors.bold(commandName)} command requires a Tavily API key.`);
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

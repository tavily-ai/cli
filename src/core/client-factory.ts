import { getApiBaseUrl, getHumanId, isOauthToken } from "./config.js";
import { createMcpClient } from "./mcp-client.js";
import { getSessionId } from "./session.js";
import { createTavilyClient, type TavilyClientLike } from "./tavily-client.js";

/** An MCP client for an OAuth token, otherwise an SDK client (keyless when `key` is null). */
export function buildClient(key: string | null, clientName?: string): TavilyClientLike {
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

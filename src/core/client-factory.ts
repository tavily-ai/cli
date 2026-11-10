import type { Host } from "../host.js";
import { getApiBaseUrl, getHumanId, isOauthToken } from "./config.js";
import { createMcpClient } from "./mcp-client.js";
import { getSessionId } from "./session.js";
import { createTavilyClient, type TavilyClientLike } from "./tavily-client.js";

/** An MCP client for an OAuth token, otherwise an SDK client (keyless when `key` is null). */
export function buildClient(
  key: string | null,
  clientName: string | undefined,
  host: Pick<Host, "home" | "env" | "fetch" | "platform" | "exec">,
): TavilyClientLike {
  const humanId = getHumanId(host);
  const ids = {
    sessionId: getSessionId(host),
    ...(humanId ? { humanId } : {}),
    ...(clientName ? { clientName } : {}),
  };
  if (key && isOauthToken(key)) {
    return createMcpClient({ token: key, ...ids, fetchImpl: host.fetch });
  }
  const apiBaseUrl = getApiBaseUrl(host);
  const { TAVILY_PROJECT: projectId, TAVILY_ORG_ID: orgId } = host.env;
  return createTavilyClient({
    ...ids,
    apiKey: key ?? undefined,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(projectId ? { projectId } : {}),
    ...(orgId ? { orgId } : {}),
  });
}

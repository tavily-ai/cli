/**
 * MCP client for Tavily: the OAuth-path twin of `createTavilyClient`. OAuth JWTs are only
 * accepted by the MCP JSON-RPC endpoint, not by api.tavily.com.
 */
import { TavilyRequestError } from "@tavily/core";
import { isObject, messageOf } from "../errors.js";
import { dataPayload } from "./sse.js";
import type { Json, TavilyClientLike } from "./tavily-client.js";

const MCP_URL = "https://mcp.tavily.com/mcp";
const TIMEOUT_MS = 180_000;

interface McpClientOptions {
  token: string;
  sessionId: string;
  humanId?: string;
  clientName?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Throw for an API error payload. A payload with a string `status` is a task result (e.g. a failed
 * research task, `{status: "failed", error}`) and is returned like the API-key path does, unless
 * MCP flagged the result with `isError`.
 */
function raiseIfApiError(parsed: unknown, isError: boolean): void {
  if (!isObject(parsed) || !("error" in parsed)) return;
  if (!isError && typeof parsed.status === "string") return;
  const detail = parsed.detail;
  const message =
    isObject(detail) && typeof detail.error === "string" ? detail.error : String(parsed.error);
  const docs = typeof parsed.documentation === "string" ? parsed.documentation : undefined;
  throw new TavilyRequestError({
    status: typeof parsed.status === "number" ? parsed.status : 0,
    body: parsed,
    message,
    ...(docs ? { docs } : {}),
  });
}

function rpcError(error: unknown): Error {
  return new Error(
    isObject(error) && typeof error.message === "string" ? error.message : JSON.stringify(error),
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Unwraps the JSON-RPC result: structuredContent, then content[0].text, then the bare result. */
function unwrapResult(data: Json): Json {
  const result = isObject(data.result) ? data.result : {};
  const isError = result.isError === true;
  const structured = result.structuredContent;
  if (structured && (typeof structured === "object" || typeof structured === "string")) {
    const parsed = typeof structured === "string" ? parseJson(structured) : structured;
    if (parsed === undefined) {
      throw new TavilyRequestError({
        status: 0,
        body: structured,
        message: "The Tavily MCP server returned malformed structuredContent (not valid JSON).",
      });
    }
    raiseIfApiError(parsed, isError);
    return parsed as Json;
  }
  const content = result.content;
  if (Array.isArray(content) && content.length > 0) {
    const first: unknown = content[0];
    const textVal = isObject(first) && typeof first.text === "string" ? first.text : "";
    const parsed = parseJson(textVal);
    if (parsed === undefined) return { raw: textVal };
    raiseIfApiError(parsed, isError);
    return parsed as Json;
  }
  return result;
}

export function createMcpClient(opts: McpClientOptions): TavilyClientLike {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-client-source": "tavily-cli",
    ...(opts.clientName ? { "x-client-name": opts.clientName } : {}),
    // mcp-session-id stops the remote MCP from generating its own session; X-Session-Id is
    // forwarded to the Tavily API for session attribution.
    "mcp-session-id": opts.sessionId,
    "X-Session-Id": opts.sessionId,
    ...(opts.humanId ? { "X-Human-Id": opts.humanId } : {}),
  };

  async function call(toolName: string, args: Json): Promise<Json> {
    const requestBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };
    let status: number;
    let text: string;
    try {
      const resp = await fetchImpl(MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "manual",
      });
      status = resp.status;
      text = await resp.text();
    } catch (e) {
      throw new Error(`Could not reach the Tavily MCP server: ${messageOf(e)}`);
    }
    if (status < 200 || status >= 300) {
      throw new TavilyRequestError({
        status,
        body: text,
        message: `MCP request failed with status ${status}`,
      });
    }

    // The first SSE `data:` message, or with no data lines, the whole body as plain JSON.
    const payload = text
      .split("\n")
      .map(dataPayload)
      .find((p) => p !== undefined);
    const message = parseJson(payload ?? text);
    if (!isObject(message)) {
      if (payload === undefined) throw new Error(`Unexpected MCP response: ${text.slice(0, 500)}`);
      throw new TavilyRequestError({
        status: 0,
        body: payload,
        message: "The Tavily MCP server returned a malformed SSE message (not a JSON object).",
      });
    }
    if ("error" in message) throw rpcError(message.error);
    if (payload === undefined) return (isObject(message.result) ? message.result : message) as Json;
    return unwrapResult(message);
  }

  return {
    search: (body) => call("tavily_search", body),
    extract: (body) => call("tavily_extract", body),
    crawl: (body) => call("tavily_crawl", body),
    map: (body) => call("tavily_map", body),
    research: (body) => call("tavily_research", body),
    researchStream: () =>
      Promise.reject(
        new TavilyRequestError({
          status: 0,
          body: null,
          message: "Streaming is not available with OAuth credentials; use an API key.",
        }),
      ),
    getResearch: (requestId) => call("tavily_get_research", { request_id: requestId }),
  };
}

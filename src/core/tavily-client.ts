import { createTransport, type TavilyTransport } from "@tavily/core";
import { sseDataLines } from "./sse.js";

export type Json = Record<string, unknown>;

export interface TavilyClientLike {
  search(body: Json): Promise<Json>;
  extract(body: Json): Promise<Json>;
  crawl(body: Json): Promise<Json>;
  map(body: Json): Promise<Json>;
  research(body: Json): Promise<Json>;
  researchStream(body: Json): Promise<AsyncIterable<string>>;
  getResearch(requestId: string): Promise<Json>;
}

interface TavilyClientOptions {
  apiKey?: string | undefined;
  sessionId: string;
  humanId?: string;
  clientName?: string;
  apiBaseUrl?: string;
  transport?: TavilyTransport;
}

const DEFAULT_HTTP_TIMEOUT = 60;
const SEARCH_MAX_TIMEOUT = 120;

export function createTavilyClient(opts: TavilyClientOptions): TavilyClientLike {
  const { TAVILY_PROJECT, TAVILY_ORG_ID } = process.env;
  const transport =
    opts.transport ??
    createTransport({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      clientSource: opts.apiKey ? "tavily-cli" : "tavily-cli-keyless",
      ...(opts.apiBaseUrl ? { apiBaseURL: opts.apiBaseUrl } : {}),
      sessionId: opts.sessionId,
      ...(opts.humanId ? { humanId: opts.humanId } : {}),
      ...(opts.clientName ? { clientName: opts.clientName } : {}),
      ...(TAVILY_PROJECT ? { projectId: TAVILY_PROJECT } : {}),
      ...(TAVILY_ORG_ID ? { orgId: TAVILY_ORG_ID } : {}),
    });

  /** A numeric `body.timeout` wins over the default and is also the HTTP timeout. */
  const withTimeout = (body: Json, defaultTimeout: number): { body: Json; timeout: number } => {
    const timeout = typeof body.timeout === "number" ? body.timeout : defaultTimeout;
    return { body: { ...body, timeout }, timeout };
  };

  return {
    async search(body) {
      const timeout = typeof body.timeout === "number" ? body.timeout : DEFAULT_HTTP_TIMEOUT;
      return (await transport.post("search", body, {
        timeoutSeconds: Math.min(timeout, SEARCH_MAX_TIMEOUT),
      })) as Json;
    },
    async extract(body) {
      const r = withTimeout(body, 30);
      return (await transport.post("extract", r.body, { timeoutSeconds: r.timeout })) as Json;
    },
    async crawl(body) {
      const r = withTimeout(body, 150);
      return (await transport.post("crawl", r.body, { timeoutSeconds: r.timeout })) as Json;
    },
    async map(body) {
      const r = withTimeout(body, 150);
      return (await transport.post("map", r.body, { timeoutSeconds: r.timeout })) as Json;
    },
    async research(body) {
      return (await transport.post(
        "research",
        { stream: false, citation_format: "numbered", ...body },
        {},
      )) as Json;
    },
    async researchStream(body) {
      const chunks = await transport.stream(
        "research",
        { citation_format: "numbered", ...body, stream: true },
        {},
      );
      return sseDataLines(chunks);
    },
    async getResearch(requestId) {
      return (await transport.get(`research/${encodeURIComponent(requestId)}`, {
        timeoutSeconds: DEFAULT_HTTP_TIMEOUT,
      })) as Json;
    },
  };
}

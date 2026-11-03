import { createTransport, TavilyRequestError, type TavilyTransport } from "@tavily/core";
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

export interface TavilyClientOptions {
  apiKey?: string | undefined;
  sessionId: string;
  humanId?: string;
  clientName?: string;
  apiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  transport?: TavilyTransport;
}

const DEFAULT_HTTP_TIMEOUT = 60;
const SEARCH_MAX_TIMEOUT = 120;

export function createTavilyClient(opts: TavilyClientOptions): TavilyClientLike {
  const env = opts.env ?? process.env;
  const keyless = !opts.apiKey;
  const transport =
    opts.transport ??
    createTransport({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      clientSource: keyless ? "tavily-cli-keyless" : "tavily-cli",
      ...(opts.apiBaseUrl ? { apiBaseURL: opts.apiBaseUrl.replace(/\/+$/, "") } : {}),
      sessionId: opts.sessionId,
      ...(opts.humanId ? { humanId: opts.humanId } : {}),
      ...(opts.clientName ? { clientName: opts.clientName } : {}),
      ...(env.TAVILY_PROJECT ? { projectId: env.TAVILY_PROJECT } : {}),
      ...(env.TAVILY_ORG_ID ? { orgId: env.TAVILY_ORG_ID } : {}),
    });

  const requireKey = (method: string): void => {
    if (keyless) {
      throw new TavilyRequestError({
        status: 0,
        body: null,
        message: `${method}: Keyless mode only supports search and extract; provide an API key to use this method.`,
      });
    }
  };

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
      requireKey("crawl");
      const r = withTimeout(body, 150);
      return (await transport.post("crawl", r.body, { timeoutSeconds: r.timeout })) as Json;
    },
    async map(body) {
      requireKey("map");
      const r = withTimeout(body, 150);
      return (await transport.post("map", r.body, { timeoutSeconds: r.timeout })) as Json;
    },
    async research(body) {
      requireKey("research");
      return (await transport.post(
        "research",
        { stream: false, citation_format: "numbered", ...body },
        {},
      )) as Json;
    },
    async researchStream(body) {
      requireKey("researchStream");
      const chunks = await transport.stream(
        "research",
        { citation_format: "numbered", ...body, stream: true },
        {},
      );
      return sseDataLines(chunks);
    },
    async getResearch(requestId) {
      requireKey("getResearch");
      return (await transport.get(`research/${encodeURIComponent(requestId)}`, {
        timeoutSeconds: DEFAULT_HTTP_TIMEOUT,
      })) as Json;
    },
  };
}

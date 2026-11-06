import { TavilyRequestError } from "@tavily/core";
import { expect, test } from "vitest";
import { createMcpClient } from "../src/core/mcp-client.js";

type Seen = { url: string; init: RequestInit };

function stub(body: string, status = 200): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const sse = (data: unknown) => `event: message\ndata: ${JSON.stringify(data)}\n\n`;

function make(body: string, status = 200, extra: { humanId?: string; clientName?: string } = {}) {
  const s = stub(body, status);
  return {
    ...s,
    c: createMcpClient({ token: "jwt", sessionId: "sess", fetchImpl: s.fetchImpl, ...extra }),
  };
}

test("sends the JSON-RPC request with the expected headers", async () => {
  const { c, seen } = make(sse({ result: { structuredContent: { ok: 1 } } }), 200, {
    humanId: "h",
    clientName: "cn",
  });
  await c.search({ query: "q" });
  expect(seen[0]?.url).toBe("https://mcp.tavily.com/mcp");
  expect(JSON.parse(seen[0]?.init.body as string)).toEqual({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "tavily_search", arguments: { query: "q" } },
  });
  expect(seen[0]?.init.headers).toEqual({
    Authorization: "Bearer jwt",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-client-source": "tavily-cli",
    "x-client-name": "cn",
    "mcp-session-id": "sess",
    "X-Session-Id": "sess",
    "X-Human-Id": "h",
  });
  expect(seen[0]?.init.redirect).toBe("manual");
});

test("tool names map per method", async () => {
  const names: string[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    names.push(JSON.parse(init.body as string).params.name);
    return new Response(sse({ result: { structuredContent: {} } }));
  }) as unknown as typeof fetch;
  const c = createMcpClient({ token: "t", sessionId: "s", fetchImpl });
  await c.extract({});
  await c.crawl({});
  await c.map({});
  await c.research({});
  await c.getResearch("r1");
  expect(names).toEqual([
    "tavily_extract",
    "tavily_crawl",
    "tavily_map",
    "tavily_research",
    "tavily_get_research",
  ]);
});

test("structuredContent object and string are returned parsed", async () => {
  expect(await make(sse({ result: { structuredContent: { a: 1 } } })).c.search({})).toEqual({
    a: 1,
  });
  expect(await make(sse({ result: { structuredContent: '{"b":2}' } })).c.search({})).toEqual({
    b: 2,
  });
});

test("content[0].text JSON is parsed, non-JSON becomes raw", async () => {
  const json = sse({ result: { content: [{ text: '{"c":3}' }] } });
  expect(await make(json).c.search({})).toEqual({ c: 3 });
  const raw = sse({ result: { content: [{ text: "hello" }] } });
  expect(await make(raw).c.search({})).toEqual({ raw: "hello" });
});

test("bare result is returned when no content", async () => {
  expect(await make(sse({ result: { x: 1 } })).c.search({})).toEqual({ x: 1 });
});

test("an error in the parsed result throws TavilyRequestError", async () => {
  const body = sse({
    result: { structuredContent: { error: "bad", status: 429, documentation: "http://docs" } },
  });
  const err = await make(body)
    .c.search({})
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TavilyRequestError);
  expect(err).toMatchObject({ message: "bad", status: 429, docs: "http://docs" });
});

test("detail.error wins over error and status defaults to 0", async () => {
  const body = sse({ result: { structuredContent: { error: "x", detail: { error: "deep" } } } });
  const err = await make(body)
    .c.search({})
    .catch((e: unknown) => e);
  expect(err).toMatchObject({ message: "deep", status: 0 });
});

test("a failed research task is returned, not raised, like the API-key path", async () => {
  const failed = { request_id: "r1", status: "failed", error: "model overloaded" };
  expect(await make(sse({ result: { structuredContent: failed } })).c.getResearch("r1")).toEqual(
    failed,
  );
  const text = sse({ result: { content: [{ text: JSON.stringify(failed) }] } });
  expect(await make(text).c.getResearch("r1")).toEqual(failed);
});

test("isError raises even when the payload carries a string status", async () => {
  const body = sse({
    result: { isError: true, structuredContent: { status: "failed", error: "nope" } },
  });
  const err = await make(body)
    .c.getResearch("r1")
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TavilyRequestError);
  expect(err).toMatchObject({ message: "nope" });
});

test("malformed structuredContent throws TavilyRequestError, not SyntaxError", async () => {
  const err = await make(sse({ result: { structuredContent: "{not json" } }))
    .c.search({})
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TavilyRequestError);
  expect((err as Error).message).toContain("malformed structuredContent");
});

test("a JSON-RPC error throws a plain Error with its message", async () => {
  const err = await make(sse({ error: { message: "rpc boom" } }))
    .c.search({})
    .catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(TavilyRequestError);
  expect((err as Error).message).toBe("rpc boom");
});

test("a body with no data lines is parsed as plain JSON", async () => {
  expect(await make(JSON.stringify({ result: { y: 1 } })).c.search({})).toEqual({ y: 1 });
  expect(await make(JSON.stringify({ z: 1 })).c.search({})).toEqual({ z: 1 });
  await expect(make(JSON.stringify({ error: { message: "m" } })).c.search({})).rejects.toThrow("m");
  await expect(make("not json").c.search({})).rejects.toThrow("Unexpected MCP response: not json");
});

test("non-2xx throws TavilyRequestError with status and body", async () => {
  const err = await make("nope", 401)
    .c.search({})
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TavilyRequestError);
  expect(err).toMatchObject({ status: 401, body: "nope" });
});

test("transport failures are reported clearly", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const c = createMcpClient({ token: "t", sessionId: "s", fetchImpl });
  await expect(c.search({})).rejects.toThrow("Could not reach the Tavily MCP server: ECONNREFUSED");
});

test("researchStream is unavailable with OAuth credentials", async () => {
  const err = await make("")
    .c.researchStream({})
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TavilyRequestError);
  expect(err).toMatchObject({
    status: 0,
    message: "Streaming is not available with OAuth credentials; use an API key.",
  });
});

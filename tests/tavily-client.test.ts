import type { TavilyTransport } from "@tavily/core";
import { createTransport } from "@tavily/core";
import { expect, test, vi } from "vitest";
import { sseDataLines } from "../src/core/sse.js";
import { createTavilyClient } from "../src/core/tavily-client.js";

vi.mock("@tavily/core", async (orig) => {
  const mod = await orig<typeof import("@tavily/core")>();
  return { ...mod, createTransport: vi.fn(() => ({})) };
});

type Call = { method: string; endpoint: string; body?: unknown; opts?: unknown };

function stub(): { transport: TavilyTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: TavilyTransport = {
    post: async (endpoint, body, opts) => {
      calls.push({ method: "post", endpoint, body, opts });
      return { ok: true };
    },
    get: async (endpoint, opts) => {
      calls.push({ method: "get", endpoint, opts });
      return { ok: true };
    },
    stream: async (endpoint, body, opts) => {
      calls.push({ method: "stream", endpoint, body, opts });
      return (async function* () {
        yield Buffer.from("data: x\n");
      })();
    },
  };
  return { transport, calls };
}

function client(apiKey?: string) {
  const s = stub();
  return { ...s, c: createTavilyClient({ apiKey, sessionId: "s", transport: s.transport }) };
}

test("clientSource, apiBaseUrl and ids are passed to createTransport", () => {
  const mocked = vi.mocked(createTransport);
  createTavilyClient({
    apiKey: "k",
    sessionId: "s",
    humanId: "h",
    clientName: "n",
    apiBaseUrl: "https://x.test/",
    env: { TAVILY_PROJECT: "p", TAVILY_ORG_ID: "o" },
  });
  expect(mocked.mock.calls[0]?.[0]).toMatchObject({
    apiKey: "k",
    clientSource: "tavily-cli",
    apiBaseURL: "https://x.test",
    sessionId: "s",
    humanId: "h",
    clientName: "n",
    projectId: "p",
    orgId: "o",
  });
  createTavilyClient({ sessionId: "s", env: {} });
  expect(mocked.mock.calls[1]?.[0]).toMatchObject({ clientSource: "tavily-cli-keyless" });
});

test("keyless refusals", async () => {
  const { c, calls } = client();
  await expect(c.crawl({ url: "u" })).rejects.toThrow(
    /^crawl: Keyless mode only supports search and extract/,
  );
  await expect(c.getResearch("a")).rejects.toThrow(/^getResearch: Keyless/);
  await expect(c.researchStream({ input: "i" })).rejects.toThrow(/^researchStream: Keyless/);
  expect(calls).toEqual([]);
  await c.search({ query: "q" });
  expect(calls).toHaveLength(1);
});

test("default timeouts and body defaults", async () => {
  const { c, calls } = client("k");
  await c.extract({ urls: ["u"] });
  await c.crawl({ url: "u" });
  await c.map({ url: "u" });
  await c.research({ input: "i" });
  expect(calls[0]).toMatchObject({ endpoint: "extract", body: { timeout: 30 } });
  expect(calls[0]?.opts).toEqual({ timeoutSeconds: 30 });
  expect(calls[1]).toMatchObject({ endpoint: "crawl", body: { timeout: 150 } });
  expect(calls[1]?.opts).toEqual({ timeoutSeconds: 150 });
  expect(calls[2]).toMatchObject({ endpoint: "map", body: { timeout: 150 } });
  expect(calls[3]).toMatchObject({
    endpoint: "research",
    body: { stream: false, citation_format: "numbered" },
  });
  expect(calls[3]?.opts).toEqual({});
});

test("body values override defaults", async () => {
  const { c, calls } = client("k");
  await c.extract({ urls: ["u"], timeout: 5 });
  await c.research({ input: "i", stream: true, citation_format: "brackets" });
  expect(calls[0]?.body).toMatchObject({ timeout: 5 });
  expect(calls[0]?.opts).toEqual({ timeoutSeconds: 5 });
  expect(calls[1]?.body).toMatchObject({ stream: true, citation_format: "brackets" });
});

test("search timeout is capped at 120 and defaults to 60", async () => {
  const { c, calls } = client("k");
  await c.search({ query: "q", timeout: 500 });
  await c.search({ query: "q" });
  expect(calls[0]?.opts).toEqual({ timeoutSeconds: 120 });
  expect(calls[1]?.opts).toEqual({ timeoutSeconds: 60 });
});

test("getResearch and researchStream", async () => {
  const { c, calls } = client("k");
  await c.getResearch("abc");
  expect(calls[0]).toMatchObject({ method: "get", endpoint: "research/abc" });
  expect(calls[0]?.opts).toEqual({ timeoutSeconds: 60 });
  const it = await c.researchStream({ input: "i" });
  expect(calls[1]).toMatchObject({
    method: "stream",
    endpoint: "research",
    body: { input: "i", stream: true },
  });
  const out: string[] = [];
  for await (const line of it) out.push(line);
  expect(out).toEqual(["x"]);
});

test("sseDataLines reassembles split chunks", async () => {
  async function* chunks() {
    yield Buffer.from('data: {"a"');
    yield ':1}\n\nevent: x\ndata:{"b":2}\r\n';
    yield "data: [DONE]\n";
  }
  const out: string[] = [];
  for await (const l of sseDataLines(chunks())) out.push(l);
  expect(out).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
});

test("getResearch encodes the request id", async () => {
  const { c, calls } = client("k");
  await c.getResearch("a/b?c");
  expect(calls[0]?.endpoint).toBe("research/a%2Fb%3Fc");
});

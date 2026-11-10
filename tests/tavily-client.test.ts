import type { TavilyTransport } from "@tavily/core";
import { expect, test } from "vitest";
import { sseDataLines } from "../src/core/sse.js";
import { createTavilyClient } from "../src/core/tavily-client.js";

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

test("getResearch (with the id encoded) and researchStream", async () => {
  const { c, calls } = client("k");
  await c.getResearch("a/b?c");
  expect(calls[0]).toMatchObject({ method: "get", endpoint: "research/a%2Fb%3Fc" });
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

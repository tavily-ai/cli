/**
 * dist/cli.js end to end against the fixture server, with real credential resolution and the real
 * SDK and MCP clients (nothing injected). Each run gets an empty HOME and an isolated environment.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type Routes, startFixtureServer } from "./helpers/fixture-server.js";
import { runCli } from "./helpers/run-cli.js";

const REDIRECT = fileURLToPath(new URL("./helpers/fetch-redirect.mjs", import.meta.url));
const searchResponse = JSON.parse(
  readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8"),
) as Routes;

let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer({
    "POST /search": searchResponse,
    // A JSON (not SSE) JSON-RPC reply; mcp-client.test.ts covers the SSE and structuredContent shapes.
    "POST /mcp": { jsonrpc: "2.0", id: 1, result: searchResponse },
  });
});
afterAll(() => server.close());
beforeEach(() => {
  server.requests.length = 0;
});

function tvly(args: string[], env: Record<string, string> = {}, home = emptyHome()) {
  return runCli(args, {
    isolated: true,
    preload: REDIRECT,
    env: {
      HOME: home,
      USERPROFILE: home,
      TAVILY_API_BASE_URL: server.url,
      TVLY_FIXTURE_URL: server.url,
      ...env,
    },
  });
}

function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), "tvly-e2e-"));
}

const header = (name: string) => server.requests[0]?.headers[name];

test("search with no credential runs keyless and prints the results", async () => {
  const { code, stdout } = await tvly(["search", "rust 2024"]);
  expect(code).toBe(0);
  expect(stdout).toContain("1. Rust 2024 edition");
  expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /search"]);
  expect(JSON.parse(server.requests[0]?.body ?? "")).toMatchObject({ query: "rust 2024" });
  expect(header("authorization")).toBeUndefined();
  expect(header("x-tavily-access-mode")).toBe("keyless");
  expect(header("x-client-source")).toBe("tavily-cli-keyless");
});

test("a stored OAuth token sends requests to the MCP endpoint, not the REST API", async () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const token = `${enc({ alg: "none" })}.${enc({ iss: "https://mcp.tavily.com/", exp: expiresAt })}.sig`;
  const home = emptyHome();
  mkdirSync(join(home, ".tavily"));
  writeFileSync(
    join(home, ".tavily", "config.json"),
    JSON.stringify({
      oauth: {
        access_token: token,
        refresh_token: "refresh-1",
        expires_at: expiresAt,
        token_type: "Bearer",
        client_id: "cid",
        client_secret: null,
        token_endpoint_auth_method: "none",
        redirect_uri: "http://127.0.0.1:1/callback",
      },
    }),
  );

  const { code, stdout } = await tvly(["search", "rust 2024"], {}, home);
  expect(code).toBe(0);
  expect(stdout).toContain("1. Rust 2024 edition");
  expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /mcp"]);
  expect(header("authorization")).toBe(`Bearer ${token}`);
  expect(JSON.parse(server.requests[0]?.body ?? "")).toMatchObject({
    method: "tools/call",
    params: { name: "tavily_search", arguments: { query: "rust 2024" } },
  });
});

test("the SDK path sends the key, client source, client name, project, org and human headers", async () => {
  const { code } = await tvly(["search", "q", "--json", "--client-name", "my-agent"], {
    TAVILY_API_KEY: "tvly-e2e",
    TAVILY_PROJECT: "proj-1",
    TAVILY_ORG_ID: "org-1",
    TAVILY_HUMAN_ID: "human-1",
  });
  expect(code).toBe(0);
  expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /search"]);
  expect(header("authorization")).toBe("Bearer tvly-e2e");
  expect(header("x-client-source")).toBe("tavily-cli");
  expect(header("x-client-name")).toBe("my-agent");
  expect(header("x-project-id")).toBe("proj-1");
  expect(header("x-tavily-orgid")).toBe("org-1");
  expect(header("x-human-id")).toBe("human-1");
  expect(header("x-session-id")).toMatch(/^[0-9a-f]{32}$/);
});

test("research with no credential exits 3 and makes no request", async () => {
  const { code, stderr } = await tvly(["research", "rust 2024"]);
  expect(code).toBe(3);
  expect(stderr).toContain("command requires a Tavily API key.");
  expect(server.requests).toEqual([]);
});

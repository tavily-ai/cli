/**
 * A local stand-in for the Tavily API: serves one canned JSON response per route.
 *
 * Routes are keys like "POST /search" or "GET /research/*" (a trailing "*" matches any suffix).
 * Every request is recorded in `requests`, so tests can assert on headers and bodies.
 * Run directly with `node --import tsx tests/helpers/fixture-server.ts <routes.json>`: it prints
 * the base URL (http://127.0.0.1:<port>) on stdout and serves until killed.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

export type Routes = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function lookup(routes: Routes, method: string, path: string): unknown {
  const key = `${method} ${path}`;
  if (key in routes) return routes[key];
  for (const [pattern, body] of Object.entries(routes)) {
    if (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1))) return body;
  }
  return undefined;
}

export async function startFixtureServer(routes: Routes): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let received = "";
    req.on("data", (chunk) => {
      received += chunk;
    });
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      requests.push({ method: req.method ?? "GET", path, headers: req.headers, body: received });
      const body = lookup(routes, req.method ?? "GET", path);
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(body ?? { detail: { error: `No fixture for ${req.method} ${path}` } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("usage: fixture-server.ts <routes.json>\n");
    process.exit(2);
  }
  const { url } = await startFixtureServer(JSON.parse(readFileSync(file, "utf8")) as Routes);
  process.stdout.write(`${url}\n`);
}

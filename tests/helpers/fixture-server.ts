/**
 * A local stand-in for the Tavily API: serves one canned JSON response per route.
 *
 * Routes are keys like "POST /search". Every request is recorded in `requests`, so tests can
 * assert on headers and bodies.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Routes = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
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
      const body = routes[`${req.method} ${path}`];
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

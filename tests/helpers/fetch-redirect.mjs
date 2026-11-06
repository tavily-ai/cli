// Preloaded into dist/cli.js with `node --import` by the spawn tests: sends the hard-coded npm
// registry (update check) and Tavily MCP (OAuth credentials) requests to the fixture server named
// by TVLY_FIXTURE_URL. The SDK's own requests already follow TAVILY_API_BASE_URL.
const target = process.env.TVLY_FIXTURE_URL;
const realFetch = globalThis.fetch;
const HOSTS = ["https://registry.npmjs.org/", "https://mcp.tavily.com/"];

globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = target && HOSTS.find((h) => url.startsWith(h));
  if (host) return realFetch(`${target}/${url.slice(host.length)}`, init);
  return realFetch(input, init);
};

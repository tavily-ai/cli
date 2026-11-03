# Handoff: `@tavily/core` 1.1.0 transport export and typed request error

Repository: `tavily-ai/tavily-js`. Suggested branch: `feat/transport-export`. Target release: 1.1.0.

## Why

The TypeScript rewrite of the Tavily CLI (`tavily-ai/tavily-cli`, design at `docs/superpowers/specs/2026-11-02-typescript-rewrite-design.md` in that repo) builds on `@tavily/core` so the CLI, the SDK, and later the MCP server share one implementation of auth headers, keyless handling, proxies, timeouts, and error mapping. Two things block that today:

1. `handleRequestError` in `src/utils.ts` throws a bare `Error`. The CLI needs the HTTP status to exit 3 on 429 and 432 and 4 on other failures, and the `documentation` URL for its upgrade hint.
2. The typed methods (`search`, `extract`, and the rest) rename every response field to camelCase and keep only the fields they model. The CLI prints the raw snake_case API payload under `--json`, and the Tavily agent skills parse those keys, so the CLI needs a way to make a request and get the body back untouched.

Both additions are useful to any SDK consumer. Neither changes existing public behavior.

## Scope

### 1. `TavilyRequestError`

Add to `src/errors.ts` and export from `src/index.ts`:

```ts
export class TavilyRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly docs?: string;
}
```

`handleRequestError` throws it instead of `Error`. The message is unchanged: `body.detail.error` when that is a string, otherwise `` `${status} Error: ${JSON.stringify(body)}` ``. `docs` is `body.documentation` when it is a string. `TavilyKeylessLimitError` is still thrown only in keyless mode. Set the prototype explicitly, as `TavilyKeylessLimitError` does, so `instanceof` works for ES5 targets.

`TavilyKeylessLimitError` also gains `readonly window: string | null`, read from the envelope's `error.window` when it is a string and `null` otherwise, so the CLI's cap-hit JSON keeps the `window` field the Python CLI emitted.

### 2. `createTransport`

Add `src/transport.ts` and export `createTransport` and the `TavilyTransport` type from `src/index.ts`:

```ts
export type TavilyTransport = {
  post(endpoint: string, body: Record<string, unknown>, opts?: { timeoutSeconds?: number }): Promise<unknown>;
  get(endpoint: string, opts?: { timeoutSeconds?: number; params?: Record<string, unknown> }): Promise<unknown>;
  stream(endpoint: string, body: Record<string, unknown>, opts?: { timeoutSeconds?: number }): Promise<AsyncIterable<Buffer>>;
};

export function createTransport(
  options: TavilyClientOptions & { adapter?: AxiosAdapter }
): TavilyTransport;
```

The transport is the existing `buildHeaders`, `post`, and `get` from `src/utils.ts` made public, plus `stream` for the research streaming path that `src/research.ts` implements inline today. It owns:

- credential resolution (`options.apiKey`, else `TAVILY_API_KEY`, else keyless) and the keyed or keyless header set;
- `X-Session-Id`, `X-Human-Id`, `X-Client-Name`, `X-Project-ID`, `X-Tavily-Orgid`, `Content-Type`, and `X-Client-Source` honoring `options.clientSource` in both keyed and keyless mode (today keyless mode ignores it and always sends `tavily-js-keyless`; keep that as the default when no `clientSource` is given);
- proxies from `options.proxies`, `TAVILY_HTTP_PROXY`, and `TAVILY_HTTPS_PROXY`;
- base URL from `options.apiBaseURL`;
- timeouts, with the same defaults as today (60 s, none for `research` endpoints) and the same `Request timed out after <n> seconds.` message;
- error conversion: `TavilyKeylessLimitError` for a keyless envelope in keyless mode, otherwise `TavilyRequestError`.

`post`, `get`, and `stream` resolve with the parsed response body untouched. The optional `adapter` is passed to axios so consumers can test without a server.

Refactor `search.ts`, `extract.ts`, `crawl.ts`, `map.ts`, `research.ts`, and `feedback.ts` to call the transport, so one header builder and one error path remain. Their public signatures and return types do not change.

## Tests

Add `tests/transport.test.mjs` using an axios adapter stub:

- keyed headers include `Authorization`, `X-Client-Source` (custom `clientSource` honored), `X-Session-Id`, `X-Human-Id`, `X-Client-Name`, `X-Project-ID`, `X-Tavily-Orgid`, `Content-Type`;
- keyless headers include `X-Tavily-Access-Mode: keyless` and no `Authorization`;
- a 432 response with `{ detail: { error: "Plan limit" }, documentation: "https://docs.tavily.com/x" }` rejects with `TavilyRequestError`, `message === "Plan limit"`, `status === 432`, `docs` set;
- a keyless envelope in keyed mode rejects with `TavilyRequestError` status 429; the same envelope in keyless mode rejects with `TavilyKeylessLimitError`;
- `post` returns the raw snake_case body;
- `stream` yields the chunks;
- `client.search()` still returns camelCase (regression).

The existing suite (`npm test`, `npm run test:package`) must pass unchanged.

## Deliverables

- Pull request titled `feat: export createTransport and TavilyRequestError for CLI and MCP consumers`.
- `CHANGELOG.md` entry under 1.1.0 listing both additions.
- Published `@tavily/core` 1.1.0. The CLI pins `^1.1.0`.

## Out of scope

Per-endpoint request-body defaults (extract `timeout: 30`, crawl and map `timeout: 150`, research `stream: false` and `citation_format: "numbered"`) stay inside the typed methods. The CLI reproduces them on its side. Parameter catalogs for endpoints other than Search are a separate piece of work.

## Reference implementation

A working implementation of this brief, built to unblock the CLI, is in `2026-11-02-sdk-transport-export.patch` beside this file. It is three commits on top of `tavily-js` `main` at `7c75755`. Apply it with `git am` on a fresh branch, and review it as a starting point. The CLI's `vendor/tavily-core-1.1.0.tgz` was packed from it.

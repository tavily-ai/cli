# Tavily CLI TypeScript Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python `tvly` CLI with a TypeScript CLI published as `@tavily/cli` that keeps every command, flag, exit code, JSON payload, and config file unchanged.

**Architecture:** A single ESM bundle built by tsup. `program.ts` declares the commander tree and lazy-loads one module per command. Commands call a thin Tavily client built on `@tavily/core`'s transport (or the MCP client for OAuth tokens) and hand raw API JSON to `ui/render.ts`, which prints either sanitized terminal output or `JSON.stringify`. The `search` command's flags are generated from `@tavily/core/parameters`. Credentials live in `~/.tavily/config.json` behind a cross-process lock. Commands throw `ExitError(code)`; `cli.ts` maps it to `process.exit`, the REPL swallows it.

**Tech Stack:** Node 20+, TypeScript 5 strict, `@tavily/core` 1.1+, commander 15, picocolors, marked + marked-terminal, proper-lockfile, tar; tsup, vitest, biome.

**Prerequisite:** Task 4 lands in the `tavily-js` repository and is published as `@tavily/core` 1.1.0. It is handed off to another engineer (brief: `docs/superpowers/plans/2026-11-02-sdk-transport-handoff.md`). Tasks 1 to 3 need nothing from it. Tasks 5 onward develop against `npm link ../tavily-js` on that engineer's branch until 1.1.0 is published; Task 26 cannot complete before it is.

**Spec:** `docs/superpowers/specs/2026-11-02-typescript-rewrite-design.md`. Read it first; this plan argues from it. The Python source at `tavily_cli/` is the reference implementation and stays in the tree until Task 25 so implementers can diff behavior.

## Global Constraints

- `engines.node` is `>=20.1.0` (readdirSync recursive). No API that needs a newer Node.
- Parity baseline is the Python CLI at `origin/main` commit `a673275` (version 0.2.1), which is checked out in this worktree under `tavily_cli/`. Where this plan's text and that source disagree on a Python behavior, the source wins and the ledger records it.
- Package name `@tavily/cli`, bin `tvly`, version `0.3.0`, `"type": "module"`.
- Runtime dependencies are exactly: `@tavily/core`, `commander`, `picocolors`, `marked`, `marked-terminal`, `proper-lockfile`. Adding one requires editing the spec.
- Human output has two modes: styled when `process.stdout.isTTY`, plain text otherwise (spec "Terminal output"). Every renderer implements both.
- The Tavily API is reached only through `createTransport` from `@tavily/core`. No `fetch` or `axios` call to `api.tavily.com` exists in this repository.
- `tsconfig` has `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `module: NodeNext`, `target: ES2022`.
- Every string that came from the network, the filesystem, or another process passes through `sanitizeControl` before a non-JSON print.
- Every `--json` payload has the same keys as the Python CLI's payload for the same situation. Where this plan lists keys, they are copied from the Python source.
- Exit codes: 0 success, 1 local setup/update error, 2 usage, 3 auth or keyless cap or HTTP 429/432 (on both the keyed and OAuth paths; see the spec's deviation note), 4 API error, live-search failure, update-check error.
- Request headers and body defaults the Python SDK added are reproduced (spec "HTTP client"): `Content-Type`, `X-Project-ID` from `TAVILY_PROJECT`, `X-Tavily-Orgid` from `TAVILY_ORG_ID`; `timeout: 30` on extract, `timeout: 150` on crawl and map, `stream: false` and `citation_format: "numbered"` on research, search HTTP timeout capped at 120 s.
- `--version` prints `tavily-cli <version>`.
- Config file keys and `~/.tavily` file modes (dir 0700, files 0600) are unchanged.
- Commands never call `process.exit`. They throw `ExitError`.
- Tests never hit the network or run real `npx`, `ps`, `npm`, or the browser. Inject `fetchImpl` and `spawnImpl`.
- Work on branch `feat/typescript-rewrite`. Commit after each task. Do not push or open a PR until Task 26.

## Review Focus

Inputs the spec implies but no Python test pinned. Each line names its owning task, where a test is added.

1. A `--json` response whose `response_time` is an integer float (Python printed `1.0`, JS prints `1`). Expected: parsers that read numbers work with both; the contract test in Task 24 compares parsed objects, not bytes, and documents this.
2. `tvly search` run with stdout piped and stderr a TTY. Expected: spinner on stderr, clean JSON or text on stdout, no spinner frames in stdout. Task 3 tests that the spinner writes only to the given stream; Task 13 tests that stdout contains only the payload.
3. A config file written by the Python CLI with `expires_at` as a float. Expected: read unchanged and refreshed when expired. Task 9 tests reading a Python-written fixture.
4. `tvly research "status"` wanting to research the word status. Expected: treated as a query (Python rule). Task 15 tests all five normalization cases.
5. Windows paths in `install-detect` (`\\` separators, drive letters). Expected: classification uses forward-slashed, lower-cased realpaths. Task 21 tests a Windows-style path fixture.

---

### Task 1: Project scaffold and `tvly --version`

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `biome.json`, `vitest.config.ts`, `.gitignore` (add `node_modules/`, `dist/`, keep existing entries), `src/version.ts`, `src/errors.ts`, `src/cli.ts`, `src/program.ts`
- Test: `tests/cli.test.ts`, `tests/startup.test.ts`

**Interfaces:**
- Produces: `VERSION: string` (`src/version.ts`, replaced at build by tsup `define` from `package.json`; in tests it reads `package.json`).
- Produces: `class ExitError extends Error { constructor(public code: number) }` and `class OAuthError extends Error` in `src/errors.ts`. API errors use `TavilyRequestError` and `TavilyKeylessLimitError` from `@tavily/core` once Task 5 lands.
- Produces: `buildProgram(): Command` in `src/program.ts` with root options `--version`, `--status`, `--json`, `exitOverride()`, and `main(argv: string[]): Promise<number>` in `src/cli.ts` that returns the exit code (2 for commander usage errors, 1 for unknown throws after printing `  > Error: <message>` to stderr).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/cli.test.ts
test("--version prints name and version", async () => {
  const { stdout, code } = await runCli(["--version"]);   // helper spawns node dist/cli.js
  expect(code).toBe(0);
  expect(stdout.trim()).toBe(`tavily-cli ${VERSION}`);
});
test("--version --json prints {version}", async () => {
  const { stdout } = await runCli(["--version", "--json"]);
  expect(JSON.parse(stdout)).toEqual({ version: VERSION });
});
test("unknown command exits 2", async () => {
  expect((await runCli(["bogus"])).code).toBe(2);
});
// tests/startup.test.ts
test("cold start of --version is under 150ms", async () => { /* median of 5 runs */ });
```

- [ ] **Step 2: Run tests, confirm they fail** (`npx vitest run tests/cli.test.ts`; expected: cannot find `dist/cli.js`)
- [ ] **Step 3: Write `package.json`** with the fields from Global Constraints, `bin: { tvly: "dist/cli.js" }`, `files: ["dist"]`, scripts `build` (tsup), `test` (vitest run), `lint` (biome check), `typecheck` (tsc --noEmit), `prepublishOnly` (lint, typecheck, test, build). Pin dependency versions to the latest release at implementation time.
- [ ] **Step 4: Write `tsup.config.ts`**: entry `src/cli.ts`, format `esm`, `platform: node`, `target: node20`, `banner: { js: "#!/usr/bin/env node" }`, `define: { __VERSION__: JSON.stringify(pkg.version) }`, `splitting: true` so lazy imports become separate chunks, `clean: true`. Mark `marked-terminal` external so it stays lazy.
- [ ] **Step 5: Write `src/errors.ts`, `src/version.ts`, `src/program.ts`, `src/cli.ts`** per Interfaces. `--version` output is `tavily-cli <VERSION>` (keep the Python string). `--status` throws `new Error("not implemented")` until Task 12.
- [ ] **Step 6: Build and run tests** (`npm run build && npx vitest run`; expected: all pass, startup under 150 ms)
- [ ] **Step 7: Commit** `chore: scaffold TypeScript CLI with --version`

### Task 2: Pure utilities: shell words and version compare

**Files:**
- Create: `src/util/shell-words.ts`, `src/util/semver.ts`
- Test: `tests/shell-words.test.ts`, `tests/semver.test.ts`

**Interfaces:**
- Produces: `splitShellWords(line: string): string[]` throwing `Error("No closing quotation")` on an unterminated quote (same message as `shlex`).
- Produces: `compareVersions(a: string, b: string): -1 | 0 | 1` and `isNewer(candidate: string, current: string): boolean` throwing `Error("The installed Tavily CLI version is invalid.")` on an unparsable string.

- [ ] **Step 1: Write failing tests**: `search "two words" --max-results 3` splits to 4 tokens; single quotes keep backslashes; `a\ b` is one token; `"unterminated` throws. Versions: `0.3.0 > 0.2.1`, `1.0.0 > 1.0.0-rc.1`, `1.0.0-rc.2 > 1.0.0-rc.1`, `abc` throws.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement** both modules. Shell words follow POSIX rules for double quotes, single quotes, and backslash outside single quotes, which is what `shlex.split(posix=True)` does.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add shell-word splitter and version comparison`

### Task 3: Terminal primitives: theme, text, spinner

**Files:**
- Create: `src/ui/theme.ts`, `src/ui/text.ts`, `src/ui/spinner.ts`
- Test: `tests/text.test.ts`, `tests/spinner.test.ts`

**Interfaces:**
- Produces (`theme.ts`): `colors` with `aqua`, `pink`, `yellow`, `purple`, `green`, `dim`, `bold` as `(s: string) => string` using the hex values from `theme.py` (`#5CD9E6`, `#FAA2FB`, `#FFC769`, `#8385F9`, `#9BC0AE`); `LOGO: string` (the five-line figlet from `theme.py`, each line in its color); `out(line?: string)` and `err(line?: string)` writers that append `\n`.
- Produces (`text.ts`): `sanitizeControl(value: unknown): string`; `plain(value: unknown): string` (sanitized, runs of three or more blank lines collapsed to one, trimmed); `snippet(content: unknown, maxChars: number): string` (whitespace collapsed to single spaces on one line, cut to `maxChars` plus `...`, `0` keeps it whole); `isTerminal(stream?: NodeJS.WriteStream): boolean` (reads `isTTY`, overridable through `setTerminalOverride(value: boolean | null)` for tests); `safeLink(url: unknown, label?: unknown): string`; `domainOf(url: string): string`; `tree(root: string, nodes: Array<{ label: string; children?: string[] }>): string`; `table(headers: string[], rows: string[][]): string`; `renderMarkdown(markdown: string): Promise<string>` (lazy-imports `marked` and `marked-terminal`, width `min(columns ?? 80, 100)`); `terminalWidth(stream: NodeJS.WriteStream): number`.
- Produces (`spinner.ts`): `spinner(message: string, opts: { enabled: boolean; stream?: NodeJS.WriteStream }): { update(message: string): void; stop(): void }` and `withSpinner<T>(message, opts, fn: () => Promise<T>): Promise<T>`. `enabled` is false in JSON mode or when the stream is not a TTY.

- [ ] **Step 1: Write failing tests**: `sanitizeControl("a\x1b[2Jb\tc")` is `"ab\tc"`; `plain("a\n\n\n\nb")` is `"a\n\nb"`; `snippet("Personal bests\n\n10,000m" + " passage".repeat(120), 600)` is one line of length 603 ending in `...`; `snippet("x y", 0)` is `"x y"`; `safeLink("javascript:alert(1)")` returns plain text with no `\x1b]8`; `safeLink("https://x.io", "x")` with a fake TTY stream contains `\x1b]8;;https://x.io\x1b\\x\x1b]8;;\x1b\\`; `tree` output for two nodes matches a literal; spinner with a fake non-TTY stream writes nothing and `withSpinner` still returns `fn`'s value; spinner with a fake TTY stream writes frames to that stream only.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** True-color detection: `COLORTERM` is `truecolor` or `24bit` → `\x1b[38;2;r;g;bm`; otherwise map to the nearest 6x6x6 cube index. Wrap all color output in `picocolors.isColorSupported` so `NO_COLOR` disables it.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add terminal theme, text sanitization, and spinner`

### Task 4: SDK prerequisite in `tavily-js`: typed request error and transport export

**Handed off.** Another engineer owns this task; the self-contained brief is `docs/superpowers/plans/2026-11-02-sdk-transport-handoff.md`. The CLI implementer does not execute the steps below. They are kept here so the interfaces Tasks 5, 6, and 11 consume are visible in one place. Until `@tavily/core` 1.1.0 is on npm, Tasks 5 onward run against a local build of the SDK branch through `npm link ../tavily-js`, and Task 26 replaces the link with the published pin before release.

This task is a pull request against `/Users/guyhartstein/Desktop/tavily/tavily-js` on a branch `feat/transport-export`, released as `@tavily/core` 1.1.0. It follows that repository's conventions (`node --test`, tsup, CHANGELOG entry).

**Files (in tavily-js):**
- Create: `src/transport.ts`
- Modify: `src/errors.ts` (add `TavilyRequestError`), `src/utils.ts` (`handleRequestError` throws it; `post`, `get`, `buildHeaders` move to or are re-exported from `transport.ts`), `src/index.ts` (export `createTransport`, `TavilyRequestError`, `TavilyTransport`), `tsup.config.ts` (no new entry; it ships from the main entry), `CHANGELOG.md`, `package.json` (version 1.1.0)
- Test: `tests/transport.test.mjs`

**Interfaces:**
- Produces: `class TavilyRequestError extends Error { readonly status: number; readonly body: unknown; readonly docs?: string }`. Message is `body.detail.error` when it is a string, else `` `${status} Error: ${JSON.stringify(body)}` ``. `docs` is `body.documentation` when it is a string.
- Produces: `type TavilyTransport = { post(endpoint: string, body: Record<string, unknown>, opts?: { timeoutSeconds?: number }): Promise<unknown>; get(endpoint: string, opts?: { timeoutSeconds?: number; params?: Record<string, unknown> }): Promise<unknown>; stream(endpoint: string, body: Record<string, unknown>, opts?: { timeoutSeconds?: number }): Promise<AsyncIterable<Buffer>> }` and `createTransport(options: TavilyClientOptions & { fetchAdapter?: AxiosAdapter }): TavilyTransport`. The `fetchAdapter` hook exists so the CLI's tests can stub HTTP without a server. Keyless mode is `!options.apiKey` and env `TAVILY_API_KEY` is read as the factory does today. Timeouts: `post` and `get` default 60 s except `research` endpoints, which default to none; a timeout rejects with `Error("Request timed out after <n> seconds.")` as today.
- `post`, `get`, and `stream` resolve with the parsed body untouched. On a non-2xx response they throw `TavilyKeylessLimitError` for a keyless envelope in keyless mode, otherwise `TavilyRequestError`.

- [ ] **Step 1: Write failing tests** in `tests/transport.test.mjs` using an axios adapter stub: keyed headers include `Authorization`, `X-Client-Source` (custom `clientSource` honored), `X-Session-Id`, `X-Human-Id`, `X-Client-Name`, `X-Project-ID`, `X-Tavily-Orgid`, `Content-Type`; keyless headers include `X-Tavily-Access-Mode: keyless` and no `Authorization`; 432 with `{detail:{error:"Plan limit"},documentation:"https://docs.tavily.com/x"}` rejects with `TavilyRequestError` whose `message === "Plan limit"`, `status === 432`, `docs` set; a keyless envelope in keyed mode rejects with `TavilyRequestError` status 429; the same envelope in keyless mode rejects with `TavilyKeylessLimitError`; `post` returns the raw snake_case body; `stream` yields the chunks; existing `client.search()` still returns camelCase (regression).
- [ ] **Step 2: Run, confirm fail** (`npm test`)
- [ ] **Step 3: Implement.** `search.ts`, `extract.ts`, `crawl.ts`, `map.ts`, `research.ts`, and `feedback.ts` call the transport instead of `post`/`get` directly, so one header builder and one error path remain. Public return types of the typed methods do not change.
- [ ] **Step 4: Run the full SDK suite, confirm pass** (`npm test` and `npm run test:package`)
- [ ] **Step 5: Commit** `feat: export transport and typed request errors` and open the PR titled `feat: export createTransport and TavilyRequestError for CLI and MCP consumers`. Publish 1.1.0 after review. Until then, the CLI repo uses `npm link`.

### Task 5: Tavily API client on the SDK transport

**Files:**
- Create: `src/core/tavily-client.ts`, `src/core/sse.ts`
- Test: `tests/tavily-client.test.ts`

**Interfaces:**
- Consumes: `createTransport`, `TavilyRequestError`, `TavilyKeylessLimitError` from `@tavily/core`.
- Produces: `interface TavilyClientLike { search(body): Promise<Json>; extract(body): Promise<Json>; crawl(body): Promise<Json>; map(body): Promise<Json>; research(body): Promise<Json>; researchStream(body): Promise<AsyncIterable<string>>; getResearch(requestId: string): Promise<Json> }` where `Json = Record<string, unknown>` and `body` is `Record<string, unknown>` in snake_case.
- Produces: `createTavilyClient(opts: { apiKey?: string; sessionId: string; humanId?: string; clientName?: string; apiBaseUrl?: string; env?: NodeJS.ProcessEnv; transport?: TavilyTransport }): TavilyClientLike` (the `transport` parameter is how tests inject a stub).
- Produces (`sse.ts`): `sseDataLines(chunks: AsyncIterable<Buffer | string>): AsyncIterable<string>` yielding the payload after each `data:` prefix, buffering partial lines across chunks.
- Errors: `src/errors.ts` from Task 1 drops its own `TavilyAPIError` and `TavilyKeylessLimitError` in favor of the SDK's `TavilyRequestError` and `TavilyKeylessLimitError`; `ExitError` and `OAuthError` stay. Update Task 1's file accordingly in this task. The MCP client (Task 6) throws `TavilyRequestError` too, constructed with the status and docs from the parsed payload.

- [ ] **Step 1: Write failing tests** with a stub transport that records calls: `clientSource` is `tavily-cli` with a key and `tavily-cli-keyless` without; `apiBaseUrl` with a trailing slash is trimmed and passed as `apiBaseURL`; keyless `crawl` rejects with an error whose message starts with `crawl: Keyless mode only supports search and extract`; `extract({urls})` sends `timeout: 30`, `crawl({url})` and `map({url})` send `timeout: 150`, `research({input})` sends `stream: false` and `citation_format: "numbered"`, and each is overridden when the body already has the key; `search` with `timeout: 500` passes `timeoutSeconds: 120`; `getResearch("abc")` calls `get("research/abc")`; `researchStream` wraps `transport.stream("research", {..., stream: true})`; `sseDataLines` reassembles `"data: {\"a\":1}\n"` split across two chunks.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** When `body.timeout` is a number it is also the HTTP timeout for extract, crawl, map, and search (search capped at 120).
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add raw-JSON Tavily client on the SDK transport`

### Task 6: MCP client

**Files:**
- Create: `src/core/mcp-client.ts`
- Test: `tests/mcp-client.test.ts`

**Interfaces:**
- Produces: `createMcpClient(opts: { token: string; sessionId: string; humanId?: string; clientName?: string; fetchImpl?: typeof fetch }): TavilyClientLike`. `researchStream` rejects with `TavilyRequestError` (status 0, message `Streaming is not available with OAuth credentials; use an API key.`) (Python passed `stream: true` through to the MCP tool, which does not stream; this makes the limitation explicit).

- [ ] **Step 1: Write failing tests** ported from the Python behavior: request body is `{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"tavily_search",arguments}}`; headers include `mcp-session-id` and `X-Session-Id` equal to the session id and `Accept: application/json, text/event-stream`; an SSE body with `structuredContent` returns it; an SSE body with `content[0].text` JSON returns the parsed object; non-JSON text returns `{raw: text}`; a parsed result containing `error` throws `TavilyRequestError` with `status` and `docs` from the payload; a JSON-RPC `error` throws with its `message`.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement** with a 180 s timeout and tool names `tavily_search`, `tavily_extract`, `tavily_crawl`, `tavily_map`, `tavily_research`, `tavily_get_research`.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add MCP client for OAuth credentials`

### Task 7: Session id

**Files:**
- Create: `src/core/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Produces: `resolveSessionId(opts: { configDir: string; ppid: number; gppid: () => number | null; pidAlive: (pid: number) => boolean }): string` (pure given its inputs; `gppid` is a thunk called only when the ppid lookup misses) and `getSessionId(): string` which wires `process.ppid`, `grandparentPid`, and `pidAlive` and falls back to a fresh uuid on any throw.
- Produces: `grandparentPid(ppid: number, opts?: { spawnSync?: typeof child_process.spawnSync; platform?: NodeJS.Platform; readFile?: (p: string) => string }): number | null`.

- [ ] **Step 1: Write failing tests** with a temp config dir: returns the stored id for a known ppid without calling `gppid`; returns the stored id for a known live gppid; mints a new id, writes it under both pids, and prunes a dead pid; `grandparentPid` parses `/proc/<pid>/stat` on linux (`"1234 (node) S 42 ..."` → 42), `ps` output on darwin, and the PowerShell `Get-CimInstance` output on win32 through the injected `spawnSync`; returns `null` when the spawn fails.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** The session file is written with mode 0600 inside a 0700 directory. `pidAlive` is `process.kill(pid, 0)` returning true, or true on `EPERM`, false on `ESRCH`.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add terminal session id resolution`

### Task 8: OAuth protocol functions

**Files:**
- Create: `src/core/oauth.ts` (protocol half; the browser flow comes in Task 11)
- Test: `tests/oauth.test.ts`

**Interfaces:**
- Produces: types `OAuthMetadata`, `RegisteredClient`, `OAuthTokens`, `OAuthSession` with the field names from `oauth.py` in camelCase (`authorizationEndpoint`, `clientId`, `tokenEndpointAuthMethod`, `redirectUri`, `accessToken`, `refreshToken`, `expiresAt`, `tokenType`).
- Produces: `generatePkce(): { verifier: string; challenge: string }`, `expiresAtFromNow(expiresIn: unknown, now?: number): number`, `tokenIsExpired(expiresAt: unknown, now?: number): boolean`, `fetchMetadata(fetchImpl?): Promise<OAuthMetadata>`, `registerClient(metadata, redirectUri, fetchImpl?): Promise<RegisteredClient>`, `buildAuthorizeUrl(metadata, client, { state, codeChallenge }): string`, `exchangeCode(metadata, client, { code, codeVerifier }, fetchImpl?): Promise<OAuthTokens>`, `refreshTokens(metadata, client, refreshToken, fetchImpl?): Promise<OAuthTokens>`, `revokeToken(metadata, client, token, { tokenTypeHint }, fetchImpl?): Promise<void>`, `looksHeadless(env?: NodeJS.ProcessEnv, platform?: string): boolean`.
- Constants copied from `oauth.py`: issuer, resource, metadata URLs, scopes `openid offline_access`, client name `Tavily CLI`, 180 s login timeout, 30 s HTTP timeout, 60 s expiry skew.

- [ ] **Step 1: Port the Python tests** `test_pkce_is_s256_and_unpadded`, `test_token_expiry_skew`, `test_malformed_token_expiry_is_expired`, `test_authorize_url_includes_pkce_and_resource`, `test_register_client_public_pkce`, `test_register_client_rejects_http_errors`, `test_register_client_normalizes_malformed_success_responses`, `test_register_client_rejects_invalid_confidential_client_secret`, `test_fetch_metadata_uses_discovery`, `test_fetch_metadata_rejects_untrusted_authorization_metadata`, `test_fetch_metadata_rejects_different_protected_resource`, `test_refresh_tokens_keeps_refresh_if_omitted`, `test_token_request_normalizes_malformed_success_responses`, `test_revoke_public_client_uses_standard_request_first`, `test_revoke_public_client_retries_known_400_with_empty_secret`, `test_revoke_token_raises_after_failed_compatibility_retry`. Keep the Python assertions and error strings.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement** with `node:crypto` and the `request` function from Task 4. Token and revoke bodies are `application/x-www-form-urlencoded`; `client_secret_basic` uses an `Authorization: Basic` header.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: port OAuth discovery, registration, token, and revocation`

### Task 9: Config store and credential resolution

**Files:**
- Create: `src/core/config.ts`
- Test: `tests/config.test.ts`, fixture `tests/fixtures/config-python-written.json` (an `oauth` block with a float `expires_at`, copied from a real Python-written file with the secrets replaced)

**Interfaces:**
- Produces: `configPaths(home?: string): { dir; file; sessionFile; mcpAuthDir }`; `readConfig(): Config`; `withConfigLock<T>(fn: (config: Config) => Promise<{ config?: Config; result: T }>): Promise<T>` (writes `config` atomically when returned, deletes the file when the returned config is empty); `saveApiKey(key)`, `saveOauthSession(session)`, `saveRefreshedOauthSession(session)`, `clearCredentials(): Promise<ClearCredentialsResult>` with fields `localCredentialsCleared`, `serverRevoked: boolean | null`, `revocationError?: string`; `hasStoredOauth()`, `getHumanId()`, `getApiBaseUrl()`, `getApiKey(): Promise<string | null>`, `isOauthToken(key): boolean`, `decodeJwtPayload(token)`.
- Consumes: Task 8 functions for refresh and revoke.

- [ ] **Step 1: Port the Python tests** `test_stored_oauth_revokes_refresh_before_access`, `test_clear_credentials_reports_revocation_failure_but_clears_disk`, `test_save_api_key_keeps_previous_oauth_when_revocation_fails`, `test_save_oauth_session_revokes_previous_before_overwrite`, `test_save_oauth_session_keeps_previous_and_cleans_replacement_on_failure`, `test_malformed_expiry_refreshes_without_revoking_active_session`, `test_malformed_expiry_without_refresh_is_invalid`, `test_config_write_keeps_previous_file_when_atomic_replace_fails`, `test_parallel_expired_session_refreshes_once` (two concurrent `getApiKey` calls, one refresh request), `test_config_lock_serializes_separate_processes` (two child `node` processes appending through `withConfigLock`), `test_refresh_failure_is_reported_and_preserves_session`, `test_api_key_and_oauth_replace_each_other`. Add: reading the Python-written fixture returns its `access_token` while unexpired; file mode after write is 0600 and dir 0700 on non-Windows.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement** with `proper-lockfile` (`lockfilePath: <dir>/.config.lock`, `stale: 30000`, `retries: { retries: 50, minTimeout: 20 }`). The path differs from Python's `.config.json.lock` on purpose; add a test that a pre-existing 0-byte `.config.json.lock` file does not block writes. The OAuth refresh error message is the Python one verbatim (starts `Could not refresh the stored Tavily OAuth session.`).
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: port credential store with locked atomic writes`

### Task 10: Browser login flow

**Files:**
- Modify: `src/core/oauth.ts` (add `runBrowserLogin`, `openBrowser`, `callbackHtml`)
- Test: `tests/oauth-login.test.ts`

**Interfaces:**
- Produces: `runBrowserLogin(opts: { openBrowser: boolean; timeoutSeconds?: number; onStatus?: (url: string) => void; fetchImpl?; openImpl?: (url: string) => void }): Promise<OAuthSession>`; `openBrowser(url: string, spawnImpl?): void`.

- [ ] **Step 1: Write failing tests**: the test stubs `fetchImpl` for metadata, registration, and token exchange, captures the authorize URL through `onStatus`, extracts `state` and the port from it, and performs a real `GET http://127.0.0.1:<port>/callback?code=abc&state=<state>`; asserts the returned session's `accessToken` and that the callback response is HTTP 200 HTML. A second test sends a mismatched `state` and expects `OAuthError("OAuth state mismatch; aborting to prevent CSRF.")`. A third sends `error=access_denied` and expects `Authorization was denied: access_denied`. A fourth uses `timeoutSeconds: 0.1` and expects the timeout message. `openBrowser` on darwin spawns `open <url>`, on linux `xdg-open`, on win32 `cmd /c start "" <url>`.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** Server closes in `finally`. Non-`/callback` paths get 404.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add PKCE browser login with local callback server`

### Task 11: Client factory and shared command helpers

**Files:**
- Create: `src/core/client-factory.ts`, `src/ui/keyless.ts`, `src/commands/shared.ts`
- Test: `tests/keyless.test.ts`, `tests/shared.test.ts`

**Interfaces:**
- Produces (`client-factory.ts`): `getClient(opts: { clientName?: string; json: boolean }): Promise<TavilyClientLike>` (prints the Python "No Tavily API key found" block and throws `ExitError(3)` when no key); `getClientOrKeyless(opts: { clientName?: string }): Promise<{ client: TavilyClientLike; keyless: boolean }>`; `requireApiKeyFriendly(commandName: string, opts: { json: boolean }): Promise<string>`; `authSource(key: string): "TAVILY_API_KEY" | "OAuth (tvly login)" | "API key"`.
- Produces (`keyless.ts`): `formatKeylessEnvelopeForTerminal(opts: { message?: string; retryAfterSeconds?: number; nextActions?: unknown[] }): string` and `formatSeconds(n: number): string`.
- Produces (`shared.ts`): `handleApiError(e: unknown, json: boolean): never` (JSON: `{error: message}` then exit 4; a `TavilyRequestError` with status 429 or 432 prints the upgrade block and exits 3); `handleKeylessCapHit(e: TavilyKeylessLimitError, json): never` (JSON keys `error.code` from `capType`, `message`, `window` from the envelope if the SDK exposes it else omitted, `retry_after_seconds` from `retryAfter`, `next_actions` from `continuationPaths`, exit 3); `handleOauthRefreshError(e, json): never` (JSON `{error:{code:"oauth_refresh_failed",message}}`, exit 3); `runWithApiErrors<T>(json, fn)` which catches in the order keyless, OAuth, other; `keylessCapError(e: TavilyKeylessLimitError): { code; message; window?; retry_after_seconds; next_actions }` (the payload `handleKeylessCapHit` wraps in `{error}`); `printKeylessCapHit(e)` (the stderr block without exiting); `resolveJson(cmd: Command): boolean`; `addClientNameOption(cmd)` which reads `--client-name` with env fallback `TAVILY_CLIENT_NAME`; `addOutputOption(cmd)` for `-o, --output [file]` (optional value; bare flag yields `""`); `splitCsv(value?: string): string[] | undefined`;
- Produces (`src/ui/output-file.ts`): `resolveOutput(outputFile: string | undefined, command: string, label: unknown, now?: Date, random?: () => string): string | undefined` per the spec (`""` becomes `.tavily/<command>-<slug>-<HHMMSS>-<6 hex>.json`; anything else passes through); `DEFAULT_OUTPUT_DIR = ".tavily"`. `readQueryArg(query: string | undefined): string` (reads up to 100,000 chars from stdin for `-`, throws commander `InvalidArgumentError("QUERY is required. Pass a query string or use '-' to read from stdin.")` when empty).

- [ ] **Step 1: Write failing tests**: `formatSeconds` for 45, 90, 3600, 90000; the envelope block with signup, payment, and bonus actions matches the Python layout line by line; `handleApiError` in JSON mode writes `{"error":"..."}` and throws `ExitError(4)`; a `TavilyRequestError` with status 432 throws `ExitError(3)`; `--client-name` flag beats `TAVILY_CLIENT_NAME`, env is used when the flag is absent, neither yields `undefined` (port of `test_client_name_reads_environment`); `resolveOutput("", "search", "Rust 2024 edition")` matches `/^\.tavily\/search-rust-2024-edition-\d{6}-[0-9a-f]{6}\.json$/` and two calls differ (port of `test_generated_names_differ_within_the_same_second`); `resolveOutput("out.json", ...)` is `out.json`; `resolveOutput(undefined, ...)` is `undefined`; a label with no alphanumerics slugs to `result`.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** The client factory picks `createMcpClient` when `isOauthToken(key)`, else `createTavilyClient`.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add client factory, keyless rendering, and shared error handlers`

### Task 12: Program tree, `--status`, lazy loading

**Files:**
- Modify: `src/program.ts`, `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Produces: `buildProgram()` registers every command name from the spec's command surface with its help text copied from the Click docstrings, each action doing `const m = await import("./commands/<name>.js"); await m.run(args, opts, cmd)`. Command modules export `run`. Root with no subcommand lazy-loads `./repl.js`.
- Produces: `printStatus(json: boolean): Promise<void>` with JSON `{version, authenticated}`.

- [ ] **Step 1: Write failing tests**: `--status --json` with `TAVILY_API_KEY=tvly-x` in the child env gives `{version, authenticated: true}`; `--help` lists all 12 commands (`init login logout auth search extract crawl map research update set-default unset-default`) and the line `First-time setup: tvly init`; the built `dist/cli.js` does not contain the string `marked-terminal` (the renderer lives in a lazily imported chunk).
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** Commands not yet written throw `Error("not implemented")` from a stub module so the tree is complete now.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: wire the full command tree with lazy loading`

### Task 13: Search flags from the SDK catalog, renderers, and the search and extract commands

**Files:**
- Create: `src/core/search-flags.ts`, `src/ui/render.ts` (`emit`, `printSearchResults`, `printExtractResults`, `footer`), `src/commands/search.ts`, `src/commands/extract.ts`
- Test: `tests/search-flags.test.ts`, `tests/render.test.ts`, `tests/search.test.ts`, `tests/extract.test.ts`, fixtures `tests/fixtures/search.json`, `tests/fixtures/extract.json`

**Interfaces:**
- Consumes: `searchParameters` and `ParameterDefinition` from `@tavily/core/parameters`.
- Produces (`search-flags.ts`): `const SEARCH_FLAG_OVERRIDES: Partial<Record<keyof typeof searchParameters, { flag?: string; positional?: true; bareValue?: string }>>` with `query: { positional: true }`, `searchDepth: { flag: "depth" }`, `includeAnswer: { bareValue: "basic" }`, `includeRawContent: { bareValue: "markdown" }`; `searchFlagSpecs(): SearchFlagSpec[]` where `SearchFlagSpec = { key: keyof typeof searchParameters; apiName: string; flags: string; description: string; parse: (raw: string | true) => unknown; choices?: readonly string[] }`; `applySearchFlags(cmd: Command): Command`; `searchBodyFromOptions(opts: Record<string, unknown>): Record<string, unknown>` which emits snake_case keys only for options that were set. Conversion rules: `string` with `enum` → choices; `integer`/`number` → `parseFloat` with the catalog bounds enforced through `InvalidArgumentError`; `array` → comma split and trim; `boolean` → flag; `["boolean","string"]` → optional-value flag whose bare form is `bareValue`. `apiName` is the camelCase key converted with the same regex the SDK uses in `serializeSearchParameters`.
- Produces (`render.ts`): `emit(data: unknown, opts: { outputFile?: string; pretty: boolean }): void` (creates the file's folder when missing, writes `.gitignore` containing `*` into a newly created folder whose basename is `.tavily`, writes `Output saved to <file>` to stderr); `printSearchResults(data, { json, outputFile, maxChars })`; `printMultiSearchResults(responses, { json, outputFile, maxChars })`; `printExtractResults(data, { json, outputFile })`; `echoPages(pages)` (plain `# <url>` blocks). Each renderer follows the spec's terminal and plain rules; the plain search output is `Answer: ...`, then `<n>. <title>`, `<url>`, `<snippet>`, blank line, then `Image: <url>` lines, `No results found.` when empty. With `outputFile` set at a terminal, search only saves; when not a terminal it saves and prints.
- Search positional `queries...` (1 to 5; `-` alone reads one query from stdin; blank queries dropped; usage errors `QUERY is required. Pass a query string or use '-' to read from stdin.` and `At most 5 queries per command, got <n>.`). Fixed options after the generated ones: `--max-chars <n>` (integer ≥ 0; default `Math.floor(600 / queries.length)`), `-o, --output [file]`, `--client-name`, `--json`.
- Multi-query behavior from `search.py` 0.2.1: resolve the client once, run all queries concurrently with `Promise.all`, each failure becomes `{query, error}` where a keyless cap error's `error` is `keylessCapError(e)` and any other error's is its message; print through `printMultiSearchResults`; after printing, if any cap hit and not JSON, `printKeylessCapHit(first)`; if every query failed, exit 3 when any was a cap hit else 4. Single query keeps the 0.1.9 path with `maxChars` passed through.
- Extract flags (hand-written until the SDK publishes an extract catalog): positional `urls...` (max 20, usage error `Maximum 20 URLs per request.`), `--query`, `--chunks-per-source`, `--extract-depth`, `--format`, `--include-images`, `--timeout <float>`, `-o [file]` (label is the first URL's host), `--client-name`, `--json`.

- [ ] **Step 1: Write failing tests** (`search-flags.test.ts`): every key of `searchParameters` except `query` produces exactly one spec; `searchDepth` yields `--depth <value>` with choices `basic advanced fast ultra-fast`; `maxResults` yields `--max-results <n>` and rejects `21` with a message containing `maximum 20`; `includeDomains` parses `a.com, b.com` to `["a.com","b.com"]`; `includeAnswer` bare yields `"basic"` and `--include-answer advanced` yields `"advanced"`; `safeSearch` (a catalog-only key) yields `--safe-search`; generated flag names are unique and none equals `output`, `client-name`, or `json`; `searchBodyFromOptions({ searchDepth: "fast", maxResults: 3 })` is `{ search_depth: "fast", max_results: 3 }` with no other keys. Then (`search.test.ts`, `extract.test.ts`, `render.test.ts`), porting `tests/test_output.py` from the worktree: `search "q" --json` with a stubbed client posts `{query:"q"}` only and prints the fixture pretty-printed; a keyless cap error exits 3 with the JSON envelope; `extract` with 21 URLs exits 2; terminal-mode search shows the full URL on one line; plain-mode search prints `Answer:` first, then `1. Tegla`, the full URL, and a 603-char one-line snippet with the ESC byte stripped (`test_piped_search_prints_full_urls_and_snippets`); plain-mode extract starts with `# https://x.example/p\n\n# Title` keeping markdown links and the whole 4000-char body and ends with `Failed: https://y.example: timeout\n`; `search one two --depth advanced` calls the client twice with `search_depth: "advanced"` and prints `=== [1/2] one` then `1. T one` then `=== [2/2] two`; `search ok capped --json` where `capped` throws a keyless error prints a two-element list whose second has `error.code`, `error.retry_after_seconds`, `error.next_actions`; `search capped capped` exits 3 and mentions `tvly login`; `search "Rust 2024 edition" -o` in a temp cwd writes one `.tavily/search-rust-2024-edition-*.json` with results, writes `.tavily/.gitignore` as `*\n`, and still prints `1. T Rust 2024 edition` when stdout is not a terminal; `search q -o out.json` writes `out.json` and creates no `.tavily`; in human mode with stdout captured, stdout has no spinner frames.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** Spinner messages: `Searching...`, `Extracting <n> URL(s)...`. Terminal extract shows the first 3000 chars of `raw_content` as markdown; plain extract shows every page whole. Flag order in `--help`: the Python flags first in their Python order, then the catalog-only flags alphabetically, so existing users see a familiar top of the list.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add search and extract commands`

### Task 14: Crawl and map

**Files:**
- Create: `src/commands/crawl.ts`, `src/commands/map.ts`
- Modify: `src/ui/render.ts` (`printCrawlResults`, `saveCrawlToDir`, `printMapResults`)
- Test: `tests/crawl-map.test.ts`, fixtures `tests/fixtures/crawl.json`, `tests/fixtures/map.json`

**Interfaces:**
- Crawl flags from `crawl.py`: `--max-depth`, `--max-breadth`, `--limit`, `--instructions`, `--chunks-per-source`, `--extract-depth`, `--format`, `--select-paths`, `--exclude-paths`, `--select-domains`, `--exclude-domains`, `--allow-external` / `--no-external` (tri-state: unset sends nothing), `--include-images`, `--timeout`, `-o [file]` (label is the URL host), `--output-dir`, `--client-name`, `--json`. Map flags are the same minus chunks, extract-depth, format, include-images, output-dir.
- Plain mode: crawl prints each page through `echoPages`; map prints one URL per line (`test_piped_map_crawl_and_research`).
- `saveCrawlToDir(data, dir)` writes `<slug>.md` per page where slug is `netloc + path` with `[^\w\-.]` replaced by `_`, trimmed of `_`, defaulting to `index`, and prints `Saved <n> pages to <dir>/` to stderr.

- [ ] **Step 1: Write failing tests**: both commands exit 3 with the "requires a Tavily API key" message when no key; `--no-external` sends `allow_external: false`, omission sends nothing; `--output-dir` writes the expected filenames into a temp dir; terminal map output is a tree whose first line is the base URL; plain map output for two URLs is exactly the two URLs joined by newlines; plain crawl output for one page is `# https://a.example/1\n\nbody\n\n`.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** Spinner messages `Crawling <url>...` and `Mapping <url>...`.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add crawl and map commands`

### Task 15: Research (run, status, poll, stream)

**Files:**
- Create: `src/commands/research.ts`
- Modify: `src/ui/render.ts` (`printResearchResult`), `src/program.ts` (apply `normalizeResearchArgs` to the argv slice after `research`)
- Test: `tests/research.test.ts`, fixture `tests/fixtures/research-stream.sse`

**Interfaces:**
- Produces: `normalizeResearchArgs(args: string[]): string[]`.
- Run flags from `research.py`: positional `query` (`-` reads stdin), `--model` (`mini pro auto`), `--no-wait`, `--stream`, `--output-schema <file>`, `--citation-format` (`numbered mla apa chicago`), `-o [file]` (label is the query), `--poll-interval <int>` default 10, `--timeout <int>` default 600, `--json`, `--client-name`. Status: positional `request_id`, `--json`, `--client-name`. Poll: `request_id`, `--poll-interval`, `--timeout`, `-o [file]` (label is the request id), `--json`, `--client-name`.
- Plain mode for a completed result prints the content, a blank line, `Sources:`, and `<n>. <title> <url>` lines (`test_piped_map_crawl_and_research`).
- Behavior copied from Python: if the first response has `status` in `completed|failed` or has `content`, print it; else require `request_id`; `--no-wait` emits `{request_id, status}`; polling sleeps `poll_interval` in JSON mode and ticks every second with an elapsed-time spinner otherwise; timeout emits `{request_id, status:"timeout"}` in JSON mode or the yellow `Timed out after <n>s. Resume with: tvly research poll <id>` line.
- Stream: JSON mode re-emits each SSE event as one JSON line; human mode prints tool-call steps dimmed to stderr, `Found <n> sources` on `WebSearch` responses, and renders the joined content as a completed report.

- [ ] **Step 1: Write failing tests**: `normalizeResearchArgs(["what is x"])` → `["run","what is x"]`; `["status"]` → `["run","status"]`; `["status","--help"]` unchanged; `["status","abc"]` unchanged; `["run","run"]` unchanged. Run with a client returning `{request_id:"r1",status:"pending"}` then `{status:"completed",content:"# Hi",sources:[]}` with `--poll-interval 0 --json` prints the completed payload; `--no-wait --json` prints `{"request_id":"r1","status":"pending"}`; stream JSON mode converts the fixture into one line per event; `--timeout 0` emits the timeout payload. Use fake timers for the sleep.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** Sleep is `setTimeout` wrapped in a promise, injected for tests.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add research run, status, poll, and streaming`

### Task 16: Removed

The `feedback` command was deleted from the Python CLI in 0.2.0 (commit `12434bf`) and is not ported. The number is kept so later task references stay valid.

### Task 17: Login, logout, auth

**Files:**
- Create: `src/commands/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- `login` flags: `--api-key`, `--no-browser`, `--json`. `logout` and `auth`: `--json`.
- JSON payloads copied from `auth.py`: login success `{authenticated:true, method:"oauth"|"api_key", detail}`; login failure `{authenticated:false, error}`; headless JSON login emits `{event:"authorization_required", authorization_url}` on stderr; logout `{authenticated, method, source, local_credentials_cleared, environment_credential_present, warning?, server_revoked?, error?}`; auth `{authenticated, method, source}` with `method` in `env|oauth|oauth_legacy|api_key|null` and the three `source` strings from `_effective_auth_state`.

- [ ] **Step 1: Port the Python tests** `test_logout_json_reports_partial_revocation_failure`, `test_logout_json_reports_remaining_environment_credential`, `test_logout_json_reports_unauthenticated_after_cleanup`, `test_json_headless_login_emits_authorization_url_on_stderr`, `test_json_browser_login_keeps_stderr_empty`, `test_api_key_login_json_reports_replacement_revocation_failure`, `test_oauth_login_json_reports_replacement_revocation_failure`, `test_search_json_reports_refresh_failure_without_keyless_fallback`. Add: `auth` human output masks the key as first 8 + `...` + last 4.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** Human login success prints the logo and the five "Get started" lines.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add login, logout, and auth commands`

### Task 18: Agent defaults

**Files:**
- Create: `src/core/agent-defaults.ts`, `src/commands/defaults.ts`
- Test: `tests/defaults.test.ts`

**Interfaces:**
- Produces: `claudeSettingsPath(project: boolean, env?, cwd?): string`, `codexConfigPath(...)`, `setClaudeDefault(path): boolean`, `unsetClaudeDefault(path): boolean`, `setCodexDefault(path): boolean`, `unsetCodexDefault(path): boolean`, each returning whether the file changed, with the Python error messages for invalid JSON and wrong shapes thrown as commander `CommanderError`-compatible usage errors (exit 2).
- Commands `set-default` and `unset-default` with `--claude`, `--codex`, `--project`, `--json`; JSON `{ok:true, results:[{agent,label,scope,path,changed}]}`; the non-interactive usage error `Pass --claude and/or --codex in non-interactive runs.`

- [ ] **Step 1: Port the nine Python tests** from `test_defaults.py`, driving the prompt through an injected `confirm` function.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add set-default and unset-default`

### Task 19: Skills installer

**Files:**
- Create: `src/core/skills.ts`
- Test: `tests/skills.test.ts`, fixture `tests/fixtures/skills.tar.gz` built by a test helper from a temp tree (so the fixture carries no checked-in binary)

**Interfaces:**
- Produces: constants `SKILLS_REPO = "tavily-ai/skills"`, `NPX_SKILLS_PACKAGE = "skills@1.7.4"`, `NPX_TIMEOUT_MS = 300_000`.
- Produces: `agentSpecs(opts?: { home?: string; env?: NodeJS.ProcessEnv }): Record<"claude-code" | "codex" | "cursor", { marker: string; skillsDir: string }>`; `detectAgents(opts?)`; `installAgentSkills(agents: string[], deps?: { home?; env?; which?; spawnImpl? }): Promise<SkillsInstallResult>` with `SkillsInstallResult = { agents: string[]; restartRequired: boolean }`; `snapshotSkills(skillDirs: string[]): Map<string, string>` and `directoryDigest(path: string): string` (SHA-256 over sorted regular files: 4-byte big-endian length of the relative POSIX path, the path, 8-byte length of the content, the content).
- Error messages verbatim from the spec's "Skills installation".

- [ ] **Step 1: Port the Python tests** from the worktree's `tests/test_init.py`: `test_detect_agents_only_returns_existing_markers`, `test_detect_agents_honors_custom_agent_directories` (`CLAUDE_CONFIG_DIR` and `CODEX_HOME`), `test_agent_skills_install_runs_npx` (asserts the exact argv `[npx, "--yes", "skills@1.7.4", "add", "tavily-ai/skills", "--skill", "*", "--global", "--agent", ...agents, "--yes"]` and stdin ignored), `test_agent_skills_install_counts_new_agent_links` (a new directory under an agent's skills dir flips `restartRequired`), `test_agent_skills_install_requires_npx`, `test_agent_skills_install_reports_npx_failure` (last stderr line in the message).
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** `npx` runs through an injectable `spawnImpl` with `stdio: ["ignore","pipe","pipe"]`, `timeout: NPX_TIMEOUT_MS`, and on Windows `shell: false` with the `.cmd` path from `which`.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: port npx skills installer`

### Task 20: Init

**Files:**
- Create: `src/commands/init.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Flags from `init.py`: `--agent <name>` repeatable (choices from `agentSpecs`), `--all`, `--yes`, `--skip-auth`, `--skip-skills`, `--api-key`, `--browser` / `--no-browser` (tri-state), `--json`. Usage errors: `Use either --all or --agent, not both.`, `Use either --skip-auth or --api-key, not both.`
- JSON result shape from `_empty_result` in the worktree's `init.py`: `ok, version, mode, auth{authenticated,method}, skills{source,agents,restart_required,skipped}, verification{cli,auth,live_search}, error?{stage,message}`. `skills.source` is `tavily-ai/skills`. `skills.skipped` is `--skip-skills` or no agents selected; skills are installed only when not skipped. Stage exit codes: auth 3, skills 1, cli 1, live_search 4. Human success prints `Tavily skills ready for <agents>` and, when `restart_required`, `Restart <agents> to load newly installed skills.`
- Live search verification calls `search({query:"Tavily Search API", max_results:1})` with `client_name: "tavily-cli-init"`.

- [ ] **Step 1: Port** `test_init_skips_skills_without_detected_agents`, `test_init_json_reuses_environment_auth`, `test_init_noninteractive_auth_failure_is_json`, `test_init_live_search_failure_exits_four`. Add: `--skip-skills --skip-auth --json` with no key reports `mode: "keyless"` and `skills.skipped: true`.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** `cli` verification checks `tvly` on PATH through an injectable `which`.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add init command`

### Task 21: Install detection and update

**Files:**
- Create: `src/core/install-detect.ts`, `src/commands/update.ts`
- Test: `tests/update.test.ts`

**Interfaces:**
- Produces: `detectInstall(opts: { argv1?: string; realpath?: (p) => string; npmRootGlobal?: () => string | null; env?: NodeJS.ProcessEnv; which?: (name) => string | null }): InstallInfo` with `method` in `npm|pnpm|yarn|bun|npx|source|unknown`, `command: string[] | null`, `blockedReason: string | null`; `fetchLatestVersion(fetchImpl?): Promise<string>` reading `https://registry.npmjs.org/@tavily/cli/latest`.
- Update JSON keys from the spec. Human strings from `update.py`: `Tavily CLI <v> is up to date.`, `Tavily CLI update available: <a> -> <b>`, `Run \`tvly update\` to install it.`, `Self-update unavailable: <reason>`, `Updated Tavily CLI: <a> -> <b>`, `Updating Tavily CLI via <method>...`.

- [ ] **Step 1: Write failing tests** covering each row of the spec's detection table with path fixtures, including a Windows-style `C:\Users\me\AppData\Roaming\npm\node_modules\@tavily\cli\dist\cli.js` classified as `npm`; a `source` install (realpath under a directory with no `node_modules` ancestor) is blocked with `This is a source or direct-URL installation. Update it from its original source.`; port `test_update_check_json_is_read_only`, `test_update_does_nothing_when_current`, `test_update_runs_detected_manager_and_verifies_version`, `test_update_failure_is_structured_and_sanitized`, `test_update_surfaces_manager_hint_when_successful_upgrade_is_pinned`, `test_update_check_failure_is_structured`, `test_install_detection_failure_is_not_reported_as_network_error`.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement.** After the manager runs, the installed version is read by spawning `node <realpath of argv1> --version` and parsing the trailing token.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add npm-aware self-update`

### Task 22: REPL

**Files:**
- Create: `src/repl.ts`
- Test: `tests/repl.test.ts`

**Interfaces:**
- Produces: `runRepl(opts?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; program?: () => Command }): Promise<void>`.
- Banner, tips line, and help text copied from `repl.py` (ported tests `test_repl_help_lists_init_and_update`, `test_repl_banner_promotes_init_and_browser_login`).

- [ ] **Step 1: Write failing tests** feeding lines through a `PassThrough`: `help` prints the command table; `tvly search` with a leading `tvly` is stripped; an unterminated quote prints `Parse error:` and continues; a command that throws `ExitError(4)` does not end the loop; `exit` ends it with `Goodbye!`.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement** with `readline.createInterface({ input, output, terminal, history: [] , historySize: 100 })` and the prompt `\x1b[38;2;92;217;230m❯\x1b[0m  `.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: add interactive REPL`

### Task 23: install.sh for Node

**Files:**
- Modify: `install.sh`
- Test: `tests/install-sh.test.ts`

- [ ] **Step 1: Port the Python tests** `test_fresh_interactive_install_hands_off_to_init`, `test_noninteractive_install_prints_init_without_running_it`, `test_init_failure_does_not_fail_successful_install`, `test_automation_and_remote_sessions_do_not_run_init`, and rewrite the manager tests as: existing npm install upgrades with `npm install -g @tavily/cli@latest`; existing pnpm install wins over available npm; no Node prints the nodejs.org link and exits 1; Node 18 prints a version error and exits 1. Fake binaries are shell scripts in a temp `PATH` that log their argv.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Rewrite `install.sh`** per the spec's four steps, keeping `can_run_init_interactively` and `run_init_handoff` unchanged.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** `feat: install.sh installs through npm, pnpm, yarn, or bun`

### Task 24: JSON contract test and Python test ledger

**Files:**
- Create: `tests/contract.test.ts`, `tests/fixtures/contract/*.json`, `docs/superpowers/plans/python-test-ledger.md`

- [ ] **Step 1: Generate fixtures.** For `search` (one query and two queries), `extract`, `crawl`, `map`, `research status`, `research poll`, `auth`, `--status`, `init --skip-auth --skip-skills`, and `update --check`, write the API response fixture and the expected CLI stdout, each recorded twice: with `--json`, and without it with stdout piped (plain mode). Expected stdout comes from running the Python CLI (`uv run --with tavily-cli==0.2.1 tvly ...`) against a local HTTP server that serves the fixture, with `TAVILY_API_BASE_URL` pointed at it and `HOME` at a temp dir. Plain-mode cases compare stdout text exactly; JSON cases compare parsed objects. Commit the server script under `tests/helpers/fixture-server.ts` and the Python invocation under `tests/helpers/record-python.sh`.
- [ ] **Step 2: Write the contract test**: for each case, run `dist/cli.js` against the same fixture server and assert `JSON.parse(ts_stdout)` deep-equals `JSON.parse(python_stdout)` and the exit codes match. Document in a comment that byte equality is not asserted because Python prints `1.0` where JS prints `1`.
- [ ] **Step 3: Run, confirm pass.** Any mismatch is a bug in the owning task; fix it there.
- [ ] **Step 4: Write the ledger**: one line per Python test name with the vitest test that replaces it, or the reason it was dropped (allowed reasons: Python-only mechanism such as `sys.prefix` detection; superseded by a contract case).
- [ ] **Step 5: Commit** `test: add Python JSON contract fixtures and test ledger`

### Task 25: Remove the Python implementation, rewrite README, add CI

**Files:**
- Delete: `tavily_cli/`, `tests/*.py`, `pyproject.toml`
- Modify: `README.md`, `.gitignore`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Delete the Python tree** and confirm `git grep -l "tavily_cli\|pyproject\|pytest"` returns only the ledger and the spec.
- [ ] **Step 2: Rewrite README.** Installation becomes `npm install -g @tavily/cli` (plus pnpm, yarn, bun, and `npx @tavily/cli`), `Requires Node.js 20+`, the SDK note now names `@tavily/core` and says search flags track the SDK's parameter catalog, the `tvly search` reference lists the generated flags (copy from `tvly search --help`), the Updating section names npm, "eight core agent skills" becomes "the Tavily agent skills", and the Exit Codes table gains a footnote that 429 and 432 exit 3 on every credential type. Every other section keeps its text; re-run each example in the Command Reference against the built CLI's `--help` and fix any flag that drifted.
- [ ] **Step 3: Add CI** running `npm ci`, `lint`, `typecheck`, `test`, `build` on Node 20, 22, and 24 on ubuntu, macos, and windows.
- [ ] **Step 4: Run the full suite and the startup test** (`npm test`; expected all green, startup under 150 ms)
- [ ] **Step 5: Commit** `chore: remove Python implementation and document npm installation`

### Task 26: Release readiness

- [ ] **Step 0: Confirm `@tavily/core` 1.1.0 is published** (`npm view @tavily/core version`), remove the `npm link`, set `"@tavily/core": "^1.1.0"` in `package.json`, run `npm install`, and run the full suite against the published package.
- [ ] **Step 1: `npm pack --dry-run`** and confirm the tarball contains only `dist/`, `README.md`, `LICENSE`, `package.json`, and that `dist/cli.js` starts with the shebang and is executable after `npm install -g ./tavily-cli-0.3.0.tgz` in a temp prefix.
- [ ] **Step 2: Smoke test the global install**: `tvly --version`, `tvly search "tavily" --json` with a real key from the environment, `tvly auth --json`, `tvly update --check --json` (expect `install_method: "npm"`).
- [ ] **Step 3: Open the PR** titled `feat: rewrite CLI in TypeScript` with the spec and plan linked, and the ledger summarized.

## Self-review notes

- Spec coverage: every section of the spec maps to a task; "SDK integration" is Tasks 4, 5, and 13; "Terminal output" is Task 3 plus the render steps in 13 to 16; "Update" is Task 21; "install.sh" is Task 23; the two new tests from "Tests" are Tasks 1 (startup) and 24 (contract).
- Type consistency: `TavilyTransport` and `TavilyRequestError` (Task 4, in the SDK) are consumed by Tasks 5, 6, and 11; `TavilyClientLike` (Task 5) is the type consumed by Tasks 6, 11, 13 to 15, 20; `ExitError` (Task 1) is thrown by Tasks 11 onward; `SkillsInstallResult` (Task 19) feeds Task 20's JSON.
- Cross-repo sequencing: Task 4 is the only task outside this repository. Tasks 1 to 3 do not need it; Tasks 5 onward link against the local SDK build until 1.1.0 is on npm, and Task 26 confirms the published version is what `package.json` pins.
- Review Focus items are pinned in Tasks 24, 3 and 13, 9, 15, and 21 respectively.

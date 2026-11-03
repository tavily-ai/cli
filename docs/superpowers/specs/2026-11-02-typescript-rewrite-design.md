# Tavily CLI TypeScript Rewrite: Design

Date: 2026-11-02
Status: draft for review

## Intent

Rewrite the `tvly` command-line tool from Python to TypeScript so the CLI lives in the same ecosystem as the Tavily agent skills (`tavily-ai/skills`, installed through `npx skills`), the official JavaScript SDK (`@tavily/core`), and the MCP server (`tavily-mcp`). A user who has Node.js gets the CLI, the skills, and the MCP server from one toolchain, and the Tavily team maintains one language for all agent-facing tooling.

The rewrite is a port, not a redesign. Every command, flag, exit code, JSON payload, config file, and credential-handling rule of the Python CLI at version 0.2.1 (`origin/main` at commit `a673275`, plus the `TAVILY_CLIENT_NAME` environment fallback from the unmerged `feat/client-name-env` branch) carries over unchanged unless this document says otherwise. Compared with 0.1.9, that baseline has no `feedback` command, installs skills only through `npx skills`, prints plain text when stdout is not a terminal, accepts up to five search queries per command, has `--max-chars`, and lets a bare `-o` pick a path under `.tavily/`. The agent skills shell out to `tvly ... --json`, so the JSON contract is the hard compatibility boundary.

## Goals

1. Feature parity with the Python CLI, verified command by command against the README's Command Reference and Exit Codes tables.
2. Identical `--json` output shapes and identical exit codes, so existing skills and scripts keep working without edits.
3. Cold start under 150 ms for `tvly --version` and under 250 ms for `tvly search --json` before the network request begins, measured on an Apple Silicon laptop with Node 22. The Python CLI 0.1.8 installed through uv measures about 240 ms cold and 90 to 100 ms warm on the same machine, so the target is a modest improvement cold and parity warm; the real wins are the dependency tree and the single toolchain.
4. One runtime dependency set that a security reviewer can read in an afternoon, with the Tavily HTTP layer owned by `@tavily/core` so the CLI, the SDK, and later the MCP server share one implementation of auth headers, keyless handling, proxies, and error mapping. The Python version carried nine runtime packages including `psutil`, `requests`, `urllib3`, and `certifi` solely for their transitive security floors.
5. The same security posture the Python code earned through review: terminal-escape sanitization of every untrusted string, atomic and locked config writes with mode 0600, OAuth token revocation before replacement, PKCE with state verification, HTTPS-only discovery validation, and quote-free `npx` arguments.
6. Installation through npm, with `install.sh` and `tvly update` reworked for Node package managers.

## Non-goals

- No new commands, and no hand-written new flags. `tvly search` does gain flags, but only because they are generated from the SDK's parameter catalog (see "SDK integration"); every other command keeps its Python flag list.
- No change to the Tavily HTTP API, the MCP endpoint, or the skills repository.
- No support for Node versions below 20.
- No Python compatibility shim. The Python package on PyPI is retired separately (see Open Decisions).

## Anti-goals

- A `--json` payload that differs from the Python CLI by even one key. Agents parse these.
- A heavy dependency tree. `@tavily/core` and its `axios` are in; pulling in a framework such as `oclif` or `ink` to save a few hundred lines of rendering code is a failure even if it works.
- A config file format change. `~/.tavily/config.json` and `~/.tavily/session.json` written by the Python CLI must be read and written unchanged, so users upgrading keep their credentials.
- Silent behavior drift in edge cases that the Python test suite pinned. Each Python test has a TypeScript counterpart or a written reason it no longer applies.

## Constraints

- Runtime: Node.js 20 or newer. `node:crypto`, `node:http`, and `node:readline/promises` cover PKCE, the OAuth callback server, and the REPL. HTTP to the Tavily API goes through `@tavily/core`'s transport; HTTP to the OAuth server and the MCP endpoint uses native `fetch`.
- SDK: `@tavily/core` at or above the version that ships the transport export and typed request error described under "SDK integration". That SDK change is a prerequisite pull request in `tavily-js`, not part of this repository.
- Package: published to npm as `@tavily/cli` with the `tvly` bin. The unscoped `tavily-cli` name on npm belongs to a third party (last published 2026-03-08), so it is not available.
- Module format: ESM only, bundled to a single `dist/cli.js` with a shebang. Command modules and the markdown renderer load lazily so `tvly --version` never touches them.
- Platforms: macOS, Linux, and Windows. Windows loses nothing the Python version supported: file locking goes through a cross-platform lock library, skill links fall back to directory copies when symlinks are unavailable, and `npx` is invoked through its `.cmd` shim with quote-free arguments.
- Language level: TypeScript 5.x in strict mode with `noUncheckedIndexedAccess`. No `any` outside the two places that parse untyped JSON from the network, and those narrow immediately.
- Tooling: `tsup` for the bundle, `vitest` for tests, `biome` for lint and format. These are my calls; swap them if the team has a house standard.

## The port, module by module

The Python package has 17 modules. The TypeScript tree keeps the same responsibilities but regroups them into `commands/`, `core/`, and `ui/` so a reader can tell at a glance whether a file talks to the network, the filesystem, or the terminal.

```
src/
  cli.ts                 bin entry: shebang, calls main(), maps ExitError to process.exit
  program.ts             buildProgram(): commander tree with lazy command loading
  repl.ts                interactive shell: readline, shell-word splitting, dispatch into program
  errors.ts              ExitError, OAuthError (API errors come from @tavily/core)
  version.ts             VERSION constant injected at build time from package.json
  commands/
    search.ts  extract.ts  crawl.ts  map.ts  research.ts
    auth.ts    init.ts     update.ts  defaults.ts
  core/
    config.ts            ~/.tavily/config.json: read, locked atomic write, credential resolution
    session.ts           stable session id from parent and grandparent pid, ~/.tavily/session.json
    oauth.ts             discovery, dynamic registration, PKCE, local callback server, refresh, revoke
    tavily-client.ts     TavilyClient over the @tavily/core transport, returning raw API JSON
    search-flags.ts      commander options generated from @tavily/core/parameters
    mcp-client.ts        McpTavilyClient over mcp.tavily.com/mcp for OAuth tokens
    client-factory.ts    getClient / getClientOrKeyless / requireApiKeyFriendly
    skills.ts            agent detection and npx skills install
    install-detect.ts    which package manager owns this install, and its upgrade command
    agent-defaults.ts    Claude Code settings.json and Codex config.toml edits
  ui/
    theme.ts             brand colors, logo, stdout/stderr writers
    text.ts              sanitizeControl, safeLink, wrap, tree, table, markdown
    spinner.ts           stderr spinner that is a no-op in JSON mode or without a TTY
    render.ts            printSearchResults, printExtractResults, ... one per command, terminal and plain modes
    keyless.ts           formatKeylessEnvelopeForTerminal
    output-file.ts       -o resolution (.tavily/<command>-<slug>-<time>-<hex>.json) and folder creation
  util/
    shell-words.ts       splitShellWords (shlex.split equivalent) for the REPL
    semver.ts            compareVersions for the update check
```

### Command surface

Unchanged from the README's CLI Overview:

```
tvly                      REPL
tvly init                 auth, skills, verification
tvly login | logout | auth
tvly search <query...> | extract | crawl | map
tvly research [run] <query> | research status <id> | research poll <id>
tvly update [--check]
tvly set-default | unset-default
tvly --version | --status | --json
```

Flag names, choices, defaults, and help strings are copied from the Click decorators. `--json` is accepted both on the root and on every command, and a command resolves it as `own flag OR root flag`, which matches Click's parent-context lookup.

The `research` group keeps the Python `ResearchGroup.parse_args` rule: when the first positional is not `run`, `status`, or `poll`, it is a query for `run`; when it is `status` or `poll` with no following positional and no `--help`, it is also a query for `run`. Commander's default-command feature does not express the second rule, so a pure function `normalizeResearchArgs(args: string[]): string[]` runs before parsing and is unit-tested with the three cases from the Python docstring.

### Exit codes and error flow

Commands never call `process.exit`. They throw `ExitError(code)` after printing their own error. `main()` catches `ExitError` and exits with its code; the REPL catches it and returns to the prompt. Commander is configured with `exitOverride()` so usage errors also surface as exceptions; `main()` maps them to exit code 2, and the REPL prints them inline. Unhandled exceptions print a one-line error to stderr and exit 1.

The exit-code table is the README's: 0 success, 1 local setup or update error, 2 usage, 3 auth failure or keyless cap or plan limit (HTTP 429 and 432), 4 API error or live-search failure or update-check error.

One deliberate deviation from the Python binary: with an API key, Python exited 4 on HTTP 429 and 432 because `tavily-python` raised errors without a status code, so `handle_api_error` could not take its plan-limit branch; only the OAuth path exited 3. The README documents 3, and the TS client always knows the status, so both paths exit 3. This is the one place the README wins over the Python behavior.

### SDK integration

The CLI builds on `@tavily/core` so that changes to how Tavily is called reach the CLI through a dependency bump instead of a port. Two parts of the SDK are used, and the SDK needs two small additions first.

**What the SDK already provides (1.0.0, published 2026-11-02).** `@tavily/core/parameters` exports `searchParameters`, a dependency-free catalog of every Search request field in camelCase with a JSON-Schema-style type, enum values, integer bounds, and a one-line description, plus `SearchParameterValues` for the TypeScript type. The SDK's own `search` serializes a request body from this catalog by converting each key to snake_case. The CLI's `search` command generates its commander options from the same catalog (`core/search-flags.ts`): each key becomes `--kebab-case`, a `string` enum becomes a choice list, `integer` gets a parser with the catalog's `minimum` and `maximum`, `array` of strings becomes a comma-separated value, `boolean` becomes a flag, and the two-type `["boolean","string"]` fields become optional-value flags whose bare form means `basic` for `includeAnswer` and `markdown` for `includeRawContent`, as in Python. The catalog's `description` is the help text. A small override map keeps the Python names where they differ (`searchDepth` is exposed as `--depth`, `query` is the positional argument), and anything in the catalog but not in the Python CLI (`days`, `includeDomainsMode`, `maxAgeHours`, `autoParameters`, `includeFavicon`, `includeUsage`, `exactMatch`, `fetchTimeout`, `cacheFallback`, `language`, `filterByLanguage`, `safeSearch`, `includePublishedDate`, `filterByPublishedDate` today) appears as a flag with no further work. A test asserts that every catalog key maps to exactly one flag and that generated flag names do not collide with the command's fixed options (`--output`, `--client-name`, `--json`), so a future SDK release that adds a conflicting name fails the build instead of shadowing a flag. The catalog covers Search only today; `extract`, `crawl`, `map`, and `research` keep their Python flag lists until the SDK publishes catalogs for them, at which point they move to the same generator. `tvly search` also keeps the Python-only options that are not request parameters: up to five positional queries run in parallel with the same options, `--max-chars` for snippet length, `-o`, `--client-name`, and `--json`.

**What the SDK needs added (prerequisite pull request in `tavily-js`, released as 1.1.0).**

1. `export class TavilyRequestError extends Error { status: number; body: unknown; docs?: string }` thrown by `handleRequestError` in place of the bare `Error`. The message stays `detail.error` when present (what the Python SDK produced for 400, 401, 403, 429, 432, and 433) and `"<status> Error: <json body>"` otherwise, so no SDK caller that reads `.message` changes. `TavilyKeylessLimitError` is unchanged and still thrown only in keyless mode.
2. `export function createTransport(options: TavilyClientOptions): { post(endpoint, body, opts?): Promise<unknown>; get(endpoint, opts?): Promise<unknown>; stream(endpoint, body, opts?): Promise<AsyncIterable<Buffer>> }` built from the existing `buildHeaders`, `post`, and `get` in `utils.ts`. It owns auth and keyless headers, `X-Session-Id`, `X-Human-Id`, `X-Client-Name`, `X-Project-ID`, `X-Tavily-Orgid`, `Content-Type`, proxies from `TAVILY_HTTP_PROXY` and `TAVILY_HTTPS_PROXY`, base URL, timeouts, the keyless-envelope conversion, and the error conversion above. The SDK's own methods are refactored to call it, so it has one implementation. `post` and `get` return the parsed body untouched. The CLI is the first consumer; the MCP server can be the second.

`core/tavily-client.ts` wraps `createTransport({ apiKey?, sessionId, humanId, clientName, clientSource: "tavily-cli" | "tavily-cli-keyless", apiBaseURL })` and exposes `search`, `extract`, `crawl`, `map`, `research`, `researchStream`, and `getResearch`, each taking the snake_case request body as a plain object and returning the response untouched. This keeps the `--json` contract exact; the SDK's typed methods rename every field to camelCase and keep only what they model, which is right for application code and wrong for a CLI whose consumers parse `raw_content` and `response_time`.

The Python SDK injected request defaults the CLI never set, and the server response depends on them, so the client reproduces them: `extract` sends `timeout: 30` unless given, `crawl` and `map` send `timeout: 150` unless given, `research` sends `stream: false` and `citation_format: "numbered"` unless given, and the HTTP timeout for `search` is the lesser of the body `timeout` and 120 s. These live in the CLI client rather than the transport because they are per-endpoint; if the SDK later exports per-endpoint body builders, the CLI adopts them. Keyless clients refuse `crawl`, `map`, `research`, and `getResearch` with a `TavilyRequestError`-shaped error; the commands guard before that with `requireApiKeyFriendly`, exactly as today.

`researchStream` uses the transport's `stream` and yields decoded chunks. The research command parses `data:` lines itself, as the Python `_render_stream` did.

Base URL comes from `TAVILY_API_BASE_URL` or `config.api_base_url` or the SDK default. Python's error message for an unhandled HTTP status came from `requests` (`500 Server Error: ... for url: ...`); that string is not reproduced and is not part of the contract.

`core/mcp-client.ts` is a line-for-line port of `mcp_client.py`: JSON-RPC `tools/call` to `https://mcp.tavily.com/mcp`; the fixed headers `Authorization`, `Content-Type`, `Accept: application/json, text/event-stream`, `x-client-source: tavily-cli`; the conditional headers `x-client-name`, `X-Human-Id`, and both `mcp-session-id` and `X-Session-Id` set to the session id (the first stops the remote MCP from minting its own session, the second is forwarded to the API); SSE `data:` line parsing, `structuredContent` then `content[0].text` fallback, and a `TavilyRequestError` (status and docs taken from the payload) on an `error` key in the parsed tool result. Both clients satisfy one `TavilyClientLike` interface so commands do not branch on credential type.

### Credentials and config

`core/config.ts` reads and writes `~/.tavily/config.json` with the same keys: `api_key`, `oauth` (with `access_token`, `refresh_token`, `expires_at`, `token_type`, `client_id`, `client_secret`, `token_endpoint_auth_method`, `redirect_uri`), `human_id`, `api_base_url`.

Resolution order is unchanged: `TAVILY_API_KEY` env, then `api_key` in config, then OAuth in config with refresh on expiry, then a valid Tavily-issued token from `~/.mcp-auth/*_tokens.json`.

Writes go through `withConfigLock(fn)`, which acquires a cross-process lock through `proper-lockfile` (mkdir-based, works on Windows, stale after 30 s), runs `fn(config)` with the freshly read config, and writes the result atomically. The lock directory is `~/.tavily/.config.lock`, not the Python CLI's `~/.tavily/.config.json.lock`: Python created that path as a regular file for `flock` and never removed it, and `mkdir` on an existing file would fail forever. The Python file is left alone. The two CLIs do not serialize against each other; nobody runs both concurrently against one config file. Writing is temp file in the same directory, `fsync`, `chmod 0600`, `rename`. The directory is created with mode 0700. Node is single-threaded, so the Python thread lock and re-entrancy counter are unnecessary; functions that need the lock take the config as a parameter instead of re-acquiring.

The revocation ordering rules from the Python tests are kept verbatim: `saveApiKey` revokes any stored OAuth session first; `saveOauthSession` revokes the previous session before overwriting, and if that fails it revokes the new session and leaves the old one in place; a refresh persists tokens without revoking; `clearCredentials` revokes, clears the file (deleting it when empty), removes Tavily-issued tokens from `~/.mcp-auth`, and reports `server_revoked` and `revocation_error` so `logout` can exit 3 on partial failure.

`core/session.ts` reproduces the session-id rule: look up the parent pid in `session.json`, then the grandparent pid if its process is alive, else mint a uuid and record it under both pids after pruning dead entries. Parent pid is `process.ppid`. The grandparent pid is resolved only when the parent-pid lookup misses (Python computed it eagerly through `psutil`; deferring it saves a process spawn on every warm invocation). It comes from `/proc/<ppid>/stat` on Linux, `ps -o ppid= -p <ppid>` on macOS and other Unix, and `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=<ppid>').ParentProcessId"` on Windows, so agents that spawn a shell per command keep one session id on every platform, as they did with `psutil`. Liveness is `process.kill(pid, 0)` with `EPERM` counted as alive. Any failure falls back to a fresh uuid, as the Python module-level try/except did.

### OAuth

`core/oauth.ts` ports `oauth.py` function for function: `fetchMetadata` (discovery with issuer check, HTTPS-only endpoint validation, protected-resource check, static fallbacks), `registerClient` (RFC 7591 public PKCE client, with the same validation of `token_endpoint_auth_method` and `client_secret`), `buildAuthorizeUrl`, `exchangeCode`, `refreshTokens` (keeps the old refresh token when the server omits one), `revokeToken` (with the documented 400 retry that adds an empty `client_secret` for public clients), `tokenIsExpired` (non-finite or non-numeric expiry counts as expired), `expiresAtFromNow` (60 s skew, 3600 s default), and `runBrowserLogin`.

`runBrowserLogin` starts `node:http` on `127.0.0.1:0`, registers the client with the resulting redirect URI, opens the browser, and waits up to 180 s for `/callback`. The browser opens through `child_process.spawn` with `open` on macOS, `xdg-open` on Linux, and `rundll32 url.dll,FileProtocolHandler <url>` on Windows (not `cmd /c start`, which splits the URL at `&`), detached and with stdio ignored. The headless heuristic (`SSH_CONNECTION`, `SSH_TTY`, Linux without `DISPLAY` or `WAYLAND_DISPLAY`) is unchanged. PKCE uses `node:crypto` `randomBytes` and `createHash("sha256")`; `state` is 32 random bytes base64url.

### Skills installation

`core/skills.ts` ports the 0.2.1 installer, which is `npx` only. It runs `npx --yes skills@1.7.4 add tavily-ai/skills --skill * --global --agent <agents...> --yes` with stdin closed and a 300 s timeout. Without `npx` on PATH it throws `Installing Tavily skills requires Node.js (npx). Install Node.js, or rerun with --skip-skills.`; a timeout throws `npx skills timed out while installing Tavily skills.`; a non-zero exit throws `npx skills failed: <last non-empty line of stderr, else stdout, else "exit code N">`. Since the CLI itself now needs Node, the "no npx" branch only fires when `npx` is missing from PATH, but the message stays for parity.

`restartRequired` is computed the Python way: before and after the run, digest every directory directly under `~/.agents/skills` and under each selected agent's skills directory, keyed by path, and compare; a new agent link to an existing shared skill counts as a change. The digest covers relative path, byte length, and content of every regular file. Agent detection (`claude-code` at `CLAUDE_CONFIG_DIR` or `~/.claude`, `codex` at `CODEX_HOME` or `~/.codex`, `cursor` at `~/.cursor`, each detected when its directory exists) is ported as written. There is no pinned skill list, no archive download, and no `tar` dependency.

### Update

`core/install-detect.ts` replaces the Python package-manager detection. It resolves `process.argv[1]` through `fs.realpathSync` and classifies:

| Method | Signal | Upgrade command |
|---|---|---|
| `npm` | realpath under `npm root -g` | `npm install -g @tavily/cli@latest` |
| `pnpm` | path contains `/pnpm/global/` or `PNPM_HOME` | `pnpm add -g @tavily/cli@latest` |
| `yarn` | path contains `/.yarn/global/` or `/yarn/global/` | `yarn global add @tavily/cli@latest` |
| `bun` | path contains `/.bun/install/global/` | `bun add -g @tavily/cli@latest` |
| `npx` | path contains `/_npx/` | blocked: rerun `npx @tavily/cli@latest` |
| `source` | the package directory is not inside any `node_modules`, or `package.json` is reached through an `npm link` symlink | blocked: update from source |
| `unknown` | none of the above | blocked |

The latest version comes from `https://registry.npmjs.org/@tavily/cli/latest` (`.version`). Comparison uses a small `compareVersions` for `major.minor.patch[-prerelease]`. The command then runs the upgrade with a 300 s timeout, re-reads the installed version by executing `tvly --version` from the same realpath, and fails with the same "may be pinned" message plus any `hint:` line from the manager's output. The JSON payload keeps the Python keys: `ok`, `current_version`, `latest_version`, `update_available`, `install_method`, `can_update`, `blocked_reason`, `updated`.

### Agent defaults

`core/agent-defaults.ts` ports `defaults.py` unchanged: Claude Code gets `WebSearch` and `WebFetch` appended to `permissions.deny` in `~/.claude/settings.json` (or `.claude/settings.local.json` with `--project`); Codex gets `web_search = "disabled"` inserted or replaced among the top-level keys of `config.toml` before the first table header. Invalid JSON is never overwritten. The interactive prompt uses `node:readline/promises`.

### Terminal output

Rich has no Node equivalent, and the formatting the CLI needs is small enough to own. `ui/text.ts` provides:

- `sanitizeControl(value)`: strips `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]`, the same class as Python.
- `safeLink(url, label?)`: OSC 8 hyperlink only for `http` and `https` schemes and only when stderr is a TTY, otherwise plain text.
- `renderMarkdown(text, width)`: `marked` with `marked-terminal`, loaded lazily, after `sanitizeControl`, wrapped to `min(columns, 100)`.
- `tree(root, children)`: box-drawing tree with `├──` and `└──` prefixes for the crawl and map views.
- `table(columns, rows)`: left-aligned columns for the research sources list.

Colors come from `picocolors`. They are enabled only when stdout is a TTY; `NO_COLOR` and `FORCE_COLOR=0` disable them, and any other non-empty `FORCE_COLOR` enables them. picocolors' own detection is not used, because it also enables color on Windows and under `CI` when output is piped. Brand hex values from `theme.py` map to the nearest 24-bit ANSI escapes emitted directly when the terminal supports true color (`COLORTERM=truecolor` or `24bit`) and to the closest 256-color index otherwise, so the look matches Rich's output.

`ui/spinner.ts` writes a dots spinner to stderr every 80 ms, is a no-op when `--json` is set or stderr is not a TTY, and exposes `update(message)` for the research poll loop's elapsed counter.

`ui/render.ts` ports `output.py` function for function, including its two human modes. When stdout is a terminal it renders styled output. When stdout is not a terminal (a pipe, a redirect, or a coding agent's shell) it prints plain text with no styling, wrapping, or markdown re-rendering: `search` prints `Answer: <text>` if present, then per result the numbered title, the full URL, and the content collapsed to one line and cut to `--max-chars` with `...`, then `Image: <url>` lines; `extract` and `crawl` print each page as `# <url>`, a blank line, the full content with runs of three or more blank lines collapsed to one, and `extract` ends with `Failed: <url>: <error>` lines; `map` prints one URL per line; `research` prints the report, a blank line, `Sources:`, and `<n>. <title> <url>` lines. Terminal mode detection is `process.stdout.isTTY`, overridable in tests. In terminal mode, search shows the full URL on one line without wrapping (Python used `soft_wrap=True`). Every field from the network passes through `sanitizeControl` or `safeLink` in both modes.

`--max-chars` defaults to 600 divided by the number of queries in the command, `0` prints content whole, and the value does not affect `--json` or `-o` files. Multi-query search prints `=== [i/n] <query>` before each response, bold at a terminal and plain otherwise, and `error: <message>` for a failed query.

The `-o` option takes an optional value. With a path, the full JSON response is written there and the folder is created if missing. With no value, the path is `.tavily/<command>-<slug>-<HHMMSS>-<6 hex>.json`, where the slug is the lower-cased label (first query, URL host, or request id) reduced to `[a-z0-9]+` runs joined by `-` and cut to 40 characters, defaulting to `result`; the path is chosen before the request runs so concurrent commands do not collide. A newly created `.tavily/` folder gets a `.gitignore` containing `*`. At a terminal, `-o` only saves; when stdout is not a terminal, `search` with `-o` saves and still prints the plain results so an agent can skim them. `Output saved to <path>` goes to stderr.

The JSON path writes `JSON.stringify(data, null, 2)` for pretty and `JSON.stringify(data)` for compact, matching the pretty flag each Python call used. `JSON.stringify` escapes control characters, so the JSON path needs no stripping.

### REPL

`repl.ts` uses `node:readline/promises` with history enabled and the same cyan `❯` prompt. A line is split with `splitShellWords` (POSIX quoting rules, matching `shlex.split` for the inputs users type; an unterminated quote is a parse error printed inline). A leading `tvly` is dropped. The args are dispatched through a fresh `buildProgram()` with `exitOverride()`, and `ExitError` and usage errors return to the prompt. Ctrl+C at the prompt ends the REPL with `Goodbye!`; Ctrl+C while a command runs exits the REPL (the Python version returned to the prompt; the port does not plumb cancellation). `exit`, `quit`, `q`, `help`, and `?` are handled before dispatch.

### install.sh

The script keeps its structure and its handoff to `tvly init`, and swaps the Python package managers for Node ones:

1. Require `node` 20 or newer; otherwise print the nodejs.org download link and exit 1.
2. If `tvly` is already installed through npm, pnpm, yarn, or bun, upgrade with that manager.
3. Otherwise install with the first of `npm`, `pnpm`, `yarn`, `bun` on PATH.
4. Verify `tvly --version`, then run the existing interactive handoff logic unchanged.

The Python test file `test_install_sh.py` drove the script with fake binaries on `PATH`; the vitest port does the same.

### Tests

Every Python test maps to a vitest test with the same name in snake_case or a short note in the plan explaining why it is dropped. Network calls are faked by injecting `fetchImpl`; filesystem tests use a temp `HOME`; process spawns for `npx`, `ps`, and package managers go through an injectable `spawn` so tests never run real binaries. The suite runs in under 10 s.

Two tests are new: a JSON contract test that runs each command against a recorded API fixture and compares the parsed stdout object and the exit code with the Python CLI's recorded output for the same fixture, and a startup-time test that fails if `tvly --version` exceeds 150 ms on CI. The contract test compares parsed objects rather than bytes because Python's `json.dumps` prints `1.0` where `JSON.stringify` prints `1` and puts spaces after separators in compact mode; no consumer parses these as text.

## Open decisions

These are mine unless you overrule them.

1. **Package name `@tavily/cli`.** The unscoped name is squatted. The scoped name sits beside `@tavily/core`.
2. **Version `0.3.0`.** It continues the Python line (0.2.1 on `main`) rather than restarting at 1.0.0, which signals a port rather than a new product.
3. **`@tavily/core` for transport and parameter catalogs, with a prerequisite SDK release.** Explained under "SDK integration". The README keeps its sentence that the CLI depends on the official SDK, now pointing at `@tavily/core`.
4. **Biome instead of ESLint and Prettier.** One tool, one config, fast. Swap if the org standard differs.
5. **`proper-lockfile` as the only non-trivial runtime dependency** beside `@tavily/core`, `commander`, `picocolors`, `marked`, and `marked-terminal`. Writing a lock protocol by hand is where ports grow bugs.
6. **Python package retirement.** Out of scope for the rewrite. A final `tavily-cli` 0.1.10 on PyPI whose `tvly update` prints the npm instructions is the obvious follow-up and should be its own ticket.
7. **Skills install is npx only**, as in Python 0.2.1; no pinned list or archive.
8. **Exit 3 for keyed 429 and 432.** The README wins over the accidental Python behavior; see "Exit codes and error flow".
9. **`--version` prints `tavily-cli 0.3.0`.** The repository, the GitHub project, and `install.sh` all call the product `tavily-cli`; only the npm registry name is scoped. `install.sh` and the update verifier parse the trailing token, so the prefix is free to change later.
10. **Python SDK request defaults are reproduced**, including `citation_format: "numbered"` for research, so server-side behavior and the `--json` payloads do not shift under users' feet. Dropping them is a product decision for another day.

## What is left to the builder

Internal function signatures beyond those named here, test fixture layout, the exact ANSI escape strings, how the spinner handles terminal resize, and the wording of the Biome config. The plan that follows this document pins the rest.

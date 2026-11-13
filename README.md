# Tavily CLI

`tvly` runs [Tavily](https://docs.tavily.com) search, extract, crawl, map, and research from the terminal, and sets up Tavily skills and the MCP server for Claude Code, Codex, and Cursor. It is built on the official JavaScript SDK, [`@tavily/core`](https://www.npmjs.com/package/@tavily/core), and the `tvly search` flags follow the SDK's parameter catalog.

- Rich output in a terminal, plain text when piped or run by an agent, and `--json` everywhere.
- Search and extract work without an account, within a fair-use rate limit.
- An interactive shell when run with no arguments.
- Self-update through the package manager that installed it.

## Install

```bash
npx @tavily/cli init
```

This installs `tvly` globally, signs you in, sets up your coding agents, and verifies a live search. Requires Node.js 20.1 or later.

To install without running setup, use your package manager and run `tvly init` afterwards:

```bash
npm install -g @tavily/cli
pnpm add -g @tavily/cli
yarn global add @tavily/cli
bun add -g @tavily/cli
```

The shell installer does the same on macOS and Linux, and starts `tvly init` when it runs in an interactive terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/tavily-ai/cli/main/install.sh | sh
```

## Setup

`tvly init` walks through four steps:

1. **Global install.** If `tvly` is not on your PATH, it is installed with the package manager that ran `init`. If the install directory is not on your PATH either, `init` offers to add it to your shell profile.
2. **How do you want to sign in?** Browser login, paste an API key, or continue without a key. An existing credential is reused.
3. **Which agents do you want to install to?** Every detected agent is pre-checked. `--agent` picks the agents and skips the question.
4. **What should I install?** Tavily skills and the hosted MCP server are checked by default; the official workflows from `tavily-ai/official-workflows` are not.

It then verifies the CLI with a live search. Rerunning `tvly init` updates installed skills to the latest published version.

```bash
tvly init                                   # prompts for everything
tvly init --yes                             # accept every default
tvly init --agent codex                     # one agent, no agent question
tvly init --api-key tvly-YOUR_KEY           # API key instead of browser login
tvly init --skip-auth                       # keyless setup when no credential exists
tvly init --skip-skills                     # sign in and verify, leave agents alone
```

`--yes`, `--json`, and runs without a terminal ask nothing and take the defaults: every detected agent, with skills and the MCP server.

Skills are installed with the [skills.sh CLI](https://skills.sh) into `~/.agents/skills`, which Codex and Cursor read directly; Claude Code gets links in `~/.claude/skills`. The MCP server is added with `npx add-mcp`. Both need `npx` on your PATH. Restart your agent after setup.

### Signing in

`tvly login` manages credentials without the rest of setup:

```bash
tvly login                          # browser login
tvly login --no-browser             # print the login URL instead of opening it
tvly login --api-key tvly-YOUR_KEY  # store an API key
tvly auth                           # show authentication status
tvly logout                         # revoke tokens and clear stored credentials
```

`TAVILY_API_KEY` in the environment takes priority over stored credentials, so use it for CI and SSH sessions. `--no-browser` still waits for a callback on `127.0.0.1`, so over SSH either forward the port or use an API key.

Browser login goes through Tavily's MCP endpoint, which rejects some search, crawl, and research options ([details](https://github.com/tavily-ai/tavily-cli/issues/24)). Use an API key for the full option set.

## Usage

Search and extract work right after installation, with no sign-in, until a fair-use cap is reached. Crawl, map, and research require a credential.

```bash
tvly search "latest AI trends"
tvly search "quantum computing" --depth advanced --max-results 10 --time-range week
tvly search "SEC filings for Apple" --include-domains sec.gov,reuters.com
tvly search "Rust 2024 edition" "Rust 1.85 release notes"   # up to 5 queries, run in parallel

tvly extract https://example.com/article
tvly extract https://example.com https://other.com --query "pricing information"

tvly crawl https://docs.example.com --max-depth 2 --limit 100 --select-paths "/api/.*,/guides/.*"
tvly crawl https://docs.example.com --output-dir ./docs      # one Markdown file per page

tvly map https://example.com --select-paths "/blog/.*" --limit 500

tvly research "Competitive landscape of AI code assistants"
tvly research "EV market analysis" --model pro --stream
tvly research "topic" --no-wait --json       # returns a request_id
tvly research poll REQUEST_ID --json
```

Running `tvly` with no arguments opens a shell where commands are typed without the `tvly` prefix.

### Output

In a terminal, results are formatted and wrapped. When stdout is a pipe, a file, or an agent's shell, output is plain text: `search` prints each result's title, URL, and the first 600 characters of content on one line (`--max-chars` changes the length, `0` prints everything); `extract` and `crawl` print each page in full under a `# <url>` heading; `map` prints one URL per line; `research` prints the report and its sources. `--json` prints the API response unchanged.

`-o` / `--output` saves the full JSON response. With no value it writes under `.tavily/` with a generated name and prints the path; a new `.tavily/` folder gets its own `.gitignore`. `crawl --output-dir` saves each page as a Markdown file instead.

```bash
tvly search "AI news" -o
tvly search "AI news" --output results/ai-news.json
tvly extract https://example.com --format markdown --output extracted.json
```

### Scripts and agents

Every command accepts `--json`. A `-` argument reads the query from stdin.

```bash
echo "What is the latest funding for Anthropic?" | tvly search - --json
tvly init --yes --json                           # TAVILY_API_KEY supplied by the environment
tvly init --agent codex --skip-auth --yes --json # keyless setup
tvly --status --json                             # version and auth status
```

Setup JSON includes `ok`, `mode`, `install`, `auth`, `skills`, `workflows`, `mcp`, and `verification`; on failure, `error.stage` names the failed step. Setup always runs a live search, so it needs network access.

| Exit code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | Local setup or update error |
| 2 | Invalid input or usage error |
| 3 | Authentication failure, keyless rate-limit cap, or API usage/plan limit |
| 4 | API error, setup live-search failure, or update-check error |

HTTP 401, 403, 429, and 432 exit 3 on every credential type.

## Commands

```
tvly
├── (no command)          Interactive shell
├── init                  Install, sign in, set up agents, verify
├── login                 Sign in with the browser or an API key
├── logout                Clear stored credentials
├── auth                  Show authentication status
├── search <query...>     Web search
├── extract <urls...>     Extract content from URLs
├── crawl <url>           Crawl a website
├── map <url>             Discover URLs without content
├── research <query>      Deep research
│   ├── status <id>       Check a research task
│   └── poll <id>         Wait for a research task
├── setup mcp             Add the hosted Tavily MCP server to an agent
├── set-default           Disable built-in web search in Claude Code and Codex
├── unset-default         Restore it
└── update                Check for or install a newer release
```

### `tvly init`

| Option | Description |
|--------|-------------|
| `--agent` | Set up `claude-code`, `codex`, or `cursor`; repeat for more than one |
| `--yes` | Accept every default without prompting |
| `--skip-auth` | Skip sign-in when no credential is configured |
| `--skip-skills` | Leave coding agents alone: no skills, workflows, or MCP server |
| `--skip-workflows` | Skip the official workflows |
| `--skip-install` | Skip the global `tvly` install |
| `--api-key` | Sign in with an API key |
| `--browser` / `--no-browser` | Open the login page or print its URL |

`--skip-auth` and `--api-key` cannot be combined.

### `tvly setup mcp`

Adds the hosted Tavily MCP server (`https://mcp.tavily.com/mcp/`, named `tavily`) to Claude Code, Codex, and Cursor. Nothing runs locally.

```bash
tvly setup mcp                                   # every detected agent
tvly setup mcp --agent claude-code --agent cursor
tvly setup mcp --agent all
```

| Option | Description |
|--------|-------------|
| `--agent` | `claude-code`, `codex`, `cursor`, or `all`; repeat for more than one |
| `--keyless` | Write the URL-only config so the agent signs in with OAuth even when `TAVILY_API_KEY` is set |

With `TAVILY_API_KEY` exported, the config references the variable (`${TAVILY_API_KEY}` for Claude Code, `${env:TAVILY_API_KEY}` for Cursor, `--bearer-token-env-var` for Codex) and the key itself is never written to disk. Without it, the agent opens a browser to sign in the first time it uses the server. A key stored by `tvly login` is not used for MCP. Agents that cannot be configured, such as Codex when `codex` is not on PATH, are skipped and listed; the command exits 1 only when nothing was configured.

### `tvly search <query...>`

| Option | Description |
|--------|-------------|
| `--depth` | `basic`, `advanced`, `fast`, or `ultra-fast` |
| `--max-results` | Result count limit |
| `--topic` | `general`, `news`, or `finance` |
| `--time-range` | `year`, `month`, `week`, or `day` (or `y`, `m`, `w`, `d`) |
| `--start-date` / `--end-date` | Date window bounds (YYYY-MM-DD) |
| `--include-domains` / `--exclude-domains` | Domains to prefer or omit |
| `--include-domains-mode` | How `--include-domains` applies: `restrict` or `prefer` |
| `--country` | Country preference |
| `--language` | Preferred content language |
| `--filter-by-language` | Restrict results to the requested language |
| `--include-answer` | Generated answer: `basic`, `advanced`, `true`, or `false` |
| `--include-raw-content` | Page content as `markdown` or `text`, or `false` |
| `--include-images` / `--include-image-descriptions` | Images alongside results |
| `--include-favicon` | Site icons |
| `--include-published-date` | Detected publication dates |
| `--filter-by-published-date` | Drop undated results and results outside the date window |
| `--include-usage` | Credit usage details |
| `--chunks-per-source` | Content chunks per source for advanced search |
| `--auto-parameters` | Let Tavily choose search settings from the query |
| `--cache-fallback` | Allow cached content when live fetching fails |
| `--max-age-hours` | Maximum acceptable cache age |
| `--fetch-timeout` | Live-fetch time budget in seconds |
| `--days` | Lookback in days for news searches |
| `--exact-match` | Require exact matches for quoted phrases |
| `--safe-search` | Filter explicit content |
| `--max-chars` | Characters of content printed per result (default 600, `0` for all) |
| `-o` / `--output` | Save the full JSON response |
| `--client-name` | `client_name` for request attribution |

Up to 5 queries run in parallel with the same options. Each query's results print under a `=== [i/n] <query>` header; with `--json`, the output is a list in query order. A failing query reports its error without stopping the others.

### `tvly extract <urls...>`

| Option | Description |
|--------|-------------|
| `--query` | Rerank chunks by relevance |
| `--chunks-per-source` | Chunks per source (1-5, requires `--query`) |
| `--extract-depth` | `basic` or `advanced` |
| `--format` | `markdown` or `text` |
| `--include-images` | Include image URLs |
| `--timeout` | Max wait (1-60 seconds) |
| `-o` / `--output` | Save the full JSON response |
| `--client-name` | `client_name` for request attribution |

### `tvly crawl <url>` and `tvly map <url>`

| Option | Description |
|--------|-------------|
| `--max-depth` | Levels deep (1-5, default 1) |
| `--max-breadth` | Links per page (default 20) |
| `--limit` | Total pages or URLs (default 50) |
| `--instructions` | Natural-language guidance |
| `--select-paths` / `--exclude-paths` | Regex patterns for paths |
| `--select-domains` / `--exclude-domains` | Regex patterns for domains |
| `--allow-external` / `--no-external` | Follow or ignore links to other domains |
| `--timeout` | Max wait (10-150 seconds) |
| `-o` / `--output` | Save the full JSON response |
| `--client-name` | `client_name` for request attribution |

`crawl` only:

| Option | Description |
|--------|-------------|
| `--chunks-per-source` | Chunks per page (1-5) |
| `--extract-depth` | `basic` or `advanced` |
| `--format` | `markdown` or `text` |
| `--include-images` | Include images |
| `--output-dir` | Save each page as a Markdown file in a directory |

### `tvly research <query>`

Streaming, structured output, and async research need an API key.

| Option | Description |
|--------|-------------|
| `--model` | `mini`, `pro`, or `auto` (default) |
| `--no-wait` | Return the request ID immediately |
| `--stream` | Stream results as they arrive |
| `--output-schema` | Path to a JSON schema for structured output |
| `--citation-format` | `numbered`, `mla`, `apa`, or `chicago` |
| `--poll-interval` | Seconds between status checks (default 10) |
| `--timeout` | Max wait in seconds (default 600) |
| `-o` / `--output` | Save the full JSON response |
| `--client-name` | `client_name` for request attribution |

`tvly research status <id>` checks a task; `tvly research poll <id>` waits for it with the same `--poll-interval`, `--timeout`, and `-o` options.

### `tvly set-default` / `tvly unset-default`

Makes Tavily the web tool your coding agents use by disabling their built-in web search. Without flags, you are asked per agent. `unset-default` reverses the change but does not restore values you had set yourself before.

| Option | Description |
|--------|-------------|
| `--claude` | Add `WebSearch` and `WebFetch` to `permissions.deny` in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) |
| `--codex` | Set `web_search = "disabled"` in `~/.codex/config.toml` (or `$CODEX_HOME`) |
| `--project` | Apply to the current directory instead (`.claude/settings.local.json` and `.codex/config.toml`) |

### `tvly update`

```bash
tvly update --check     # report without changing anything
tvly update             # update through npm, pnpm, yarn, or bun, whichever installed it
```

Source and direct-URL installations are reported but not modified. JSON output includes `can_update` and `blocked_reason`.

The CLI also checks for a newer release at most once a day and prints a one-line notice on stderr. It stays silent under `--json`, when stderr is not a terminal, when run through `npx`, or when `CI` or `NO_UPDATE_NOTIFIER` is set.

## Environment variables

| Variable | Description |
|----------|-------------|
| `TAVILY_API_KEY` | API key; takes priority over stored credentials |
| `TAVILY_API_BASE_URL` | Override the API base URL (also `api_base_url` in `~/.tavily/config.json`) |
| `TAVILY_CLIENT_NAME` | Default for `--client-name` |
| `TAVILY_HUMAN_ID` | Identifier attached to every request for usage attribution (also `human_id` in the config file) |
| `TAVILY_PROJECT` | Project ID attached to requests |
| `TAVILY_ORG_ID` | Organization ID attached to requests |
| `TAVILY_HTTP_PROXY` / `TAVILY_HTTPS_PROXY` | Proxy URLs for API calls made with an API key |
| `NO_UPDATE_NOTIFIER` | Disable the daily update notice (`CI` disables it too) |

Browser login, OAuth-credentialed commands, and `tvly update` use Node's `fetch`, which ignores proxy variables unless Node 24 or later runs with `NODE_USE_ENV_PROXY=1`.

## Related

- [Tavily CLI docs](https://docs.tavily.com/documentation/tavily-cli)
- [`@tavily/core`](https://www.npmjs.com/package/@tavily/core), the JavaScript SDK
- [Tavily API reference](https://docs.tavily.com)

## License

MIT

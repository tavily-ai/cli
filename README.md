# Tavily CLI

CLI and agent tools for the [Tavily API](https://docs.tavily.com) — search, extract, crawl, map, and research from the command line.

> **Note:** This package provides the `tvly` command-line tool. It is built on the official
> JavaScript SDK, [`@tavily/core`](https://www.npmjs.com/package/@tavily/core), and the
> `tvly search` flags track the SDK's parameter catalog.

## Features

- **One-Command Setup** — Authenticate, install Tavily skills for supported agents, and verify a live search
- **Interactive REPL** — Run `tvly` with no arguments for a chat-like shell experience
- **CLI for Humans & AI Agents** — Rich-formatted output in a terminal, plain text when piped or run by an agent, and `--json` for structured output
- **Web Search** — LLM-optimized search with domain/date filtering and relevance scoring
- **Content Extraction** — Extract clean markdown from any URL
- **Website Crawling** — Crawl sites with depth/breadth control and path filtering
- **URL Discovery** — Map all URLs on a site without content extraction
- **Deep Research** — AI-powered research with citations and structured output
- **Self-Update** — Check for and install CLI updates through the original package manager

## Installation

```bash
npx @tavily/cli init
```

This installs `tvly` globally, authenticates, installs the Tavily skills for the agents it detects (Claude Code, Codex, Cursor), offers the official workflows from `tavily-ai/official-workflows`, and verifies a live search. Add `--yes` to run it without prompts, or `--skip-install` to leave `tvly` uninstalled.

Requires **Node.js 20.1+**.

### Install globally

Choose the package manager you use:

```bash
# npm
npm install -g @tavily/cli

# pnpm
pnpm add -g @tavily/cli

# yarn
yarn global add @tavily/cli

# bun
bun add -g @tavily/cli

# Run without installing
npx @tavily/cli search "latest AI trends"
```

Then run `tvly init` to complete setup.

### From source

```bash
git clone https://github.com/tavily-ai/cli.git
cd cli
npm install
npm run build
npm link
```

### Updating

```bash
# Check without changing the installation
tvly update --check

# Update through npm, pnpm, yarn, or bun, whichever installed it
tvly update
```

Source (`npm link`) and direct-URL installations are detected and must be updated from their original source.

### Shell installer

```bash
curl -fsSL https://raw.githubusercontent.com/tavily-ai/cli/main/install.sh | sh
```

On a fresh interactive desktop installation, the installer starts `tvly init`
to guide authentication, agent detection, skill installation, and verification.
In CI, SSH/headless, and other non-interactive environments, run `tvly init`
separately with the [appropriate setup options](#non-interactive-mode-for-ai-agents--scripts).

## Quick Start

### Initialize Tavily

Setup starts from `npx @tavily/cli init`. After a package-manager, source, or
non-interactive install, run:

```bash
tvly init
tvly search "latest AI trends"
```

`tvly init` guides you through:

1. **Global install:** if `tvly` is not on your PATH, install it globally with the package manager that ran `init` (npm, pnpm, yarn, or bun). If the install directory is not on your PATH, `init` offers to add it to your shell profile, or prints the line to add yourself.
2. **Authentication:** reuse an existing credential or sign in through browser OAuth.
3. **Agent setup:** detect Claude Code, Codex, and Cursor, install the Tavily agent skills, and offer the official workflows from `tavily-ai/official-workflows`.
4. **Verification:** check the CLI, then run a live search.

Skills are installed with the [skills.sh CLI](https://skills.sh)
(`npx skills add tavily-ai/skills`), and the workflows the same way
(`npx skills add tavily-ai/official-workflows`), so both need `npx` on your PATH.
Without it, use `--skip-skills`, which skips both. `--skip-workflows` skips only the workflows. Restart your agent after new skills are installed.

```bash
# Set up one or more supported agents
tvly init --agent codex
tvly init --agent claude-code --agent cursor

# Set up every detected agent without the agent-selection prompt
tvly init --all --yes

# Authenticate with an API key instead of OAuth
tvly init --api-key tvly-YOUR_KEY

# Install skills and verify keyless search if no credential is configured
tvly init --skip-auth

# Authenticate and verify the CLI without installing agent skills
tvly init --skip-skills
```

Skills are installed in `~/.agents/skills`, which Codex and Cursor load
directly; Claude Code gets links in `~/.claude/skills`. If no supported agent
is detected, setup skips the skills.
Rerunning `tvly init` updates existing skills to the latest published version.
You can also run `npx skills update` at any time.

### Try search and extract without signing in

You can skip setup and run `tvly search` or `tvly extract` immediately after
installation. When no credential is configured, these commands use keyless
access with a fair-use rate-limit cap.

```bash
tvly search "latest AI trends"
tvly extract https://example.com
```

If you reach the cap, the CLI prints continuation options. Run `tvly login`
to authenticate, then retry your command. `crawl`, `map`, and `research`
require authentication.

### Manage authentication

Use `tvly login` when you only want to manage authentication without running
the full setup and agent-skill installation:

```bash
# Browser OAuth
tvly login

# Print the OAuth URL and wait for authorization
tvly login --no-browser

# Or set API key directly
tvly login --api-key tvly-YOUR_KEY

# Or use environment variable
export TAVILY_API_KEY=tvly-YOUR_KEY

# Check auth status
tvly auth

# Revoke stored OAuth tokens and clear saved credentials
tvly logout
```

`--no-browser` is also available on `tvly init`. It prints the login URL but
still waits for a callback to `127.0.0.1` on the machine running the CLI.
For SSH sessions, arrange port forwarding or use an API key; for CI, supply
`TAVILY_API_KEY` through your secret manager. `tvly logout` cannot unset an
environment variable, so unset `TAVILY_API_KEY` separately if needed.

For the full API option set, use API-key authentication. Browser OAuth uses
Tavily's MCP endpoint, where some CLI options and research operations have
[known compatibility gaps](https://github.com/tavily-ai/tavily-cli/issues/24).

## Examples

### Interactive Mode

```bash
# Launch the interactive REPL
tvly
```

This opens a chat-like shell where you can run commands without the `tvly` prefix:

```
❯  search "latest AI trends"
❯  extract https://example.com
❯  help
```

### Search the Web

```bash
# Basic search
tvly search "latest AI trends"

# Advanced search with filters
tvly search "quantum computing" --depth advanced --max-results 10 --time-range week

# Search specific domains
tvly search "SEC filings for Apple" --include-domains sec.gov,reuters.com

# Several queries at once, run in parallel with the same options
tvly search "Rust 2024 edition release date" "Rust 1.85 release notes" --depth advanced

# Longer snippets (0 prints each result's content whole)
tvly search "AI news" --max-chars 1500

# JSON output
tvly search "AI news" --json

# Set client_name for attribution
tvly search "latest AI news" --client-name x
```

### Extract Content from URLs

```bash
# Extract a single URL
tvly extract https://example.com/article

# Extract multiple URLs with a focus query
tvly extract https://example.com https://other.com --query "pricing information"

# Advanced extraction for JS-heavy pages
tvly extract https://spa-app.com --extract-depth advanced
```

### Crawl a Website

```bash
# Basic crawl
tvly crawl https://docs.example.com

# Deep crawl with filters
tvly crawl https://docs.example.com --max-depth 2 --limit 100 --select-paths "/api/.*,/guides/.*"

# Semantic focus with per-page chunks (API-key authentication)
tvly crawl https://docs.example.com --instructions "Find authentication docs" --chunks-per-source 3

# Save pages as markdown files
tvly crawl https://docs.example.com --output-dir ./docs
```

### Map URLs

```bash
# Discover all URLs on a site
tvly map https://example.com

# Filter by path
tvly map https://example.com --select-paths "/blog/.*" --limit 500
```

### Deep Research

Use API-key authentication for streaming, structured output, and async
research. Replace `REQUEST_ID` with the ID returned by your research request.

```bash
# Run research and wait for results
tvly research "Competitive landscape of AI code assistants"

# Use pro model for comprehensive analysis
tvly research "Electric vehicle market analysis" --model pro

# Stream results in real-time
tvly research "AI market trends" --stream

# Async: start and poll separately
tvly research "topic" --no-wait --json        # returns request_id
tvly research status REQUEST_ID --json        # check status
tvly research poll REQUEST_ID --json          # wait and get result

# Structured output
tvly research "AI market size" --output-schema schema.json --json
```

### Output in Pipes and Agent Shells

When stdout is not a terminal, such as in a pipe, a redirect or a coding agent's
shell, commands print plain text with no styling or line wrapping:

- `search` prints each result's title, full URL and the first 600 characters of
  its content on one line. `--max-chars` changes the length, and `0` prints the
  content whole. Several queries in one command share the 600 characters.
- `extract` and `crawl` print each page in full, as `# <url>` followed by its
  content, with links kept.
- `map` prints one URL per line, and `research` prints the report followed by
  its sources.

`--json` output is unchanged.

### Save Results

`--output` writes the structured JSON response, regardless of the filename
extension, and creates the folder if it doesn't exist. With no value, `-o`
saves under `.tavily/` with a generated name, such as
`.tavily/search-ai-news-142310-3f9a1c.json`, and prints the path. A new `.tavily/`
folder gets its own `.gitignore`, so saved results stay out of git. Nothing is
saved without `-o`. When stdout is not
a terminal, `search --output` still prints the results, so you can skim them and
read the saved file for more. For extraction, `--format markdown` controls the
content inside that response; it does not turn the output file into plain
Markdown.

```bash
tvly search "AI news" -o
tvly search "AI news" --output results/ai-news.json
tvly extract https://example.com --format markdown --output extracted.json

# Save individual crawled pages as Markdown files
tvly crawl https://docs.example.com --output-dir ./docs
```

## CLI Overview

```
tvly
├── (no command)                # Interactive REPL
├── init                        # Guided auth, agent skills, and verification
├── login                       # Authenticate (OAuth or API key)
├── logout                      # Clear stored credentials
├── auth                        # Check authentication status
├── search <query>              # Web search
├── extract <urls...>           # Extract content from URLs
├── crawl <url>                 # Crawl a website
├── map <url>                   # Discover URLs (no content)
├── update                      # Check for or install CLI updates
├── set-default                 # Disable built-in web search in Claude Code/Codex
├── unset-default               # Restore built-in web search in Claude Code/Codex
├── research <query>            # Deep research (async)
│   ├── run <query>             # Start a research task (same as above)
│   ├── status <id>             # Check task status
│   └── poll <id>               # Poll until completion
```

## Non-Interactive Mode (for AI Agents & Scripts)

Use `--json` for structured output. For unattended setup, provide a credential
through `TAVILY_API_KEY` or choose `--skip-auth` for keyless search and extract.
`--yes` accepts agent selection; it does not complete browser authentication.

```bash
# With TAVILY_API_KEY already supplied by your environment
tvly init --all --yes --json

# Keyless setup for Codex when no credential is configured
tvly init --agent codex --skip-auth --yes --json

# Verify the CLI without installing skills (uses existing credentials, if any)
tvly init --skip-auth --skip-skills --json
```

Setup JSON includes `ok`, `mode`, `install`, `auth`, `skills`, `workflows`, and `verification`. On
failure, `error.stage` identifies the failed step. Setup always performs a
live search, so it needs network access even with `--skip-skills`.

```bash
# Every command supports --json for structured output
tvly search "query" --json
tvly auth --json
tvly extract https://example.com --json
tvly update --check --json

# Read input from stdin with "-"
echo "What is the latest funding for Anthropic?" | tvly search - --json
echo "Research question" | tvly research - --json

# Async research: launch then poll separately
tvly research "question" --no-wait --json        # returns request_id
tvly research status REQUEST_ID --json           # check status
tvly research poll REQUEST_ID --json             # wait and get result

# Global options
tvly --version         # show version
tvly --status          # show version + auth status
tvly --status --json   # structured status
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Local setup or update error |
| 2 | Invalid input / usage error |
| 3 | Authentication failure, keyless rate-limit cap, or handled API usage/plan limit |
| 4 | API error, setup live-search failure, or update-check error |

HTTP 429 and 432 exit 3 on every credential type.

## Command Reference

### `tvly init`

Run first-time setup, install or update the Tavily skills (through
`npx skills`), and verify the CLI with a live search.

| Option | Description |
|--------|-------------|
| `--agent` | Install skills for `claude-code`, `codex`, or `cursor`; repeat to select more than one |
| `--all` | Install skills for every detected agent |
| `--yes` | Accept detected agents and the global install without prompting |
| `--skip-auth` | Skip login when no credential is configured; existing credentials are still used |
| `--skip-skills` | Skip agent-skill and workflow installation and updates |
| `--skip-workflows` | Skip installing the official workflows from `tavily-ai/official-workflows` |
| `--skip-install` | Skip the global `tvly` install |
| `--api-key` | Authenticate with an API key instead of OAuth |
| `--browser` / `--no-browser` | Open OAuth in a browser or print the URL; both require the local callback |

Use either `--all` or `--agent`. `--skip-auth` and `--api-key` cannot be
combined. `--json` is a global flag accepted by every command; with `tvly init`
it returns structured setup and verification results and selects detected
agents without prompting, but does not skip authentication.

### `tvly search`

| Option | Description |
|--------|-------------|
| `--depth` | Search strategy: `basic`, `advanced`, `fast`, or `ultra-fast` |
| `--max-results` | Result count limit |
| `--topic` | `general`, `news`, `finance` |
| `--time-range` | Relative date window: `year`, `month`, `week`, `day` (or `y`, `m`, `w`, `d`) |
| `--start-date` | Start of the date window (YYYY-MM-DD) |
| `--end-date` | End of the date window (YYYY-MM-DD) |
| `--include-domains` | Domains to include or prefer |
| `--exclude-domains` | Domains to omit |
| `--country` | Country preference for results |
| `--include-answer` | Request a generated answer: `basic` (default when given), `advanced`, `true`, `false` |
| `--include-raw-content` | Return page content as `markdown` (default when given) or `text`, or disable it with `false` |
| `--include-images` | Request images alongside text results |
| `--include-image-descriptions` | Request descriptions for returned images |
| `--chunks-per-source` | Content chunks per source for advanced search |
| `--auto-parameters` | Let Tavily choose search settings from the query |
| `--cache-fallback` | Allow cached content when live fetching fails |
| `--days` | Lookback in days for news searches |
| `--exact-match` | Require exact matches for quoted phrases in the query |
| `--fetch-timeout` | Live-fetch time budget in seconds |
| `--filter-by-language` | Restrict results to the requested language |
| `--filter-by-published-date` | Exclude undated results and results outside the requested date window; also enables publication dates |
| `--include-domains-mode` | How to apply `--include-domains`: `restrict` or `prefer` |
| `--include-favicon` | Request site icons |
| `--include-published-date` | Request detected publication dates |
| `--include-usage` | Request credit usage details |
| `--language` | Preferred content language |
| `--max-age-hours` | Maximum acceptable cache age in hours |
| `--safe-search` | Filter explicit content from results |
| `--max-chars` | Characters of each result's content to print (default 600, shared across queries; `0` for all); `--json` and `-o` files keep it whole |
| `-o` / `--output` | Save the full JSON response to file; with no value, under `.tavily/` |
| `--client-name` | Set optional `client_name` for request attribution |

`tvly search` accepts up to 5 queries and runs them in parallel with the same
options. Each query's results print under its own `=== [i/n] <query>` header;
with `--json`, the output is a list of responses in query order. A query that
fails reports its error without stopping the others.

### `tvly update`

Check the npm registry for the latest Tavily CLI release and update through the
package manager responsible for the active installation.

```bash
tvly update --check
tvly update
tvly update --check --json
```

`--check` is read-only. Source/direct-URL installations are reported without
being modified. JSON output includes `can_update` and `blocked_reason` so
automation can distinguish an available release from a supported self-update.

### `tvly extract`

| Option | Description |
|--------|-------------|
| `--query` | Rerank chunks by relevance |
| `--chunks-per-source` | Chunks per source (1-5, requires `--query`) |
| `--extract-depth` | `basic` or `advanced` |
| `--format` | `markdown` or `text` |
| `--include-images` | Include image URLs |
| `--timeout` | Max wait (1-60 seconds) |
| `-o` / `--output` | Save output to file |
| `--client-name` | Set optional `client_name` for request attribution |

### `tvly crawl`

| Option | Description |
|--------|-------------|
| `--max-depth` | Levels deep (1-5, default: 1) |
| `--max-breadth` | Links per page (default: 20) |
| `--limit` | Total pages cap (default: 50) |
| `--instructions` | Natural language guidance |
| `--chunks-per-source` | Chunks per page (1-5, requires `--instructions`) |
| `--extract-depth` | `basic` or `advanced` |
| `--format` | `markdown` or `text` |
| `--select-paths` | Regex patterns for paths to include |
| `--exclude-paths` | Regex patterns for paths to exclude |
| `--select-domains` | Regex for domains to include |
| `--exclude-domains` | Regex for domains to exclude |
| `--allow-external` / `--no-external` | Include or leave out external domain links |
| `--include-images` | Include images |
| `--timeout` | Max wait (10-150 seconds) |
| `-o` / `--output` | Save the full JSON response to file; with no value, under `.tavily/` |
| `--output-dir` | Save each page as .md file in directory |
| `--client-name` | Set optional `client_name` for request attribution |

### `tvly map`

| Option | Description |
|--------|-------------|
| `--max-depth` | Levels deep (1-5, default: 1) |
| `--max-breadth` | Links per page (default: 20) |
| `--limit` | Max URLs to discover (default: 50) |
| `--instructions` | Natural language guidance |
| `--select-paths` | Regex patterns for paths to include |
| `--exclude-paths` | Regex patterns for paths to exclude |
| `--select-domains` | Regex patterns for domains to include |
| `--exclude-domains` | Regex patterns for domains to exclude |
| `--allow-external` / `--no-external` | Include or leave out external domain links |
| `--timeout` | Max wait (10-150 seconds) |
| `-o` / `--output` | Save output to file |
| `--client-name` | Set optional `client_name` for request attribution |

### `tvly research <query>` / `tvly research run <query>`

| Option | Description |
|--------|-------------|
| `--model` | `mini`, `pro`, or `auto` (default) |
| `--no-wait` | Return request_id immediately |
| `--stream` | Stream results in real-time |
| `--output-schema` | Path to JSON schema file |
| `--citation-format` | `numbered`, `mla`, `apa`, `chicago` |
| `--poll-interval` | Seconds between checks (default: 10) |
| `--timeout` | Max wait seconds (default: 600) |
| `-o` / `--output` | Save output to file |
| `--client-name` | Set optional `client_name` for request attribution |

### `tvly research status`

Check research task status by request ID. Supports `--client-name`.

### `tvly research poll`

Poll until completion and return results. Same `--poll-interval`, `--timeout`, `-o`, and `--client-name` options as `run`.

### `tvly set-default` / `tvly unset-default`

Make Tavily the default web tool for your coding agents by disabling their
built-in web search. Without flags, you are prompted for each agent.
`unset-default` undoes `set-default`, but doesn't restore values you had set
yourself for these settings before running it.

| Option | Description |
|--------|-------------|
| `--claude` | Add `WebSearch` and `WebFetch` to `permissions.deny` in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) |
| `--codex` | Set `web_search = "disabled"` in `~/.codex/config.toml` (or `$CODEX_HOME`) |
| `--project` | Apply to the current directory instead: `.claude/settings.local.json` and `.codex/config.toml` (Codex reads project config only in trusted projects) |

```bash
tvly set-default --claude --codex
tvly unset-default --codex
tvly set-default --claude --project
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TAVILY_API_KEY` | API key (highest priority, no login needed) |
| `TAVILY_HUMAN_ID` | Optional identifier attached to every request for usage attribution |
| `TAVILY_CLIENT_NAME` | Default for `--client-name` request attribution |
| `TAVILY_API_BASE_URL` | Override the Tavily API base URL (also settable as `api_base_url` in the config file) |
| `TAVILY_PROJECT` | Project ID attached to requests |
| `TAVILY_ORG_ID` | Organization ID attached to requests |
| `TAVILY_HTTP_PROXY` / `TAVILY_HTTPS_PROXY` | Proxy URLs used for HTTP and HTTPS requests |

`TAVILY_HTTP_PROXY` and `TAVILY_HTTPS_PROXY` apply to API calls made with an
API key. Browser login, OAuth-credentialed commands, and `tvly update` use
Node's `fetch`, which ignores proxy variables unless Node 24 or later is run
with `NODE_USE_ENV_PROXY=1`.

```bash
# Via env var (highest priority)
export TAVILY_HUMAN_ID=alice@example.com

# Or persist it in the config file
# (~/.tavily/config.json — set the "human_id" key)
```

## Related

- [`@tavily/core`](https://www.npmjs.com/package/@tavily/core) — Official Tavily JavaScript SDK
- [Tavily Docs](https://docs.tavily.com) — Full API documentation

## License

MIT

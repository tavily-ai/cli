import { Command, InvalidArgumentError, Option } from "commander";
import type { DefaultsOptions } from "./commands/defaults.js";
import type { InitOptions } from "./commands/init.js";
import {
  addClientNameOption,
  addOutputOption,
  parseNumberArg,
  resolveJson,
} from "./commands/options.js";
import type { PollOptions, RunOptions } from "./commands/research.js";
import { AGENT_NAMES } from "./core/agent-names.js";
import { out } from "./ui/theme.js";
import { VERSION } from "./version.js";

const HELP_AFTER = `
First-time setup: tvly init

Browser authentication: tvly login

API-key authentication: tvly login --api-key tvly-YOUR_KEY

Or set TAVILY_API_KEY environment variable.
`;

const KEYLESS_HELP =
  "\nWorks without an API key (subject to a rate-limit cap). Run `tvly login` to authenticate and remove the cap.";

export function buildProgram(): Command {
  const program = new Command("tvly")
    .description("Tavily CLI — search, extract, crawl, map, and research from the command line.")
    .addHelpText("after", HELP_AFTER)
    .option("--version", "Show version and exit")
    .option("--status", "Show version and auth status")
    .option("--json", "Output as JSON (for agents and scripts)")
    .configureHelp({ showGlobalOptions: true })
    .exitOverride();

  const defaults = () => import("./commands/defaults.js");
  const research = () => import("./commands/research.js");

  program
    .command("init")
    .description("Authenticate, install Tavily skills, and verify a working CLI.")
    .addOption(
      new Option("--agent <name>", "Install skills for an agent. Repeat to select more than one.")
        .choices(AGENT_NAMES)
        .argParser((value: string, previous: string[] | undefined) => {
          const name = value.toLowerCase();
          if (!(AGENT_NAMES as readonly string[]).includes(name)) {
            throw new InvalidArgumentError(`Allowed choices are ${AGENT_NAMES.join(", ")}.`);
          }
          return [...(previous ?? []), name];
        }),
    )
    .option("--all", "Install skills for every detected agent.")
    .option("--yes", "Accept detected agents and the global install without prompting.")
    .option("--skip-auth", "Keep keyless mode when no credential is configured.")
    .option("--skip-skills", "Do not install or update Tavily agent skills.")
    .option("--skip-install", "Do not install tvly globally.")
    .option("--api-key <key>", "Authenticate with a Tavily API key instead of OAuth.")
    .option("--browser", "Open OAuth in a browser.")
    .option("--no-browser", "Print the OAuth URL and wait for its local callback.")
    .action(async (opts: InitOptions, cmd: Command) => {
      await (await import("./commands/init.js")).run(opts, cmd);
    });
  const authModule = () => import("./commands/auth.js");
  program
    .command("login")
    .description("Authenticate with Tavily. Stores credentials for future use.")
    .option("--api-key <key>", "Tavily API key (tvly-...). If omitted, opens browser for OAuth.")
    .option("--no-browser", "Print the login URL instead of opening a browser (SSH / headless).")
    .action(async (opts: { apiKey?: string; browser?: boolean }, cmd: Command) => {
      await (await authModule()).runLogin(opts, cmd);
    });
  program
    .command("logout")
    .description("Clear stored Tavily credentials.")
    .action(async (opts: Record<string, never>, cmd: Command) => {
      await (await authModule()).runLogout(opts, cmd);
    });
  program
    .command("auth")
    .description("Check authentication status.")
    .action(async (opts: Record<string, never>, cmd: Command) => {
      await (await authModule()).runAuth(opts, cmd);
    });
  // search's flags come from the SDK catalog; they are added only when search is dispatched.
  const configurers = new Map<Command, () => Promise<void>>();
  const configure = async (cmd: Command) => {
    const load = configurers.get(cmd);
    configurers.delete(cmd);
    await load?.();
  };
  const searchModule = () => import("./commands/search.js");
  const search = program
    .command("search")
    .description("Search the web using Tavily.")
    .argument(
      "[queries...]",
      "One or more search queries (up to 5), run in parallel with the same options. Use - to read a single query from stdin.",
    )
    .addHelpText("after", KEYLESS_HELP)
    .action(async (queries: string[], opts: Record<string, unknown>, cmd: Command) => {
      await (await searchModule()).run(queries, opts, cmd);
    });
  configurers.set(search, async () => (await searchModule()).configure(search));
  program.hook("preSubcommand", (_program, sub) => configure(sub));

  const extract = program
    .command("extract")
    .description("Extract content from one or more URLs.")
    .argument("<urls...>", "URLs to extract (max 20).")
    .option("--query <query>", "Rerank chunks by relevance to this query.")
    .option(
      "--chunks-per-source <n>",
      "Chunks per source (1-5, requires --query).",
      (raw: string) => parseNumberArg(raw, { integer: true }),
    )
    .addOption(
      new Option("--extract-depth <depth>", "Extraction depth.").choices(["basic", "advanced"]),
    )
    .addOption(new Option("--format <format>", "Output format.").choices(["markdown", "text"]))
    .option("--include-images", "Include image URLs.")
    .option("--timeout <seconds>", "Max wait time in seconds (1-60).", (raw: string) =>
      parseNumberArg(raw),
    )
    .addHelpText("after", KEYLESS_HELP)
    .action(async (urls: string[], opts: Record<string, unknown>, cmd: Command) => {
      await (await import("./commands/extract.js")).run(urls, opts, cmd);
    });
  addOutputOption(extract);
  addClientNameOption(extract);
  const int = (raw: string) => parseNumberArg(raw, { integer: true });
  const seconds = (raw: string) => parseNumberArg(raw);
  const addSiteOptions = (cmd: Command, verb: string, limitHelp: string) => {
    cmd
      .option("--max-depth <n>", `Levels deep to ${verb} (1-5, default: 1).`, int)
      .option("--max-breadth <n>", "Links per page (default: 20).", int)
      .option("--limit <n>", limitHelp, int)
      .option(
        "--instructions <text>",
        `Natural language guidance for ${verb === "crawl" ? "the crawler" : "URL discovery"}.`,
      );
  };
  const addSiteFilters = (cmd: Command) => {
    cmd
      .option("--select-paths <patterns>", "Comma-separated regex patterns for paths to include.")
      .option("--exclude-paths <patterns>", "Comma-separated regex patterns for paths to exclude.")
      .option(
        "--select-domains <patterns>",
        "Comma-separated regex patterns for domains to include.",
      )
      .option(
        "--exclude-domains <patterns>",
        "Comma-separated regex patterns for domains to exclude.",
      )
      .option("--allow-external", "Include external domain links.")
      .option("--no-external", "Leave out external domain links.")
      .option("--timeout <seconds>", "Max wait time in seconds (10-150).", seconds);
  };
  const needsKey = "\nRequires a Tavily API key. Sign up at https://tavily.com";

  const crawl = program
    .command("crawl")
    .description("Crawl a website starting from URL.")
    .argument("<url>", "Where to start; returns full content for each discovered page.");
  addSiteOptions(crawl, "crawl", "Total pages cap (default: 50).");
  crawl.option("--chunks-per-source <n>", "Chunks per page (1-5, requires --instructions).", int);
  crawl
    .addOption(
      new Option("--extract-depth <depth>", "Extraction depth.").choices(["basic", "advanced"]),
    )
    .addOption(new Option("--format <format>", "Output format.").choices(["markdown", "text"]));
  addSiteFilters(crawl);
  crawl
    .option("--include-images", "Include images.")
    .option("--output-dir <dir>", "Save each page as a .md file in this directory.")
    .addHelpText("after", needsKey)
    .action(async (url: string, opts: Record<string, unknown>, cmd: Command) => {
      await (await import("./commands/crawl.js")).run(url, opts, cmd);
    });
  addOutputOption(crawl);
  addClientNameOption(crawl);

  const map = program
    .command("map")
    .description("Discover all URLs on a website (no content extraction).")
    .argument("<url>", "Where to start; returns the URLs found.");
  addSiteOptions(map, "map", "Maximum URLs to discover (default: 50).");
  addSiteFilters(map);
  map
    .addHelpText("after", needsKey)
    .action(async (url: string, opts: Record<string, unknown>, cmd: Command) => {
      await (await import("./commands/map.js")).run(url, opts, cmd);
    });
  addOutputOption(map);
  addClientNameOption(map);

  const group = program
    .command("research")
    .description("Deep research commands (run, status, poll).")
    .addHelpText(
      "after",
      '\nYou can run research directly: tvly research "your query"\nOr use subcommands: tvly research status <id>',
    );
  const addWaitOptions = (cmd: Command) => {
    cmd
      .option("--poll-interval <n>", "Seconds between status checks.", int, 10)
      .option("--timeout <n>", "Max seconds to wait.", int, 600);
  };
  const researchRun = group
    .command("run", { isDefault: true })
    .description("Start a research task.")
    .argument("[query]", 'The research topic. Use "-" to read from stdin.')
    .addOption(
      new Option("--model <model>", "Research model (default: auto).").choices([
        "mini",
        "pro",
        "auto",
      ]),
    )
    .option("--no-wait", "Return request_id immediately without waiting.")
    .option("--stream", "Stream results in real-time.")
    .option("--output-schema <file>", "Path to JSON schema file for structured output.")
    .addOption(
      new Option("--citation-format <format>", "Citation format.").choices([
        "numbered",
        "mla",
        "apa",
        "chicago",
      ]),
    );
  addOutputOption(researchRun);
  addWaitOptions(researchRun);
  addClientNameOption(researchRun);
  researchRun
    .addHelpText("after", `\nYou can also run directly: tvly research "your query"\n${needsKey}`)
    .action(async (query: string | undefined, opts: RunOptions, cmd: Command) => {
      await (await research()).run(query, opts, cmd);
    });

  const researchStatus = group
    .command("status")
    .description("Check the status of a research task.")
    .argument("<request_id>", "The research request ID.")
    .action(async (requestId: string, opts: Record<string, unknown>, cmd: Command) => {
      await (await research()).status(requestId, opts, cmd);
    });
  addClientNameOption(researchStatus);

  const researchPoll = group
    .command("poll")
    .description("Poll a research task until completion and return results.")
    .argument("<request_id>", "The research request ID.")
    .action(async (requestId: string, opts: PollOptions, cmd: Command) => {
      await (await research()).poll(requestId, opts, cmd);
    });
  addWaitOptions(researchPoll);
  addOutputOption(researchPoll);
  addClientNameOption(researchPoll);

  program
    .command("update")
    .description("Check for or install the latest Tavily CLI release.")
    .option("--check", "Check for an update without installing it.")
    .action(async (opts: { check?: boolean }, cmd: Command) => {
      await (await import("./commands/update.js")).run(opts, cmd);
    });
  const addDefaultOptions = (
    cmd: Command,
    claudeHelp: string,
    codexHelp: string,
    scope: string,
  ) => {
    cmd
      .option("--claude", claudeHelp)
      .option("--codex", codexHelp)
      .option(
        "--project",
        `${scope} the current project (.claude/settings.local.json, .codex/config.toml) instead of globally.`,
      );
  };
  const setDefault = program
    .command("set-default")
    .description("Make Tavily the default web tool by disabling agents' built-in web search.");
  addDefaultOptions(
    setDefault,
    "Deny Claude Code's built-in WebSearch and WebFetch tools.",
    "Disable Codex's built-in web search.",
    "Apply to",
  );
  setDefault.action(async (opts: DefaultsOptions, cmd: Command) => {
    await (await defaults()).runSetDefault(opts, cmd);
  });
  const unsetDefault = program
    .command("unset-default")
    .description("Undo set-default and restore agents' built-in web search.");
  addDefaultOptions(
    unsetDefault,
    "Re-allow Claude Code's built-in WebSearch and WebFetch tools.",
    "Re-enable Codex's built-in web search.",
    "Undo in",
  );
  unsetDefault.action(async (opts: DefaultsOptions, cmd: Command) => {
    await (await defaults()).runUnsetDefault(opts, cmd);
  });

  // Commander's built-in help command prints synchronously, before lazily added flags exist.
  program.helpCommand(false);
  program
    .command("help [command]")
    .description("display help for command")
    .action(async (name: string | undefined) => {
      if (name === undefined) return program.help();
      const sub = program.commands.find((c) => c.name() === name || c.aliases().includes(name));
      if (!sub) return program.help({ error: true });
      await configure(sub);
      sub.help();
    });

  program.action(async (opts: { version?: boolean; status?: boolean }, cmd: Command) => {
    const json = resolveJson(cmd);
    if (opts.version) {
      out(json ? JSON.stringify({ version: VERSION }) : `tavily-cli ${VERSION}`);
      return;
    }
    if (opts.status) {
      await (await import("./commands/status.js")).printStatus(json);
      return;
    }
    const { runRepl } = await import("./repl.js");
    await runRepl();
  });

  // `tvly research "<query>"` and `tvly research status` (no id) mean `research run ...`; the
  // tokens after `research` are rewritten before commander sees them.
  const parseAsync = program.parseAsync.bind(program);
  program.parseAsync = async (argv = process.argv, parseOptions) => {
    const args = [...argv];
    const start = parseOptions?.from === "user" ? 0 : 2;
    // Top-level options take no values, so the first non-option token is the command.
    const at = args.findIndex((arg, i) => i >= start && !arg.startsWith("-"));
    if (args[at] === "research") {
      const { normalizeResearchArgs } = await research();
      args.splice(at + 1, Infinity, ...normalizeResearchArgs(args.slice(at + 1)));
    }
    return parseAsync(args, parseOptions);
  };

  return program;
}

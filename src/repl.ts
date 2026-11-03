import { createInterface } from "node:readline/promises";
import { type Command, CommanderError } from "commander";
import { handleOauthRefreshError } from "./commands/shared.js";
import { authSource, getApiKey } from "./core/config.js";
import { ExitError, OAuthError } from "./errors.js";
import { buildProgram } from "./program.js";
import { sanitizeControl } from "./ui/text.js";
import { colorEnabled, colors, LOGO } from "./ui/theme.js";
import { splitShellWords } from "./util/shell-words.js";
import { VERSION } from "./version.js";

export interface ReplOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output?: NodeJS.WritableStream & { columns?: number };
  program?: () => Command;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

const PROMPT = "\x1b[38;2;92;217;230m❯\x1b[0m  ";

async function printBanner(
  say: (line?: string) => void,
  opts: Pick<ReplOptions, "home" | "env">,
): Promise<void> {
  let key: string | null = null;
  try {
    key = await getApiKey(opts);
  } catch (e) {
    if (e instanceof OAuthError) handleOauthRefreshError(e, false);
    throw e;
  }

  say(LOGO);
  say(`  ${colors.dim(`v${VERSION}`)}`);
  say();

  if (key) {
    say(`  ${colors.green(">")} Authenticated via ${authSource(key, opts.env)}`);
  } else {
    say(`  ${colors.pink(">")} Not authenticated`);
    say(`    ${colors.dim("search and extract work without a key (with a rate-limit cap).")}`);
    say(`    Type ${colors.green("init")} for guided setup and skill installation.`);
    say(`    Type ${colors.green("login")} for browser authentication only.`);
  }
  say();

  const sep = colors.dim("  |  ");
  say(
    [
      `  ${colors.bold("Tips: ")}${colors.green("init")}`,
      `${colors.green("search ")}${colors.dim('"query"')}`,
      `${colors.green("extract ")}${colors.dim("<url>")}`,
      `${colors.green("research ")}${colors.dim('"topic"')}`,
      colors.green("update"),
      colors.green("help"),
      colors.green("exit"),
    ].join(sep),
  );
  say();
}

function printHelp(say: (line?: string) => void): void {
  const row = (cmd: string, pad: number, text: string) =>
    `    ${colors.green(cmd)}${" ".repeat(pad)}${text}`;
  say();
  say(`  ${colors.bold("Commands")}`);
  say();
  say(row('search "your query"', 12, "Web search"));
  say(row("extract <url>", 18, "Extract content"));
  say(row("crawl <url>", 20, "Crawl a website"));
  say(row("map <url>", 22, "Discover URLs"));
  say(row('research "topic"', 14, "Deep research"));
  say(row("init", 26, "Guided setup and skill installation"));
  say(row("login", 25, "Browser or API-key authentication"));
  say(row("logout", 24, "Clear credentials"));
  say(row("auth", 26, "Auth status"));
  say(row("update", 24, "Check for or install CLI updates"));
  say(row("exit / quit / Ctrl+C", 10, "Leave"));
}

/** Silence commander's own error text (the REPL prints one line itself); subcommands copy output settings at creation, so walk the tree. */
function silenceErrors(cmd: Command): void {
  cmd.configureOutput({ writeErr: () => {} });
  for (const sub of cmd.commands) silenceErrors(sub);
}

/** Interactive loop: one fresh program per line, errors are reported and never end the session. */
export async function runRepl(opts: ReplOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const makeProgram = opts.program ?? buildProgram;
  const say = (line = "") => {
    output.write(`${line}\n`);
  };
  const goodbye = () => {
    say();
    say(`  ${colors.dim("Goodbye!")}`);
    say();
  };

  say();
  await printBanner(say, opts);

  const rl = createInterface({
    input,
    output,
    terminal: input.isTTY === true,
    historySize: 100,
  });
  rl.setPrompt(colorEnabled() ? PROMPT : "❯  ");

  // Lines are queued so input that arrives while a command runs (or is piped in) is not lost.
  const queue: string[] = [];
  let closed = false;
  let interrupted = false;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  rl.on("line", (l) => {
    queue.push(l);
    notify();
  });
  rl.on("close", () => {
    closed = true;
    notify();
  });
  rl.on("SIGINT", () => {
    interrupted = true;
    notify();
  });

  const nextLine = async (): Promise<string | null> => {
    const width = output.columns ?? 80;
    say(colors.dim("─".repeat(width)));
    if (!closed) rl.prompt();
    while (queue.length === 0 && !closed && !interrupted) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    wake = undefined;
    if (interrupted) return null;
    // EOF behaves like typing `exit`.
    return queue.shift() ?? "exit";
  };

  try {
    for (;;) {
      const raw = await nextLine();
      if (raw === null) {
        goodbye();
        break;
      }
      const line = raw.trim();
      if (!line) continue;
      if (line === "exit" || line === "quit" || line === "q") {
        goodbye();
        break;
      }
      if (line === "help" || line === "?") {
        printHelp(say);
        continue;
      }

      let args: string[];
      try {
        args = splitShellWords(line);
      } catch (e) {
        say(
          `  ${colors.pink("Parse error:")} ${sanitizeControl(e instanceof Error ? e.message : e)}`,
        );
        continue;
      }
      if (args[0] === "tvly") args = args.slice(1);
      if (args.length === 0) continue;

      say();
      if (!closed) rl.pause();
      // Raw mode swallows Ctrl+C; restore cooked mode so a running command can be interrupted.
      const rawCapable = input.isTTY === true && typeof input.setRawMode === "function";
      if (rawCapable) input.setRawMode?.(false);
      try {
        const program = makeProgram();
        silenceErrors(program);
        await program.parseAsync(["node", "tvly", ...args]);
      } catch (e) {
        if (e instanceof ExitError) {
          // commands signal failure with an exit code; the session continues
        } else if (e instanceof CommanderError) {
          if (e.exitCode !== 0) say(`  ${colors.pink(">")} ${sanitizeControl(e.message)}`);
        } else {
          say(
            `  ${colors.pink("> Error:")} ${sanitizeControl(e instanceof Error ? e.message : e)}`,
          );
        }
      } finally {
        if (!closed) {
          if (rawCapable) input.setRawMode?.(true);
          rl.resume();
        }
      }
      say();
    }
  } finally {
    rl.close();
  }
}

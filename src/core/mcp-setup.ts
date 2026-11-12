/**
 * Add the hosted Tavily MCP server to coding agents, Firecrawl's `setup mcp` pattern.
 *
 * The config always points at the hosted server. With TAVILY_API_KEY exported, the config
 * holds a reference the client expands from its own environment at runtime, so the key itself
 * is never written; otherwise the config is the URL alone and the client signs in with OAuth.
 */
import type { Host } from "../host.js";
import type { Exec } from "../util/exec.js";
import { NPX_ADD_MCP_PACKAGE, runNpx } from "./skills.js";

export const MCP_SERVER_URL = "https://mcp.tavily.com/mcp/";
const SERVER_NAME = "tavily";
const KEY_VAR = "TAVILY_API_KEY";

export type McpAuth = "env" | "oauth";

export interface McpSetupResult {
  configured: string[];
  skipped: { agent: string; reason: string }[];
  auth: McpAuth;
}

export const MCP_AUTH_NOTE: Record<McpAuth, string> = {
  env: `Using ${KEY_VAR} from your environment; the key itself is not stored in any config.`,
  oauth: "Your agent will open a browser to sign in to Tavily the first time it uses the server.",
};

/** The Authorization header as each client spells an environment reference. */
const HEADER_REF: Record<string, string> = {
  "claude-code": `Bearer \${${KEY_VAR}}`,
  cursor: `Bearer \${env:${KEY_VAR}}`,
};

export async function installMcp(
  agents: string[],
  keyless: boolean,
  host: Pick<Host, "env" | "exec">,
): Promise<McpSetupResult> {
  const auth: McpAuth = !keyless && host.env[KEY_VAR] ? "env" : "oauth";
  const result: McpSetupResult = { configured: [], skipped: [], auth };
  for (const agent of agents) {
    const reason =
      auth === "env" && agent === "codex"
        ? await codexAdd(host.exec)
        : await addMcp(agent, auth === "env" ? HEADER_REF[agent] : undefined, host.exec);
    if (reason) result.skipped.push({ agent, reason });
    else result.configured.push(agent);
  }
  return result;
}

/** `npx add-mcp` for one agent: the reason it was skipped, or null. Throws without npx. */
async function addMcp(
  agent: string,
  header: string | undefined,
  exec: Exec,
): Promise<string | null> {
  // --yes also keeps add-mcp from prompting for the ${...} placeholder in the header. The header
  // value holds spaces, which only Windows' .cmd fallback (no npx-cli.js) would split.
  const args = [
    "--yes",
    NPX_ADD_MCP_PACKAGE,
    MCP_SERVER_URL,
    "--name",
    SERVER_NAME,
    "--transport",
    "http",
    ...(header ? ["--header", `Authorization: ${header}`] : []),
    "--agent",
    agent,
    "--global",
    "--yes",
  ];
  const completed = await runNpx(args, exec);
  if (!completed) {
    throw new Error(
      "Adding the Tavily MCP server requires Node.js (npx). Install Node.js and rerun.",
    );
  }
  return completed.failure;
}

/** `codex mcp add` reading the key from the environment at runtime. */
async function codexAdd(exec: Exec): Promise<string | null> {
  const codex = exec.which("codex");
  if (!codex) return "codex is not on PATH";
  const args = [
    "mcp",
    "add",
    SERVER_NAME,
    "--url",
    MCP_SERVER_URL,
    "--bearer-token-env-var",
    KEY_VAR,
  ];
  return (await exec.runAsync(codex, args, { timeoutMs: 300_000 })).failure;
}

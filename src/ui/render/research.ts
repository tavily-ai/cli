import { isTerminal, plain, renderMarkdown, sanitizeControl, table } from "../text.js";
import { colors, out } from "../theme.js";
import { emitIfRequested, footer, type Json, list } from "./emit.js";

type Source = { title?: string; url?: string };

export async function printResearchResult(
  data: Json,
  opts: { json: boolean; outputFile?: string | undefined },
): Promise<void> {
  if (emitIfRequested(data, opts)) return;

  const terminal = isTerminal(process.stdout);
  const style = (paint: (s: string) => string, s: string) => (terminal ? paint(s) : s);
  const status = data.status ?? "unknown";
  const content = data.content;
  const sources = list<Source>(data.sources);

  if (status !== "completed") {
    out(`${style(colors.bold, "Status: ")}${sanitizeControl(status)}`);
    if (data.error) out(`${style(colors.pink, "Error: ")}${sanitizeControl(data.error)}`);
    return;
  }

  if (!terminal) {
    if (content) out(`${plain(content)}\n`);
    if (sources.length > 0) {
      out("Sources:");
      sources.forEach((s, i) => {
        out(`${i + 1}. ${plain(s.title ?? "")} ${plain(s.url ?? "")}`);
      });
    }
    return;
  }

  if (content) {
    out();
    out(`  ${colors.bold(colors.aqua("Research Report"))}`);
    out();
    out(await renderMarkdown(String(content)));
  }
  if (sources.length > 0) {
    out();
    out(colors.bold(`Sources (${sources.length})`));
    const rows = sources.map((s, i) => [
      String(i + 1),
      sanitizeControl(s.title ?? ""),
      sanitizeControl(s.url ?? ""),
    ]);
    out(table(["#", "Title", "URL"], rows));
  }
  footer(sources.length, "sources", data.response_time);
}

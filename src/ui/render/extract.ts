import { hostOf, isTerminal, plain, renderMarkdown, sanitizeControl } from "../text.js";
import { colors, out } from "../theme.js";
import { echoPages, emitIfRequested, footer, type Json, list, type Page } from "./emit.js";

type Failure = { url?: string; error?: string };

export async function printExtractResults(
  data: Json,
  opts: { json: boolean; outputFile?: string | undefined },
): Promise<void> {
  if (emitIfRequested(data, opts)) return;
  const results = list<Page>(data.results);
  const failed = list<Failure>(data.failed_results);

  if (!isTerminal(process.stdout)) {
    echoPages(results);
    for (const f of failed) out(`Failed: ${plain(f.url)}: ${plain(f.error)}`);
    return;
  }

  for (const r of results) {
    const url = r.url ?? "";
    const raw = r.raw_content ?? "";
    out();
    out(`  ${colors.bold(colors.aqua(sanitizeControl(url)))}`);
    out(
      colors.dim(`  ${sanitizeControl(hostOf(url))} (${raw.length.toLocaleString("en-US")} chars)`),
    );
    out();
    out(raw ? await renderMarkdown(raw.slice(0, 3000)) : `  ${colors.dim("No content")}`);
    out();
  }
  if (failed.length > 0) {
    out(colors.yellow("Failed extractions:"));
    for (const f of failed) {
      out(`  ${colors.pink("x ")}${sanitizeControl(f.url)}: ${sanitizeControl(f.error)}`);
    }
  }
  footer(results.length, `extracted, ${failed.length} failed`, data.response_time);
}

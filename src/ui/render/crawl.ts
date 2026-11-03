import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isTerminal, sanitizeControl, tree } from "../text.js";
import { colors, err, out } from "../theme.js";
import { echoPages, emitIfRequested, footer, type Json, list, type Page } from "./emit.js";

/** `<host><path>` with anything outside `[\w.-]` as `_`, e.g. `a.example_docs_intro`; `index` when empty. */
function slugOf(url: string): string {
  let location = url;
  try {
    const parsed = new URL(url);
    location = parsed.host + parsed.pathname.replace(/\/+$/, "");
  } catch {
    // an unparseable URL slugs as its own text
  }
  return location.replace(/[^\p{L}\p{N}_\-.]/gu, "_").replace(/^_+|_+$/g, "") || "index";
}

/** Write each page that has content to `<dir>/<slug>.md` as `# <url>`, a blank line, and the content. */
export function saveCrawlToDir(data: Json, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const pages = list<Page>(data.results);
  for (const page of pages) {
    if (!page.raw_content) continue;
    writeFileSync(
      path.join(dir, `${slugOf(page.url ?? "")}.md`),
      `# ${page.url ?? ""}\n\n${page.raw_content}\n`,
    );
  }
  err(`Saved ${pages.length} pages to ${dir}/`);
}

export function printCrawlResults(
  data: Json,
  opts: { json: boolean; outputFile?: string | undefined; outputDir?: string | undefined },
): void {
  if (opts.outputDir) {
    saveCrawlToDir(data, opts.outputDir);
    return;
  }
  if (emitIfRequested(data, opts)) return;
  const pages = list<Page>(data.results);

  if (!isTerminal(process.stdout)) {
    echoPages(pages);
    return;
  }

  const nodes = pages.map((page) => {
    const url = page.url ?? "";
    const raw = page.raw_content ?? "";
    let pathname = url;
    try {
      pathname = new URL(url).pathname || "/";
    } catch {
      // malformed URLs show as given
    }
    const label = `${colors.aqua(sanitizeControl(pathname))}${colors.dim(`  (${raw.length.toLocaleString("en-US")} chars)`)}`;
    const preview = raw.trim().split("\n")[0]?.slice(0, 120);
    return { label, children: preview ? [colors.dim(sanitizeControl(preview))] : [] };
  });
  out(tree(colors.bold(sanitizeControl(data.base_url ?? "")), nodes));
  footer(pages.length, "pages", data.response_time);
}

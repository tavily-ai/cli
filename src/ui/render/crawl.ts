import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isTerminal, plain, safeLink, sanitizeControl, tree } from "../text.js";
import { colors, err, out } from "../theme.js";
import { echoPages, emitIfRequested, footer, type Json, list, type Page } from "./emit.js";

/** `<host><path><query>` with anything outside `[\w.-]` as `_`, e.g. `a.example_docs_intro`; `index` when empty. */
function slugOf(url: string): string {
  let location = url;
  try {
    const parsed = new URL(url);
    location = parsed.host + parsed.pathname.replace(/\/+$/, "") + parsed.search;
  } catch {
    // an unparseable URL slugs as its own text
  }
  return location.replace(/[^\p{L}\p{N}_\-.]/gu, "_").replace(/^_+|_+$/g, "") || "index";
}

/**
 * Write each page that has content to `<dir>/<slug>.md` as `# <url>`, a blank line, and the content.
 * A slug already used in this run gets the first 6 hex of the URL's sha1 appended.
 */
function saveCrawlToDir(data: Json, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  for (const page of list<Page>(data.results)) {
    if (!page.raw_content) continue;
    const url = page.url ?? "";
    let name = slugOf(url);
    // Lower-cased so case-insensitive filesystems cannot collide either.
    if (used.has(name.toLowerCase())) {
      name += `-${createHash("sha1").update(url).digest("hex").slice(0, 6)}`;
    }
    used.add(name.toLowerCase());
    writeFileSync(path.join(dir, `${name}.md`), `# ${url}\n\n${page.raw_content}\n`);
  }
  err(`Saved ${used.size} pages to ${dir}/`);
}

export function printCrawlResults(
  data: Json,
  opts: { json: boolean; outputFile?: string | undefined; outputDir?: string | undefined },
): void {
  if (opts.outputDir) {
    saveCrawlToDir(data, opts.outputDir);
    emitIfRequested(data, opts);
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

export function printMapResults(
  data: Json,
  opts: { json: boolean; outputFile?: string | undefined },
): void {
  if (emitIfRequested(data, opts)) return;
  const urls = list<string>(data.results);

  if (!isTerminal(process.stdout)) {
    for (const url of urls) out(plain(url));
    return;
  }

  out(
    tree(
      colors.bold(sanitizeControl(data.base_url ?? "")),
      urls.map((url) => ({ label: safeLink(url, undefined, { stream: process.stdout }) })),
    ),
  );
  footer(urls.length, "URLs", data.response_time);
}

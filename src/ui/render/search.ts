import { isTerminal, plain, renderMarkdown, safeLink, sanitizeControl, snippet } from "../text.js";
import { colors, out } from "../theme.js";
import { emit, footer, type Json, list } from "./emit.js";

type SearchResult = { title?: string; url?: string; content?: string; score?: number };
type Image = string | { url?: string };

// An image object without a url prints as JSON, as the Python CLI printed the dict.
const imageUrl = (img: Image): string =>
  typeof img === "object" && img !== null ? (img.url ?? JSON.stringify(img)) : img;

export interface SearchPrintOptions {
  json: boolean;
  outputFile?: string | undefined;
  maxChars?: number;
}

export async function printSearchResults(data: Json, opts: SearchPrintOptions): Promise<void> {
  const maxChars = opts.maxChars ?? 600;
  if (opts.json || opts.outputFile) {
    emit(data, { outputFile: opts.outputFile, pretty: true });
    // At a terminal -o only saves; elsewhere the snippets print too, so an agent can skim them and
    // read the saved file for the results worth more.
    if (opts.json || isTerminal(process.stdout)) return;
  }

  const results = list<SearchResult>(data.results);
  const images = list<Image>(data.images);
  const answer = data.answer;

  if (!isTerminal(process.stdout)) {
    if (answer) out(`Answer: ${plain(answer)}\n`);
    results.forEach((r, i) => {
      out(`${i + 1}. ${plain(r.title || "Untitled")}`);
      out(plain(r.url ?? ""));
      if (r.content) out(snippet(r.content, maxChars));
      out();
    });
    if (results.length === 0) out("No results found.");
    for (const img of images) out(`Image: ${plain(imageUrl(img))}`);
    return;
  }

  if (answer) {
    out();
    out(`  ${colors.bold(colors.aqua("Answer"))}`);
    out();
    out(await renderMarkdown(String(answer)));
    out();
  }
  if (results.length === 0) {
    out(colors.dim("No results found."));
    return;
  }
  results.forEach((r, i) => {
    const score = typeof r.score === "number" ? colors.dim(` score: ${r.score.toFixed(2)}`) : "";
    out(
      `${colors.bold(colors.purple(`${i + 1}. `))}${colors.bold(sanitizeControl(r.title ?? "Untitled"))}  ${score}`,
    );
    out(`   ${colors.pink(safeLink(r.url ?? "", undefined, { stream: process.stdout }))}`);
    if (r.content) out(`   ${colors.dim(snippet(r.content, maxChars))}`);
    out();
  });
  footer(results.length, "results", data.response_time);
  if (images.length > 0) {
    out();
    out(colors.bold(`Images (${images.length}):`));
    for (const img of images) out(`  ${sanitizeControl(imageUrl(img))}`);
  }
}

/** Several searches from one command, in query order; a failed query carries `error` in place of results. */
export async function printMultiSearchResults(
  responses: Json[],
  opts: SearchPrintOptions,
): Promise<void> {
  if (opts.json || opts.outputFile) {
    emit(responses, { outputFile: opts.outputFile, pretty: true });
    if (opts.json || isTerminal(process.stdout)) return;
  }
  const terminal = isTerminal(process.stdout);
  for (const [i, r] of responses.entries()) {
    const header = `=== [${i + 1}/${responses.length}] ${plain(r.query ?? "")}`;
    out(terminal ? colors.bold(header) : header);
    if ("error" in r) {
      const error = r.error;
      const text = typeof error === "object" && error !== null ? (error as Json).message : error;
      out(`error: ${plain(text)}\n`);
    } else {
      await printSearchResults(r, {
        json: false,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      });
    }
  }
}

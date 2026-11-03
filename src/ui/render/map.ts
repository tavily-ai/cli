import { isTerminal, plain, safeLink, sanitizeControl, tree } from "../text.js";
import { colors, out } from "../theme.js";
import { emitIfRequested, footer, type Json, list } from "./emit.js";

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

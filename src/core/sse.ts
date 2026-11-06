/** Yields the payload of each SSE `data:` line, buffering partial lines across chunks. */
export async function* sseDataLines(chunks: AsyncIterable<Buffer | string>): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const payload = dataPayload(line);
      if (payload !== undefined) yield payload;
    }
  }
  buffer += decoder.decode();
  const payload = dataPayload(buffer);
  if (payload !== undefined) yield payload;
}

/** The payload of one SSE `data:` line, or undefined for any other line. */
export function dataPayload(rawLine: string): string | undefined {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line.startsWith("data:")) return undefined;
  const rest = line.slice(5);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

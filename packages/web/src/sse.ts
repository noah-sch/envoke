/**
 * Incremental Server-Sent Events parser: feed it text chunks as they arrive, get back the `data`
 * payload of every complete event. Handles CRLF and events split across chunks.
 */
export class SseParser {
  #buffer = "";

  push(chunk: string): string[] {
    this.#buffer += chunk.replace(/\r\n?/g, "\n");
    const out: string[] = [];
    let end: number;
    while ((end = this.#buffer.indexOf("\n\n")) !== -1) {
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  }
}

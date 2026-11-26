export const MAX_OUTPUT_CHARS = 30_000;

/** Keeps the start and the end of a long text, with a note of what was cut. */
export function truncateMiddle(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const cut = text.length - 2 * half;
  return `${text.slice(0, half)}\n… [${cut} caractères coupés] …\n${text.slice(-half)}`;
}

/**
 * Collects a stream without holding more than `max` characters: the head is kept whole, the
 * tail is a rolling window. Lets `yes | head -c 5000000` run without buffering 5 MB.
 */
export class BoundedOutput {
  readonly #half: number;
  #head = "";
  #tail = "";
  #total = 0;

  constructor(max = MAX_OUTPUT_CHARS) {
    this.#half = Math.floor(max / 2);
  }

  push(chunk: string): void {
    this.#total += chunk.length;
    if (this.#head.length < this.#half) {
      const room = this.#half - this.#head.length;
      this.#head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk.length > 0) this.#tail = (this.#tail + chunk).slice(-this.#half);
  }

  toString(): string {
    const cut = this.#total - this.#head.length - this.#tail.length;
    if (cut <= 0) return this.#head + this.#tail;
    return `${this.#head}\n… [${cut} caractères coupés] …\n${this.#tail}`;
  }
}

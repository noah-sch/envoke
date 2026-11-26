/** Push-based async iterable: callbacks push, one consumer iterates. */
export class EventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null = null;
  #ended = false;
  #error: unknown = null;

  push(item: T): void {
    if (this.#ended) return;
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = null;
      waiting.resolve({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#waiting?.resolve({ value: undefined, done: true });
    this.#waiting = null;
  }

  fail(error: unknown): void {
    if (this.#ended) return;
    this.#error = error;
    this.#ended = true;
    this.#waiting?.reject(error);
    this.#waiting = null;
  }

  get ended(): boolean {
    return this.#ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.#waiting = { resolve, reject };
        });
      },
    };
  }
}

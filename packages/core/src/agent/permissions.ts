import { randomUUID } from "node:crypto";
import type { Tool } from "../tools/tool.ts";
import type { Decision } from "../types.ts";

interface Pending {
  sessionId: string;
  settle: (decision: Decision) => void;
}

/**
 * Routes permission questions to whoever answers them (HTTP route, CLI prompt) and keeps the
 * session's "always allow" rules. Rules live in memory only: they reset when the app restarts.
 */
export class PermissionBroker {
  readonly #pending = new Map<string, Pending>();
  readonly #rules = new Map<string, Set<string>>();

  /** Opens a question. The decision is "deny" if the signal aborts first. */
  request(
    sessionId: string,
    signal: AbortSignal,
  ): { requestId: string; decision: Promise<Decision> } {
    const requestId = randomUUID();
    const decision = new Promise<Decision>((resolve) => {
      const onAbort = () => settle("deny");
      const settle = (d: Decision) => {
        if (!this.#pending.delete(requestId)) return;
        signal.removeEventListener("abort", onAbort);
        resolve(d);
      };
      this.#pending.set(requestId, { sessionId, settle });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return { requestId, decision };
  }

  /** Returns false when the request is unknown or already answered. */
  resolve(requestId: string, decision: Decision): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    pending.settle(decision);
    return true;
  }

  sessionOf(requestId: string): string | undefined {
    return this.#pending.get(requestId)?.sessionId;
  }

  allows<I>(sessionId: string, tool: Tool<I>, input: I): boolean {
    const rules = this.#rules.get(sessionId);
    if (!rules) return false;
    for (const rule of rules) {
      const [name, ...rest] = rule.split("\u0000");
      if (name === tool.name && tool.matchesRule(rest.join("\u0000"), input)) return true;
    }
    return false;
  }

  /** Remembers "always allow" for the session. Returns false when the input cannot be covered. */
  remember<I>(sessionId: string, tool: Tool<I>, input: I): boolean {
    const rule = tool.ruleFor(input);
    if (rule === null) return false;
    let rules = this.#rules.get(sessionId);
    if (!rules) this.#rules.set(sessionId, (rules = new Set()));
    rules.add(`${tool.name}\u0000${rule}`);
    return true;
  }

  forgetSession(sessionId: string): void {
    this.#rules.delete(sessionId);
    for (const [requestId, pending] of this.#pending) {
      if (pending.sessionId === sessionId) this.resolve(requestId, "deny");
    }
  }
}

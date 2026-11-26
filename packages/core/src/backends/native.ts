import { runTurn } from "../agent/loop.ts";
import type { PermissionBroker } from "../agent/permissions.ts";
import { buildSystemPrompt } from "../agent/system-prompt.ts";
import { EnvokeError } from "../errors.ts";
import type { SessionStore } from "../store.ts";
import type { Tool } from "../tools/tool.ts";
import type { AgentBackend, AgentEvent, ModelProvider, SendOptions } from "../types.ts";

export interface NativeBackendOptions {
  provider: ModelProvider;
  /** Resolved lazily: the ChatGPT model list is only known once the account is linked. */
  model: () => Promise<string>;
  tools: Tool[];
  store: SessionStore;
  broker: PermissionBroker;
}

/** Our loop, our tools, our permission gate, on top of any ModelProvider. */
export class NativeBackend implements AgentBackend {
  readonly #o: NativeBackendOptions;

  constructor(options: NativeBackendOptions) {
    this.#o = options;
  }

  async *send(
    sessionId: string,
    userText: string,
    signal: AbortSignal,
    options: SendOptions = {},
  ): AsyncGenerator<AgentEvent> {
    const session = this.#o.store.getSession(sessionId);
    if (!session) throw new EnvokeError("not_found", `Session inconnue : ${sessionId}`);
    yield* runTurn({
      sessionId,
      provider: this.#o.provider,
      model: await this.#o.model(),
      system: buildSystemPrompt({ cwd: session.cwd }),
      tools: this.#o.tools,
      history: this.#o.store.loadMessages(sessionId),
      userText,
      cwd: session.cwd,
      signal,
      broker: this.#o.broker,
      append: (message) => this.#o.store.appendMessage(sessionId, message),
      audit: (entry) => this.#o.store.logCommand(entry),
      ...(options.effort ? { effort: options.effort } : {}),
    });
  }

  async dispose(): Promise<void> {}
}

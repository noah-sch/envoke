import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolUnion,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { EnvokeError } from "../errors.ts";
import type {
  ContentPart,
  Effort,
  Message,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  StopReason,
} from "../types.ts";

export interface AnthropicOptions {
  apiKey: string;
  baseURL?: string;
  effort?: Effort;
  /** Stream readable summaries of the model's reasoning (adaptive thinking, display: summarized). */
  showThinking?: boolean;
  /** Server-side fallback when the model refuses (beta server-side-fallback-2026-07-01). */
  fallbacks?: boolean;
  maxTokens?: number;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_JSON_RETRIES = 2;

export function createAnthropicProvider(options: AnthropicOptions): ModelProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  return {
    kind: "anthropic",
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const params: MessageCreateParamsStreaming = {
        model: req.model,
        max_tokens: options.maxTokens ?? 64_000,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.map((t): BetaToolUnion => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as BetaToolUnion extends { input_schema: infer S }
            ? S
            : never,
          // Inputs stream as generated; every tool validates its input with zod before running.
          eager_input_streaming: true,
        })),
        // Automatic prompt caching: the stable prefix (tools, system, history) is reused each turn.
        cache_control: { type: "ephemeral" },
        stream: true,
        ...((req.effort ?? options.effort)
          ? { output_config: { effort: req.effort ?? options.effort } }
          : {}),
        ...(options.showThinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
        ...(options.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {}),
      };

      for (let attempt = 0; ; attempt++) {
        let emitted = false;
        try {
          const stream = client.beta.messages.stream(params, { signal: req.signal });
          for await (const event of stream) {
            if (event.type !== "content_block_delta") continue;
            if (event.delta.type === "text_delta") {
              emitted = true;
              yield { type: "text_delta", text: event.delta.text };
            } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
              emitted = true;
              yield { type: "thinking_delta", text: event.delta.thinking };
            }
          }
          const message = await stream.finalMessage();
          yield {
            type: "usage",
            inputTokens:
              message.usage.input_tokens +
              (message.usage.cache_read_input_tokens ?? 0) +
              (message.usage.cache_creation_input_tokens ?? 0),
            outputTokens: message.usage.output_tokens,
          };
          yield {
            type: "done",
            stopReason: mapStopReason(message.stop_reason),
            message: fromAnthropic(message.content),
          };
          return;
        } catch (error) {
          // A tool input the SDK could not parse at all (eager streaming) or a dropped connection:
          // re-issue the turn, unless text already reached the user.
          const retryable =
            !(error instanceof Anthropic.APIError) &&
            !req.signal.aborted &&
            !emitted &&
            attempt < MAX_JSON_RETRIES;
          if (retryable) continue;
          throw toError(error, req.signal);
        }
      }
    },
  };
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end";
  }
}

function fromAnthropic(content: BetaContentBlock[]): Message {
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ type: "text", text: block.text });
    else if (block.type === "tool_use")
      parts.push({ type: "tool_call", id: block.id, name: block.name, input: block.input });
  }
  // Thinking and fallback blocks are replayed unchanged on the next request.
  return { role: "assistant", parts, native: { provider: "anthropic", data: content } };
}

export function toAnthropicMessages(messages: Message[]): BetaMessageParam[] {
  return messages.map((m): BetaMessageParam => {
    if (m.role === "assistant") {
      if (m.native?.provider === "anthropic") {
        return { role: "assistant", content: m.native.data as BetaContentBlockParam[] };
      }
      const content: BetaContentBlockParam[] = [];
      for (const p of m.parts) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
        if (p.type === "tool_call")
          content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
      }
      return { role: "assistant", content };
    }
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.parts
          .filter((p) => p.type === "tool_result")
          .map((p) => ({
            type: "tool_result",
            tool_use_id: p.toolCallId,
            content: p.output,
            is_error: p.isError,
          })),
      };
    }
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return { role: "user", content: text };
  });
}

function toError(error: unknown, signal: AbortSignal): EnvokeError {
  if (error instanceof Anthropic.APIUserAbortError || signal.aborted) {
    return new EnvokeError("aborted", "Interrompu.");
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new EnvokeError("auth", "Clé API Anthropic invalide ou absente.", { cause: error });
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new EnvokeError("auth", "Accès refusé par Anthropic pour cette clé.", { cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new EnvokeError(
      "rate_limit",
      "Limite de débit Anthropic atteinte, réessayez dans un instant.",
      { cause: error },
    );
  }
  if (error instanceof Anthropic.OverloadedError) {
    return new EnvokeError("overloaded", "Anthropic est surchargé, réessayez dans un instant.", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new EnvokeError("server", "Erreur du serveur Anthropic, réessayez dans un instant.", {
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new EnvokeError(
      "network",
      "Impossible de joindre Anthropic : vérifiez votre connexion.",
      {
        cause: error,
      },
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new EnvokeError("bad_request", `Requête refusée par Anthropic : ${error.message}`, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new EnvokeError("server", `Réponse Anthropic illisible : ${message}`, { cause: error });
}

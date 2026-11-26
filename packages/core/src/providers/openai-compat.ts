import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { EnvokeError } from "../errors.ts";
import type {
  ContentPart,
  Message,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  StopReason,
} from "../types.ts";
import { parseArguments, toOpenAIError } from "./openai-errors.ts";

export interface CompatOptions {
  baseURL: string;
  /** Null for servers without auth (Ollama). */
  apiKey: string | null;
  /** Shown in error messages. */
  name: string;
}

/** Chat Completions: Mistral, OpenRouter, Gemini's OpenAI endpoint, Ollama, vLLM… */
export function createCompatProvider(options: CompatOptions): ModelProvider {
  const client = new OpenAI({ baseURL: options.baseURL, apiKey: options.apiKey ?? "none" });

  return {
    kind: "openai-compat",
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      let text = "";
      let finish: string | null = null;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      try {
        const stream = await client.chat.completions.create(
          {
            model: req.model,
            messages: toChatMessages(req.system, req.messages),
            ...(req.tools.length > 0
              ? {
                  tools: req.tools.map((t) => ({
                    type: "function" as const,
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.inputSchema,
                    },
                  })),
                }
              : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: req.signal },
        );
        for await (const chunk of stream) {
          if (chunk.usage) {
            yield {
              type: "usage",
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            };
          }
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.delta.content) {
            text += choice.delta.content;
            yield { type: "text_delta", text: choice.delta.content };
          }
          // Tool calls arrive in fragments keyed by index: id and name first, arguments in pieces.
          for (const fragment of choice.delta.tool_calls ?? []) {
            let call = calls.get(fragment.index);
            if (!call) calls.set(fragment.index, (call = { id: "", name: "", args: "" }));
            if (fragment.id) call.id = fragment.id;
            if (fragment.function?.name) call.name += fragment.function.name;
            if (fragment.function?.arguments) call.args += fragment.function.arguments;
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch (error) {
        throw toOpenAIError(error, req.signal, options.name);
      }
      if (finish === null)
        throw new EnvokeError("network", `Flux ${options.name} interrompu avant la fin.`);

      const parts: ContentPart[] = text ? [{ type: "text", text }] : [];
      for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        parts.push({
          type: "tool_call",
          id: call.id || `call_${index}`,
          name: call.name,
          input: parseArguments(call.args),
        });
      }
      yield {
        type: "done",
        stopReason: mapFinish(finish, calls.size > 0),
        message: { role: "assistant", parts },
      };
    },
  };
}

function mapFinish(finish: string, hasCalls: boolean): StopReason {
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  return hasCalls ? "tool_calls" : "end";
}

export function toChatMessages(system: string, messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
      });
    } else if (m.role === "tool") {
      for (const p of m.parts) {
        if (p.type === "tool_result")
          out.push({ role: "tool", tool_call_id: p.toolCallId, content: p.output });
      }
    } else {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
      const toolCalls = m.parts
        .filter((p) => p.type === "tool_call")
        .map((p) => ({
          id: p.id,
          type: "function" as const,
          function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  return out;
}

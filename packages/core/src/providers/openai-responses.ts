import OpenAI from "openai";
import type {
  Response,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
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
import { fromPlanErrorCode, parseArguments, toOpenAIError } from "./openai-errors.ts";

export interface ResponsesOptions {
  /** Called before every request: an API key, or a fresh ChatGPT access token. */
  getToken: () => Promise<string>;
  baseURL?: string;
  /** "chatgpt" follows the Sign in with ChatGPT rules (no SDK retries, plan error codes). */
  mode: "api_key" | "chatgpt";
  effort?: Effort;
  showThinking?: boolean;
}

/**
 * Responses API, stateless (`store: false`): the whole history is sent each turn. Reasoning items
 * come back encrypted and are replayed as-is, so the model keeps its reasoning across tool calls.
 */
export function createResponsesProvider(options: ResponsesOptions): ModelProvider {
  const name = options.mode === "chatgpt" ? "ChatGPT" : "OpenAI";

  return {
    kind: "openai-responses",
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const effort = req.effort ?? options.effort;
      const reasoning = effort !== undefined || options.mode === "chatgpt";
      let final: Response | undefined;
      try {
        const client = new OpenAI({
          apiKey: await options.getToken(),
          baseURL: options.baseURL ?? "https://api.openai.com/v1",
          maxRetries: options.mode === "chatgpt" ? 0 : 2,
        });
        const stream = await client.responses.create(
          {
            model: req.model,
            instructions: req.system,
            input: toResponsesInput(req.messages),
            tools: req.tools.map((t) => ({
              type: "function" as const,
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
              strict: false,
            })),
            store: false,
            stream: true,
            ...(reasoning
              ? {
                  include: ["reasoning.encrypted_content" as const],
                  reasoning: {
                    ...(effort ? { effort: mapEffort(effort) } : {}),
                    ...(options.showThinking ? { summary: "auto" as const } : {}),
                  },
                }
              : {}),
          },
          { signal: req.signal },
        );
        for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
          switch (event.type) {
            case "response.output_text.delta":
              yield { type: "text_delta", text: event.delta };
              break;
            case "response.reasoning_summary_text.delta":
              yield { type: "thinking_delta", text: event.delta };
              break;
            case "response.completed":
            case "response.incomplete":
              final = event.response;
              break;
            case "response.failed": {
              const e = event.response.error;
              throw (
                fromPlanErrorCode(e?.code, e?.message ?? "") ??
                new EnvokeError("server", `Échec ${name} : ${e?.message ?? "raison inconnue"}`)
              );
            }
            case "error":
              throw (
                fromPlanErrorCode(event.code, event.message) ??
                new EnvokeError("server", `Erreur ${name} : ${event.message}`)
              );
          }
        }
      } catch (error) {
        throw toOpenAIError(error, req.signal, name);
      }
      // Only a completed response counts: an interrupted stream is an error, not an answer.
      if (!final) throw new EnvokeError("network", `Flux ${name} interrompu avant la fin.`);

      yield {
        type: "usage",
        inputTokens: final.usage?.input_tokens ?? 0,
        outputTokens: final.usage?.output_tokens ?? 0,
      };
      const message = fromResponses(final.output);
      yield { type: "done", stopReason: stopReason(final, message), message };
    },
  };
}

/** The Responses API has no "max"/"xhigh" on every model: map to its closest level. */
function mapEffort(effort: Effort): "low" | "medium" | "high" | "xhigh" {
  return effort === "max" ? "xhigh" : effort;
}

function stopReason(response: Response, message: Message): StopReason {
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens";
  }
  return message.parts.some((p) => p.type === "tool_call") ? "tool_calls" : "end";
}

function fromResponses(output: ResponseOutputItem[]): Message {
  const parts: ContentPart[] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const c of item.content) {
        if (c.type === "output_text") parts.push({ type: "text", text: c.text });
        else if (c.type === "refusal") parts.push({ type: "text", text: c.refusal });
      }
    } else if (item.type === "function_call") {
      parts.push({
        type: "tool_call",
        id: item.call_id,
        name: item.name,
        input: parseArguments(item.arguments),
      });
    }
  }
  return { role: "assistant", parts, native: { provider: "openai-responses", data: output } };
}

export function toResponsesInput(messages: Message[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      input.push({
        role: "user",
        content: m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
      });
    } else if (m.role === "tool") {
      for (const p of m.parts) {
        if (p.type === "tool_result")
          input.push({ type: "function_call_output", call_id: p.toolCallId, output: p.output });
      }
    } else if (m.native?.provider === "openai-responses") {
      for (const item of m.native.data as ResponseOutputItem[]) {
        // store:false — stored ids cannot be referenced; reasoning items carry their encrypted content.
        if (item.type === "reasoning") input.push(item);
        else if (item.type === "message" || item.type === "function_call") {
          const { id: _id, ...rest } = item;
          input.push(rest as ResponseInputItem);
        }
      }
    } else {
      for (const p of m.parts) {
        if (p.type === "text" && p.text) input.push({ role: "assistant", content: p.text });
        if (p.type === "tool_call") {
          input.push({
            type: "function_call",
            call_id: p.id,
            name: p.name,
            arguments: JSON.stringify(p.input ?? {}),
          });
        }
      }
    }
  }
  return input;
}

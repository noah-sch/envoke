import { afterEach, describe, expect, it } from "vitest";
import {
  createAnthropicProvider,
  createCompatProvider,
  createResponsesProvider,
  EnvokeError,
  type Message,
  type ModelEvent,
  type ModelProvider,
} from "../src/index.ts";
import { fakeServer, sse, type FakeServer } from "./helpers.ts";

const TOOLS = [
  {
    name: "bash",
    description: "run",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

/** A conversation with an earlier tool call coming from another provider (no native payload). */
const HISTORY: Message[] = [
  { role: "user", parts: [{ type: "text", text: "liste" }] },
  {
    role: "assistant",
    parts: [{ type: "tool_call", id: "c0", name: "bash", input: { command: "ls" } }],
  },
  {
    role: "tool",
    parts: [{ type: "tool_result", toolCallId: "c0", output: "a\nb", isError: false }],
  },
  { role: "user", parts: [{ type: "text", text: "et maintenant ?" }] },
];

const anthropicStream = [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
        },
      },
    },
  },
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "je réfléchis" },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig123" },
    },
  },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  {
    event: "content_block_start",
    data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Bon" } },
  },
  {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "jour" } },
  },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
  {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '"ls"}' },
    },
  },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 20 },
    },
  },
  { event: "message_stop", data: { type: "message_stop" } },
];

const responsesOutput = [
  { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
  {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Bonjour", annotations: [] }],
  },
  {
    type: "function_call",
    id: "fc_1",
    call_id: "toolu_1",
    name: "bash",
    arguments: '{"command":"ls"}',
    status: "completed",
  },
];

const responsesStream = [
  {
    event: "response.created",
    data: {
      type: "response.created",
      sequence_number: 0,
      response: { id: "r1", status: "in_progress", output: [] },
    },
  },
  {
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      delta: "Bon",
      logprobs: [],
    },
  },
  {
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      delta: "jour",
      logprobs: [],
    },
  },
  {
    event: "response.completed",
    data: {
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "r1",
        object: "response",
        status: "completed",
        output: responsesOutput,
        usage: { input_tokens: 15, output_tokens: 20, total_tokens: 35 },
      },
    },
  },
];

const chunk = (delta: object, finish: string | null = null) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 0,
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const chatStream = [
  { data: chunk({ role: "assistant", content: "Bon" }) },
  { data: chunk({ content: "jour" }) },
  {
    data: chunk({
      tool_calls: [
        { index: 0, id: "toolu_1", type: "function", function: { name: "bash", arguments: "" } },
      ],
    }),
  },
  { data: chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }) },
  { data: chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, "tool_calls") },
  {
    data: {
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [],
      usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
    },
  },
  { data: "[DONE]" },
];

interface Adapter {
  name: string;
  stream: Array<{ event?: string; data: unknown }>;
  make(url: string): ModelProvider;
  /** Asserts that the earlier tool call and its result were sent in the provider's format. */
  checkHistory(body: Record<string, unknown>): void;
}

const adapters: Adapter[] = [
  {
    name: "anthropic",
    stream: anthropicStream,
    make: (url) => createAnthropicProvider({ apiKey: "sk-test", baseURL: url }),
    checkHistory(body) {
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      expect(messages[1]).toEqual({
        role: "assistant",
        content: [{ type: "tool_use", id: "c0", name: "bash", input: { command: "ls" } }],
      });
      expect(messages[2]).toEqual({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c0", content: "a\nb", is_error: false }],
      });
      expect(body.cache_control).toEqual({ type: "ephemeral" });
      expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
        name: "bash",
        eager_input_streaming: true,
      });
    },
  },
  {
    name: "openai-responses",
    stream: responsesStream,
    make: (url) =>
      createResponsesProvider({ mode: "api_key", getToken: async () => "sk-test", baseURL: url }),
    checkHistory(body) {
      expect(body.store).toBe(false);
      expect(body.instructions).toBe("system");
      expect(body.input).toEqual([
        { role: "user", content: "liste" },
        { type: "function_call", call_id: "c0", name: "bash", arguments: '{"command":"ls"}' },
        { type: "function_call_output", call_id: "c0", output: "a\nb" },
        { role: "user", content: "et maintenant ?" },
      ]);
    },
  },
  {
    name: "openai-compat",
    stream: chatStream,
    make: (url) => createCompatProvider({ baseURL: url, apiKey: "sk-test", name: "Test" }),
    checkHistory(body) {
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]).toEqual({ role: "system", content: "system" });
      expect(messages[2]).toMatchObject({
        role: "assistant",
        tool_calls: [{ id: "c0", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      });
      expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c0", content: "a\nb" });
    },
  },
];

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function run(provider: ModelProvider, messages: Message[] = HISTORY): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const e of provider.stream({
    model: "m",
    system: "system",
    messages,
    tools: TOOLS,
    signal: new AbortController().signal,
  })) {
    events.push(e);
  }
  return events;
}

describe.each(adapters)("conformance: $name", (adapter) => {
  it("streams text, then returns the tool call and usage", async () => {
    server = await fakeServer((_req, res) => sse(res, adapter.stream));
    const events = await run(adapter.make(server.url));
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toBe("Bonjour");
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ type: "usage", inputTokens: 15, outputTokens: 20 });
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") return;
    expect(done.stopReason).toBe("tool_calls");
    expect(done.message.parts).toEqual([
      { type: "text", text: "Bonjour" },
      { type: "tool_call", id: "toolu_1", name: "bash", input: { command: "ls" } },
    ]);
    adapter.checkHistory(JSON.parse(server.requests[0]!.body) as Record<string, unknown>);
  });

  it("maps a 401 to a readable auth error", async () => {
    server = await fakeServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "bad key" },
        }),
      );
    });
    const error = await run(adapter.make(server.url)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnvokeError);
    expect((error as EnvokeError).code).toBe("auth");
  });
});

describe("native payload replay", () => {
  it("anthropic: thinking blocks go back unchanged", async () => {
    server = await fakeServer((_req, res) => sse(res, anthropicStream));
    const provider = createAnthropicProvider({ apiKey: "sk-test", baseURL: server.url });
    const first = (await run(provider)).at(-1);
    if (first?.type !== "done") throw new Error("no done");
    await run(provider, [...HISTORY, first.message]);
    const body = JSON.parse(server.requests[1]!.body) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages.at(-1)!.content[0]).toEqual({
      type: "thinking",
      thinking: "je réfléchis",
      signature: "sig123",
    });
  });

  it("anthropic: effort, adaptive thinking and server-side fallback are sent when enabled", async () => {
    server = await fakeServer((_req, res) => sse(res, anthropicStream));
    await run(
      createAnthropicProvider({
        apiKey: "k",
        baseURL: server.url,
        effort: "high",
        showThinking: true,
        fallbacks: true,
      }),
    );
    const request = server.requests[0]!;
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.fallbacks).toBe("default");
    expect(request.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
  });

  it("responses: encrypted reasoning is replayed, stored ids are dropped", async () => {
    server = await fakeServer((_req, res) => sse(res, responsesStream));
    const provider = createResponsesProvider({
      mode: "chatgpt",
      getToken: async () => "tok",
      baseURL: server.url,
      effort: "medium",
    });
    const first = (await run(provider)).at(-1);
    if (first?.type !== "done") throw new Error("no done");
    await run(provider, [...HISTORY, first.message]);
    const body = JSON.parse(server.requests[1]!.body) as {
      input: Array<Record<string, unknown>>;
      include: string[];
      stream: boolean;
    };
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.stream).toBe(true);
    expect(body.input.slice(-3)).toEqual([
      responsesOutput[0],
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Bonjour", annotations: [] }],
      },
      {
        type: "function_call",
        call_id: "toolu_1",
        name: "bash",
        arguments: '{"command":"ls"}',
        status: "completed",
      },
    ]);
    expect(server.requests[1]!.headers.authorization).toBe("Bearer tok");
  });

  it("chatgpt plan limit gives a dedicated error", async () => {
    server = await fakeServer((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "limit",
            type: "usage_limit",
            code: "subscription_sharing_usage_limit_exceeded",
          },
        }),
      );
    });
    const provider = createResponsesProvider({
      mode: "chatgpt",
      getToken: async () => "tok",
      baseURL: server.url,
    });
    const error = (await run(provider).catch((e: unknown) => e)) as EnvokeError;
    expect(error.code).toBe("usage_limit");
    expect(server.requests).toHaveLength(1); // no SDK retry in ChatGPT mode
  });
});

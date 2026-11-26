import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentEvent, Message, ModelEvent, ModelProvider, ModelRequest } from "../src/index.ts";

/** Provider that plays back scripted turns and records each request. */
export function scriptedProvider(
  turns: Array<(req: ModelRequest) => Message | Error>,
): ModelProvider & {
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let i = 0;
  return {
    kind: "openai-compat",
    requests,
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      const turn = turns[Math.min(i++, turns.length - 1)];
      if (!turn) throw new Error("no turn scripted");
      const message = turn(req);
      if (message instanceof Error) throw message;
      for (const part of message.parts)
        if (part.type === "text") yield { type: "text_delta", text: part.text };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
      const calls = message.parts.some((p) => p.type === "tool_call");
      yield { type: "done", stopReason: calls ? "tool_calls" : "end", message };
    },
  };
}

export const say = (text: string) => (): Message => ({
  role: "assistant",
  parts: [{ type: "text", text }],
});

export const call =
  (name: string, input: unknown, id = `call_${name}_${Math.random().toString(36).slice(2, 7)}`) =>
  (): Message => ({ role: "assistant", parts: [{ type: "tool_call", id, name, input }] });

/** Drains an event stream, answering permission requests with `decide`. */
export async function collect(
  events: AsyncIterable<AgentEvent>,
  decide?: (event: Extract<AgentEvent, { type: "permission_request" }>) => void,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (event.type === "permission_request") decide?.(event);
  }
  return out;
}

export interface FakeServer {
  url: string;
  requests: { method: string; path: string; headers: IncomingMessage["headers"]; body: string }[];
  close(): Promise<void>;
}

/** Local HTTP server for provider and OAuth tests: no real network. */
export async function fakeServer(
  handler: (
    req: { method: string; path: string; body: string; url: URL },
    res: ServerResponse,
  ) => void | Promise<void>,
): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers, body });
    await handler({ method: req.method ?? "GET", path: url.pathname, body, url }, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    if (e.event) res.write(`event: ${e.event}\n`);
    res.write(`data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

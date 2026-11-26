import { isAbort, toEnvokeError } from "../errors.ts";
import { toolSpec, type Tool, type ToolResult } from "../tools/tool.ts";
import type {
  AgentEvent,
  ContentPart,
  Decision,
  Effort,
  Message,
  ModelEvent,
  ModelProvider,
} from "../types.ts";
import type { PermissionBroker } from "./permissions.ts";

export const MAX_ITERATIONS = 50;

export interface AuditEntry {
  sessionId: string;
  tool: string;
  input: unknown;
  decision: Decision | "auto";
  exitCode: number | null;
}

export interface TurnOptions {
  sessionId: string;
  provider: ModelProvider;
  model: string;
  system: string;
  tools: Tool[];
  history: Message[];
  userText: string;
  cwd: string;
  signal: AbortSignal;
  broker: PermissionBroker;
  /** Called for every message added to the conversation, in order (append-only). */
  append(message: Message): void;
  audit?(entry: AuditEntry): void;
  maxIterations?: number;
  effort?: Effort;
}

type ToolCall = Extract<ContentPart, { type: "tool_call" }>;

/**
 * One user turn: model, tools, model again… until the model answers without calling a tool.
 * Tool calls run one after another, each through the permission gate.
 */
export async function* runTurn(options: TurnOptions): AsyncGenerator<AgentEvent> {
  const { signal } = options;
  const messages = [...options.history];
  const push = (message: Message) => {
    messages.push(message);
    options.append(message);
  };
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const specs = options.tools.map(toolSpec);

  push({ role: "user", parts: [{ type: "text", text: options.userText }] });

  for (let i = 0; i < (options.maxIterations ?? MAX_ITERATIONS); i++) {
    let done: Extract<ModelEvent, { type: "done" }> | undefined;
    try {
      const stream = options.provider.stream({
        model: options.model,
        system: options.system,
        messages,
        tools: specs,
        signal,
        ...(options.effort ? { effort: options.effort } : {}),
      });
      for await (const event of stream) {
        if (event.type === "done") done = event;
        else yield event;
      }
    } catch (error) {
      if (signal.aborted || isAbort(error)) {
        yield { type: "turn_done", stopReason: "aborted" };
      } else {
        const e = toEnvokeError(error);
        yield { type: "error", code: e.code, message: e.message };
      }
      return;
    }
    if (!done) {
      yield { type: "error", code: "server", message: "Le modèle a terminé sans réponse." };
      return;
    }

    push(done.message);
    const calls = done.message.parts.filter((p): p is ToolCall => p.type === "tool_call");

    if (done.stopReason === "refusal" || done.stopReason === "max_tokens") {
      // Every tool call needs a result before the next request; a cut-off call must not run.
      if (calls.length > 0) {
        push({
          role: "tool",
          parts: calls.map((c) =>
            errorResult(c, "Appel d'outil interrompu avant la fin : non exécuté."),
          ),
        });
      }
      yield { type: "turn_done", stopReason: done.stopReason };
      return;
    }
    if (calls.length === 0) {
      yield { type: "turn_done", stopReason: "end" };
      return;
    }

    const results: ContentPart[] = [];
    for (const call of calls) {
      if (signal.aborted) {
        results.push(errorResult(call, "Interrompu par l'utilisateur : non exécuté."));
        continue;
      }
      results.push(yield* runTool(call, tools, options));
    }
    push({ role: "tool", parts: results });
    if (signal.aborted) {
      yield { type: "turn_done", stopReason: "aborted" };
      return;
    }
  }
  yield { type: "turn_done", stopReason: "max_iterations" };
}

function errorResult(call: ToolCall, output: string): ContentPart {
  return { type: "tool_result", toolCallId: call.id, output, isError: true };
}

async function* runTool(
  call: ToolCall,
  tools: Map<string, Tool>,
  options: TurnOptions,
): AsyncGenerator<AgentEvent, ContentPart> {
  const finish = function* (result: ToolResult): Generator<AgentEvent, ContentPart> {
    yield { type: "tool_end", id: call.id, output: result.output, isError: result.isError };
    return {
      type: "tool_result",
      toolCallId: call.id,
      output: result.output,
      isError: result.isError,
    };
  };

  const tool = tools.get(call.name);
  if (!tool) {
    yield { type: "tool_start", id: call.id, name: call.name, input: call.input, title: call.name };
    return yield* finish({ output: `Outil inconnu : ${call.name}`, isError: true });
  }
  const parsed = tool.schema.safeParse(call.input);
  const title = parsed.success ? tool.title(parsed.data) : call.name;
  yield { type: "tool_start", id: call.id, name: call.name, input: call.input, title };
  if (!parsed.success) {
    const output = JSON.stringify({ INVALID_INPUT: call.input, issues: parsed.error.issues });
    return yield* finish({ output, isError: true });
  }

  let decision: Decision | "auto" = "auto";
  if (tool.permission === "ask" && !options.broker.allows(options.sessionId, tool, parsed.data)) {
    const { requestId, decision: pending } = options.broker.request(
      options.sessionId,
      options.signal,
    );
    yield {
      type: "permission_request",
      requestId,
      toolCallId: call.id,
      tool: call.name,
      title,
      input: call.input,
    };
    decision = await pending;
    if (decision === "allow_always") options.broker.remember(options.sessionId, tool, parsed.data);
  }

  const audit = (exitCode: number | null) =>
    options.audit?.({
      sessionId: options.sessionId,
      tool: call.name,
      input: call.input,
      decision,
      exitCode,
    });

  if (decision === "deny") {
    audit(null);
    const why = options.signal.aborted
      ? "Interrompu par l'utilisateur."
      : "L'utilisateur a refusé cette action.";
    return yield* finish({ output: why, isError: true });
  }

  let result: ToolResult;
  try {
    result = await tool.execute(parsed.data, { cwd: options.cwd, signal: options.signal });
  } catch (error) {
    result = { output: toEnvokeError(error).message, isError: true };
  }
  audit(result.exitCode ?? null);
  return yield* finish(result);
}

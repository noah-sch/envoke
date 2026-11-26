import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PermissionBroker } from "../agent/permissions.ts";
import type { SessionStore } from "../store.ts";
import type { AgentEvent, ChatSnapshot, ClaudeChatEvent, Decision } from "../types.ts";

/** Claude Code hook events that feed the chat view. */
export const CHAT_HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "MessageDisplay",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "Notification",
] as const;

/** A permission question stays open as long as the user may take to answer it. */
const PERMISSION_TIMEOUT_S = 3600;
/** Longest tool output kept for display. */
const MAX_OUTPUT = 20_000;

/** Events Claude Code refuses HTTP hooks for ("HTTP hooks are not supported for SessionStart"). */
const COMMAND_ONLY = new Set(["SessionStart"]);

/**
 * `--settings` for Claude Code: every chat hook posts to envoke. Hooks given this way add to the
 * user's own (checked with Claude Code 2.1). The token reaches the header through the environment,
 * as the hooks documentation prescribes for HTTP hooks.
 */
export function chatHookSettings(url: string): string {
  const hook = (event: string) =>
    COMMAND_ONLY.has(event)
      ? {
          // Same request, made by curl from the hook's stdin. Silent: on SessionStart, what a
          // command prints is added to Claude's context.
          type: "command",
          command: `curl -s -m 5 -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $ENVOKE_HOOK_TOKEN" --data-binary @- '${url}' >/dev/null 2>&1 || true`,
          timeout: 10,
        }
      : {
          type: "http",
          url,
          headers: { Authorization: "Bearer $ENVOKE_HOOK_TOKEN" },
          allowedEnvVars: ["ENVOKE_HOOK_TOKEN"],
          timeout: event === "PermissionRequest" ? PERMISSION_TIMEOUT_S : 10,
        };
  return JSON.stringify({
    hooks: Object.fromEntries(CHAT_HOOKS.map((event) => [event, [{ hooks: [hook(event)] }]])),
  });
}

/** What a hook posts: the documented common fields plus the event's own. */
export interface HookInput {
  hook_event_name?: string;
  prompt?: string;
  message_id?: string;
  delta?: string;
  final?: boolean;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: unknown;
  permission_suggestions?: unknown[];
  last_assistant_message?: string;
  notification_type?: string;
  message?: string;
}

interface State {
  token: string;
  listeners: Set<(event: ClaudeChatEvent | ChatSnapshot) => void>;
  working: boolean;
  ready: boolean;
  /** Text of the message streaming now. */
  messageId: string | null;
  partial: string;
  /** Last thing shown was text: a new message starts a new paragraph. */
  afterText: boolean;
  /** Tool calls started and not finished, by id. */
  tools: Map<string, { name: string; input: unknown }>;
  pending: Map<string, Extract<AgentEvent, { type: "permission_request" }>>;
}

/**
 * Turns Claude Code's hook calls into envoke's chat: events for viewers, messages for the history,
 * and permission questions answered from the interface.
 */
export class ClaudeChat {
  readonly #store: SessionStore;
  readonly #broker: PermissionBroker;
  readonly #sessions = new Map<string, State>();
  readonly #onPrompt: (sessionId: string, prompt: string) => void;

  constructor(
    store: SessionStore,
    broker: PermissionBroker,
    onPrompt: (sessionId: string, prompt: string) => void = () => {},
  ) {
    this.#store = store;
    this.#broker = broker;
    this.#onPrompt = onPrompt;
  }

  /** A new token for a session's process: only it can post this session's hooks. */
  issueToken(sessionId: string): string {
    const state = this.#state(sessionId);
    state.token = randomBytes(24).toString("base64url");
    state.ready = false;
    state.working = false;
    return state.token;
  }

  checkToken(sessionId: string, token: string): boolean {
    const expected = this.#sessions.get(sessionId)?.token;
    if (!expected) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Sends the snapshot, then every event, until the returned function is called. */
  subscribe(
    sessionId: string,
    running: boolean,
    listener: (event: ClaudeChatEvent | ChatSnapshot) => void,
  ): () => void {
    const state = this.#state(sessionId);
    listener({
      type: "history",
      messages: this.#store.loadMessages(sessionId).map(({ role, parts }) => ({ role, parts })),
      running,
      working: state.working,
      ready: state.ready,
      partial: state.partial,
      pending: [...state.pending.values()],
    });
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  /** The process started or stopped: viewers learn it; a stop ends what was in progress. */
  process(sessionId: string, running: boolean): void {
    const state = this.#state(sessionId);
    if (!running) {
      this.#flushText(sessionId, state);
      state.working = false;
      state.ready = false;
      state.tools.clear();
    }
    state.listeners.forEach((l) => l({ type: "process", running }));
  }

  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** Handles one hook call; the returned object is the hook's answer (null: nothing to say). */
  async handle(sessionId: string, input: HookInput, signal: AbortSignal): Promise<object | null> {
    const state = this.#state(sessionId);
    const emit = (event: ClaudeChatEvent) => state.listeners.forEach((l) => l(event));
    switch (input.hook_event_name) {
      case "SessionStart":
        state.ready = true;
        emit({ type: "notice", kind: "ready", message: "" });
        return null;

      case "UserPromptSubmit": {
        const text = input.prompt ?? "";
        this.#flushText(sessionId, state);
        this.#store.appendMessage(sessionId, { role: "user", parts: [{ type: "text", text }] });
        state.working = true;
        state.afterText = false;
        emit({ type: "prompt", text });
        this.#onPrompt(sessionId, text);
        return null;
      }

      case "MessageDisplay": {
        const id = input.message_id ?? "";
        if (id !== state.messageId) {
          this.#flushText(sessionId, state);
          state.messageId = id;
          if (state.afterText) emit({ type: "text_delta", text: "\n\n" });
        }
        const delta = input.delta ?? "";
        if (delta) {
          state.partial += delta;
          state.afterText = true;
          emit({ type: "text_delta", text: delta });
        }
        if (input.final) this.#flushText(sessionId, state);
        return null;
      }

      case "PreToolUse": {
        this.#flushText(sessionId, state);
        const id = input.tool_use_id ?? `tool-${state.tools.size}`;
        const name = input.tool_name ?? "outil";
        state.tools.set(id, { name, input: input.tool_input });
        state.afterText = false;
        this.#store.appendMessage(sessionId, {
          role: "assistant",
          parts: [{ type: "tool_call", id, name, input: input.tool_input }],
        });
        emit({ type: "tool_start", id, name, input: input.tool_input, title: "" });
        return null;
      }

      case "PostToolUse":
      case "PostToolUseFailure": {
        const id = input.tool_use_id ?? "";
        state.tools.delete(id);
        const isError = input.hook_event_name === "PostToolUseFailure";
        const output = outputText(
          isError ? (input.error ?? input.tool_response) : input.tool_response,
        );
        this.#store.appendMessage(sessionId, {
          role: "tool",
          parts: [{ type: "tool_result", toolCallId: id, output, isError }],
        });
        emit({ type: "tool_end", id, output, isError });
        return null;
      }

      case "PermissionRequest":
        return this.#permission(sessionId, state, input, signal, emit);

      case "Stop": {
        const last = input.last_assistant_message?.trim();
        // Without MessageDisplay (older Claude Code), the final answer only arrives here.
        if (last && !state.partial && !state.afterText) {
          state.partial = last;
          emit({ type: "text_delta", text: last });
        }
        this.#flushText(sessionId, state);
        state.working = false;
        emit({ type: "turn_done", stopReason: "end" });
        return null;
      }

      case "StopFailure": {
        this.#flushText(sessionId, state);
        state.working = false;
        const message = input.last_assistant_message || "Claude Code n'a pas pu répondre.";
        emit({
          type: "error",
          code: typeof input.error === "string" ? input.error : "unknown",
          message,
        });
        return null;
      }

      case "Notification":
        emit({
          type: "notice",
          kind: input.notification_type ?? "notification",
          message: input.message ?? "",
        });
        return null;

      default:
        return null;
    }
  }

  async #permission(
    sessionId: string,
    state: State,
    input: HookInput,
    signal: AbortSignal,
    emit: (event: ClaudeChatEvent) => void,
  ): Promise<object | null> {
    this.#flushText(sessionId, state);
    const name = input.tool_name ?? "outil";
    const key = JSON.stringify(input.tool_input ?? null);
    // The hook carries no tool id: the matching call started just before.
    const toolCallId =
      [...state.tools.entries()]
        .reverse()
        .find(([, t]) => t.name === name && JSON.stringify(t.input ?? null) === key)?.[0] ??
      `permission-${Date.now().toString(36)}`;
    const { requestId, decision } = this.#broker.request(sessionId, signal);
    const event = {
      type: "permission_request" as const,
      requestId,
      toolCallId,
      tool: name,
      title: "",
      input: input.tool_input,
    };
    state.pending.set(requestId, event);
    emit(event);
    let answer: Decision;
    try {
      answer = await decision;
    } finally {
      state.pending.delete(requestId);
    }
    // Answered in the terminal instead: Claude Code closed the request, nothing to send back.
    if (signal.aborted) return null;
    return {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: toHook(answer, input) },
    };
  }

  #flushText(sessionId: string, state: State): void {
    if (state.partial.trim()) {
      this.#store.appendMessage(sessionId, {
        role: "assistant",
        parts: [{ type: "text", text: state.partial }],
      });
    }
    state.partial = "";
    state.messageId = null;
  }

  #state(sessionId: string): State {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        token: "",
        listeners: new Set(),
        working: false,
        ready: false,
        messageId: null,
        partial: "",
        afterText: false,
        tools: new Map(),
        pending: new Map(),
      };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}

/** "Always" stays within this conversation: Claude Code's own suggestion, kept to the session. */
function toHook(decision: Decision, input: HookInput): object {
  if (decision === "deny") {
    return { behavior: "deny", message: "Refusé par l'utilisateur dans envoke." };
  }
  if (decision === "allow_always") {
    const rules = (input.permission_suggestions ?? [])
      .filter(
        (s): s is Record<string, unknown> =>
          typeof s === "object" && s !== null && (s as { type?: unknown }).type === "addRules",
      )
      .map((s) => ({ ...s, destination: "session" }));
    if (rules.length) return { behavior: "allow", updatedPermissions: rules };
  }
  return { behavior: "allow" };
}

/** Tool results come as objects (Bash: stdout/stderr; Read: file content); show their text. */
export function outputText(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const file = v.file as Record<string, unknown> | undefined;
    if (typeof v.stdout === "string" || typeof v.stderr === "string") {
      text = [v.stdout, v.stderr].filter((s) => typeof s === "string" && s).join("\n");
    } else if (file && typeof file.content === "string") text = file.content;
    else if (typeof v.content === "string") text = v.content;
    else text = JSON.stringify(value, null, 2);
  } else text = value === undefined || value === null ? "" : String(value);
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (sortie tronquée)` : text;
}

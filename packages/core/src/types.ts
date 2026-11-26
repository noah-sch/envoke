/**
 * Types shared with the interface (`@envoke/core/types`). This file imports nothing, so a browser
 * bundle can use it without pulling Node code.
 */

/** Provider families the native loop can talk to. */
export type ProviderKind = "anthropic" | "openai-responses" | "openai-compat";

/** Reasoning depth. The chat's response modes map to low / medium / high. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; output: string; isError: boolean };

export interface Message {
  role: "user" | "assistant" | "tool";
  parts: ContentPart[];
  /**
   * Provider payload replayed verbatim when the next request goes to the same provider kind
   * (Anthropic thinking blocks, OpenAI encrypted reasoning). Dropped when switching provider.
   */
  native?: { provider: ProviderKind; data: unknown };
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end" | "tool_calls" | "max_tokens" | "refusal";

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: StopReason; message: Message };

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal: AbortSignal;
  /** Overrides the profile's effort for this request. */
  effort?: Effort;
}

/** One model turn. Errors are thrown as EnvokeError. */
export interface ModelProvider {
  readonly kind: ProviderKind;
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
}

export type Decision = "allow_once" | "allow_always" | "deny";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown; title: string }
  | {
      type: "permission_request";
      requestId: string;
      toolCallId: string;
      tool: string;
      title: string;
      input: unknown;
    }
  | { type: "tool_end"; id: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | {
      type: "turn_done";
      stopReason: "end" | "max_tokens" | "refusal" | "aborted" | "max_iterations";
    }
  | { type: "error"; code: string; message: string };

export interface SendOptions {
  /** Response mode for this turn; ignored by ACP agents, which keep their own settings. */
  effort?: Effort;
}

/** A full turn with tools. The server and the CLI only talk to this. */
export interface AgentBackend {
  send(
    sessionId: string,
    userText: string,
    signal: AbortSignal,
    options?: SendOptions,
  ): AsyncIterable<AgentEvent>;
  dispose(): Promise<void>;
}

// ── Data returned by the local API ─────────────────────────────────────────

export interface SessionRecord {
  id: string;
  /** "chat": envoke's own conversation; "terminal": the user's Claude Code, in a terminal. */
  kind: "chat" | "terminal";
  profileId: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Session id on the agent side (ACP), used to reload the conversation. */
  backendSessionId: string | null;
}

export interface ConnectionStatus {
  id: string;
  type: "anthropic" | "openai" | "chatgpt" | "openai-compat" | "acp";
  label: string;
  /** How it signs in: an API key (or nothing), or a consumer subscription. */
  access: "api_key" | "none" | "subscription";
  /** Allowed by the product policy. */
  allowed: boolean;
  /** Ready to use: key present, account connected. Unknown agent logins count as ready. */
  linked: boolean;
  account: string | null;
  /** API-key connections an ACP agent needs. */
  requires: string[];
}

/** What a terminal session's stream carries. `snapshot` comes first: the screen so far. */
export type TerminalEvent =
  | { type: "snapshot"; data: string; running: boolean; exitCode: number | null }
  | { type: "start" }
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number | null };

/** What the chat view of a Claude Code session receives, after a `history` snapshot. */
export type ClaudeChatEvent =
  | AgentEvent
  | { type: "prompt"; text: string }
  /** From Claude Code's Notification hook (`permission_prompt`, `idle_prompt`…), or `ready`. */
  | { type: "notice"; kind: string; message: string }
  /** The Claude Code process started or stopped. */
  | { type: "process"; running: boolean };

/** First event of the chat view: the stored conversation, then what is in progress. */
export interface ChatSnapshot {
  type: "history";
  messages: Pick<Message, "role" | "parts">[];
  /** Claude Code is answering. */
  working: boolean;
  /** Claude Code has started (SessionStart received) since its process last started. */
  ready: boolean;
  /** The Claude Code process is running. */
  running: boolean;
  /** Text of the answer being written, not stored yet. */
  partial: string;
  /** Permission questions waiting for the user. */
  pending: Extract<AgentEvent, { type: "permission_request" }>[];
}

export interface ClaudeCodeStatus {
  installed: boolean;
  path: string | null;
}

export interface ProfileInfo {
  id: string;
  label: string;
  connection: string;
  model: string | null;
  available: boolean;
  /** "native": our loop (response modes, regenerate); "acp": the editor's agent. */
  engine: "native" | "acp";
  effort: Effort | null;
}

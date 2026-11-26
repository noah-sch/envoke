import type { AgentEvent, ContentPart, Decision } from "@envoke/core/types";

/** What the thread shows. Built from the live event stream, or from the stored history. */
export interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  title: string;
  input: unknown;
  status: "running" | "done" | "error";
  output: string | null;
  permission: { requestId: string; state: "pending" | Decision } | null;
}

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | ToolBlock
  | { kind: "error"; code: string; message: string };

export type StopKind = Extract<AgentEvent, { type: "turn_done" }>["stopReason"];

export interface Turn {
  id: string;
  user: string;
  blocks: Block[];
  status: "streaming" | "done";
  stop: StopKind | null;
}

export interface StoredMessage {
  role: "user" | "assistant" | "tool";
  parts: ContentPart[];
}

let counter = 0;
const nextId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newTurn(user: string): Turn {
  return { id: nextId(), user, blocks: [], status: "streaming", stop: null };
}

function updateTool(
  blocks: Block[],
  id: string,
  patch: (b: ToolBlock) => ToolBlock,
): Block[] | null {
  const index = blocks.findIndex((b) => b.kind === "tool" && b.id === id);
  if (index === -1) return null;
  const next = blocks.slice();
  next[index] = patch(blocks[index] as ToolBlock);
  return next;
}

/** Pure reducer: one event in, a new turn out. */
export function applyEvent(turn: Turn, event: AgentEvent): Turn {
  const blocks = turn.blocks;
  const last = blocks.at(-1);
  switch (event.type) {
    case "text_delta":
    case "thinking_delta": {
      const kind = event.type === "text_delta" ? "text" : "thinking";
      if (last?.kind === kind) {
        return {
          ...turn,
          blocks: [...blocks.slice(0, -1), { kind, text: last.text + event.text }],
        };
      }
      return { ...turn, blocks: [...blocks, { kind, text: event.text }] };
    }
    case "tool_start": {
      const block: ToolBlock = {
        kind: "tool",
        id: event.id,
        name: event.name,
        title: event.title || toolTitle(event.name, event.input),
        input: event.input,
        status: "running",
        output: null,
        permission: null,
      };
      return { ...turn, blocks: updateTool(blocks, event.id, () => block) ?? [...blocks, block] };
    }
    case "permission_request": {
      const permission = { requestId: event.requestId, state: "pending" as const };
      const updated = updateTool(blocks, event.toolCallId, (b) => ({ ...b, permission }));
      if (updated) return { ...turn, blocks: updated };
      const block: ToolBlock = {
        kind: "tool",
        id: event.toolCallId,
        name: event.tool,
        title: event.title,
        input: event.input,
        status: "running",
        output: null,
        permission,
      };
      return { ...turn, blocks: [...blocks, block] };
    }
    case "tool_end": {
      const updated = updateTool(blocks, event.id, (b) => ({
        ...b,
        status: event.isError ? "error" : "done",
        output: event.output,
        // Still open here means it was answered elsewhere (Claude Code's own terminal).
        permission: b.permission?.state === "pending" ? null : b.permission,
      }));
      return updated ? { ...turn, blocks: updated } : turn;
    }
    case "turn_done":
      return { ...turn, status: "done", stop: event.stopReason, blocks: settle(blocks) };
    case "error":
      return {
        ...turn,
        status: "done",
        blocks: [...settle(blocks), { kind: "error", code: event.code, message: event.message }],
      };
    case "usage":
      return turn;
  }
}

/** A turn that ends leaves no tool spinning and no question open. */
function settle(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === "tool" && (b.status === "running" || b.permission?.state === "pending")
      ? {
          ...b,
          status: b.status === "running" ? "error" : b.status,
          permission:
            b.permission?.state === "pending" ? { ...b.permission, state: "deny" } : b.permission,
        }
      : b,
  );
}

export function decide(turn: Turn, requestId: string, decision: Decision): Turn {
  return {
    ...turn,
    blocks: turn.blocks.map((b) =>
      b.kind === "tool" && b.permission?.requestId === requestId
        ? { ...b, permission: { requestId, state: decision } }
        : b,
    ),
  };
}

/** Rebuilds turns from the stored conversation (user, assistant, tool results). */
export function turnsFromHistory(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
      current = { id: nextId(), user: text, blocks: [], status: "done", stop: "end" };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    for (const p of m.parts) {
      if (p.type === "text" && p.text) current.blocks.push({ kind: "text", text: p.text });
      if (p.type === "tool_call") {
        current.blocks.push({
          kind: "tool",
          id: p.id,
          name: p.name,
          title: toolTitle(p.name, p.input),
          input: p.input,
          status: "done",
          output: null,
          permission: null,
        });
      }
      if (p.type === "tool_result") {
        const tool = current.blocks.find(
          (b): b is ToolBlock => b.kind === "tool" && b.id === p.toolCallId,
        );
        if (tool) {
          tool.output = p.output;
          tool.status = p.isError ? "error" : "done";
        }
      }
    }
  }
  return turns;
}

/** Short label for a tool call: the command, or the file it touches (envoke and Claude Code tools). */
export function toolTitle(name: string, input: unknown): string {
  const value = (input ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
  const command = text("command");
  if (command) return command;
  const tool = name.toLowerCase();
  const file = text("path") ?? text("file_path") ?? text("notebook_path");
  if (file) {
    if (tool === "read_file" || tool === "read") return `Lire ${file}`;
    if (tool === "write_file" || tool === "write") return `Écrire ${file}`;
    if (["edit_file", "edit", "multiedit", "notebookedit"].includes(tool))
      return `Modifier ${file}`;
    return `${name} ${file}`;
  }
  const pattern = text("pattern");
  if (pattern) return `${tool === "glob" ? "Lister" : "Chercher"} ${pattern}`;
  const url = text("url");
  if (url) return `Ouvrir ${url}`;
  const query = text("query");
  if (query) return `Rechercher ${query}`;
  return text("description") ?? name;
}

/** The assistant's words in a turn, for "copy the answer". */
export function answerText(turn: Turn): string {
  return turn.blocks
    .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

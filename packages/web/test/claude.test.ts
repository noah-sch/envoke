import type { ChatSnapshot, ClaudeChatEvent } from "@envoke/core/types";
import { describe, expect, it } from "vitest";
import { claudeReducer, initialClaude, type ClaudeState } from "../src/claude.ts";

const snapshot = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  type: "history",
  messages: [],
  working: false,
  ready: true,
  running: true,
  partial: "",
  pending: [],
  ...over,
});

const run = (events: (ClaudeChatEvent | ChatSnapshot)[], state: ClaudeState = initialClaude) =>
  claudeReducer(state, { type: "events", events });

describe("Claude Code chat view", () => {
  it("shows a turn: prompt, text, a tool with its question, then the answer", () => {
    let state = run([
      snapshot(),
      { type: "prompt", text: "Liste" },
      { type: "text_delta", text: "Je regarde." },
      { type: "tool_start", id: "t1", name: "Bash", input: { command: "ls" }, title: "" },
      {
        type: "permission_request",
        requestId: "r1",
        toolCallId: "t1",
        tool: "Bash",
        title: "",
        input: { command: "ls" },
      },
    ]);
    expect(state.working).toBe(true);
    expect(state.live?.user).toBe("Liste");
    expect(state.live?.blocks[1]).toMatchObject({
      kind: "tool",
      title: "ls",
      permission: { requestId: "r1", state: "pending" },
    });

    state = claudeReducer(state, { type: "decide", requestId: "r1", decision: "allow_once" });
    state = run(
      [
        { type: "tool_end", id: "t1", output: "a.txt", isError: false },
        { type: "text_delta", text: "Un fichier." },
        { type: "turn_done", stopReason: "end" },
      ],
      state,
    );
    expect(state.live).toBeNull();
    expect(state.working).toBe(false);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]!.blocks.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
    expect(state.turns[0]!.blocks[1]).toMatchObject({
      status: "done",
      permission: { state: "allow_once" },
    });
  });

  it("reopens the turn in progress for a viewer that arrives late", () => {
    const state = run([
      snapshot({
        working: true,
        messages: [
          { role: "user", parts: [{ type: "text", text: "Salut" }] },
          {
            role: "assistant",
            parts: [{ type: "tool_call", id: "t", name: "Read", input: { file_path: "a.ts" } }],
          },
        ],
        partial: "En cours",
        pending: [
          {
            type: "permission_request",
            requestId: "r",
            toolCallId: "t",
            tool: "Read",
            title: "",
            input: { file_path: "a.ts" },
          },
        ],
      }),
    ]);
    expect(state.turns).toEqual([]);
    expect(state.live).toMatchObject({ user: "Salut", status: "streaming" });
    expect(state.live?.blocks).toMatchObject([
      { kind: "tool", title: "Lire a.ts", permission: { state: "pending" } },
      { kind: "text", text: "En cours" },
    ]);
  });

  it("hides a question answered in the terminal, and closes the turn when the process stops", () => {
    let state = run([
      snapshot(),
      { type: "prompt", text: "Go" },
      { type: "tool_start", id: "t", name: "Bash", input: { command: "make" }, title: "" },
      {
        type: "permission_request",
        requestId: "r",
        toolCallId: "t",
        tool: "Bash",
        title: "",
        input: { command: "make" },
      },
      { type: "tool_end", id: "t", output: "ok", isError: false },
    ]);
    expect(state.live?.blocks[0]).toMatchObject({ status: "done", permission: null });

    state = run([{ type: "process", running: false }], state);
    expect(state).toMatchObject({ running: false, working: false, live: null });
    expect(state.turns[0]).toMatchObject({ user: "Go", status: "done" });
  });

  it("points to the terminal only for what the chat cannot answer", () => {
    let state = run([snapshot({ ready: false }), { type: "notice", kind: "ready", message: "" }]);
    expect(state.ready).toBe(true);
    state = run([{ type: "notice", kind: "idle_prompt", message: "En attente" }], state);
    expect(state.attention).toBeNull();
    state = run([{ type: "notice", kind: "elicitation_dialog", message: "Une question" }], state);
    expect(state.attention).toBe("Une question");
    state = run([{ type: "prompt", text: "Suite" }], state);
    expect(state.attention).toBeNull();
  });
});

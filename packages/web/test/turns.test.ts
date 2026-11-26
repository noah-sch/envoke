import type { AgentEvent } from "@envoke/core/types";
import { describe, expect, it } from "vitest";
import {
  answerText,
  applyEvent,
  decide,
  newTurn,
  toolTitle,
  turnsFromHistory,
} from "../src/turns.ts";

const play = (events: AgentEvent[]) => events.reduce(applyEvent, newTurn("salut"));

describe("live turn", () => {
  it("merges deltas and follows a tool through its permission", () => {
    const turn = play([
      { type: "thinking_delta", text: "je " },
      { type: "thinking_delta", text: "réfléchis" },
      { type: "text_delta", text: "Je " },
      { type: "text_delta", text: "regarde." },
      { type: "tool_start", id: "c1", name: "bash", input: { command: "ls" }, title: "ls" },
      {
        type: "permission_request",
        requestId: "r1",
        toolCallId: "c1",
        tool: "bash",
        title: "ls",
        input: {},
      },
    ]);
    expect(turn.blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool"]);
    expect(turn.blocks[0]).toEqual({ kind: "thinking", text: "je réfléchis" });
    const decided = decide(turn, "r1", "allow_once");
    const ended = applyEvent(decided, {
      type: "tool_end",
      id: "c1",
      output: "a\nb",
      isError: false,
    });
    expect(ended.blocks[2]).toMatchObject({
      status: "done",
      output: "a\nb",
      permission: { state: "allow_once" },
    });
  });

  it("closes open tools and questions when the turn ends", () => {
    const turn = play([
      { type: "tool_start", id: "c1", name: "bash", input: { command: "rm x" }, title: "rm x" },
      {
        type: "permission_request",
        requestId: "r1",
        toolCallId: "c1",
        tool: "bash",
        title: "rm x",
        input: {},
      },
      { type: "turn_done", stopReason: "aborted" },
    ]);
    expect(turn).toMatchObject({ status: "done", stop: "aborted" });
    expect(turn.blocks[0]).toMatchObject({ status: "error", permission: { state: "deny" } });
  });

  it("keeps an error as a block", () => {
    const turn = play([{ type: "error", code: "auth_required", message: "Liez d'abord la clé." }]);
    expect(turn.blocks).toEqual([
      { kind: "error", code: "auth_required", message: "Liez d'abord la clé." },
    ]);
    expect(turn.status).toBe("done");
  });
});

describe("history", () => {
  it("rebuilds turns with tool results attached to their calls", () => {
    const turns = turnsFromHistory([
      { role: "user", parts: [{ type: "text", text: "liste" }] },
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "c1", name: "read_file", input: { path: "a.txt" } }],
      },
      {
        role: "tool",
        parts: [{ type: "tool_result", toolCallId: "c1", output: "contenu", isError: false }],
      },
      { role: "assistant", parts: [{ type: "text", text: "Voici." }] },
      { role: "user", parts: [{ type: "text", text: "merci" }] },
    ]);
    expect(turns.map((t) => t.user)).toEqual(["liste", "merci"]);
    expect(turns[0]!.blocks).toMatchObject([
      { kind: "tool", title: "Lire a.txt", output: "contenu", status: "done" },
      { kind: "text", text: "Voici." },
    ]);
    expect(answerText(turns[0]!)).toBe("Voici.");
  });

  it("labels tool calls by command or file", () => {
    expect(toolTitle("bash", { command: "git status" })).toBe("git status");
    expect(toolTitle("edit_file", { path: "src/a.ts" })).toBe("Modifier src/a.ts");
    expect(toolTitle("mystery", {})).toBe("mystery");
  });
});

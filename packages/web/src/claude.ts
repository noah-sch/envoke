import type { ChatSnapshot, ClaudeChatEvent, Decision } from "@envoke/core/types";
import { applyEvent, decide, newTurn, turnsFromHistory, type Turn } from "./turns.ts";

/** Chat view of a Claude Code session, built from the stream of its hooks. */
export interface ClaudeState {
  turns: Turn[];
  live: Turn | null;
  /** Claude Code is answering. */
  working: boolean;
  /** Claude Code has started (its first hook arrived). */
  ready: boolean;
  /** The process runs. */
  running: boolean;
  /** The first snapshot arrived. */
  loaded: boolean;
  /** Claude Code waits for an answer only its terminal can take (a dialog, a question). */
  attention: string | null;
}

export const initialClaude: ClaudeState = {
  turns: [],
  live: null,
  working: false,
  ready: false,
  running: false,
  loaded: false,
  attention: null,
};

export type ClaudeAction =
  | { type: "events"; events: (ClaudeChatEvent | ChatSnapshot)[] }
  | { type: "decide"; requestId: string; decision: Decision };

/** Notifications that mean a dialog in Claude Code's terminal. */
const NEEDS_TERMINAL = new Set([
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

const hasQuestion = (turn: Turn | null) =>
  turn?.blocks.some((b) => b.kind === "tool" && b.permission?.state === "pending") ?? false;

/** A turn left open (interrupted, process stopped) is closed as it stands. */
const closed = (turn: Turn): Turn =>
  turn.status === "streaming" ? { ...turn, status: "done" } : turn;

function apply(state: ClaudeState, event: ClaudeChatEvent | ChatSnapshot): ClaudeState {
  switch (event.type) {
    case "history": {
      const turns = turnsFromHistory(event.messages);
      let live: Turn | null = null;
      if (event.working) {
        // The last stored turn is the one in progress: reopen it with what is not stored yet.
        const last = turns.pop();
        live = last ? { ...last, status: "streaming", stop: null } : newTurn("");
        if (event.partial) live = applyEvent(live, { type: "text_delta", text: event.partial });
        for (const question of event.pending) live = applyEvent(live, question);
      }
      return {
        turns,
        live,
        working: event.working,
        ready: event.ready,
        running: event.running,
        loaded: true,
        attention: null,
      };
    }
    case "prompt":
      return {
        ...state,
        turns: state.live ? [...state.turns, closed(state.live)] : state.turns,
        live: newTurn(event.text),
        working: true,
        attention: null,
      };
    case "notice":
      if (event.kind === "ready") return { ...state, ready: true };
      if (
        NEEDS_TERMINAL.has(event.kind) ||
        (event.kind === "permission_prompt" && !hasQuestion(state.live))
      ) {
        return { ...state, attention: event.message || "Claude Code attend une réponse." };
      }
      return state;
    case "process":
      if (event.running) return { ...state, running: true, ready: false };
      return {
        ...state,
        turns: state.live ? [...state.turns, closed(state.live)] : state.turns,
        live: null,
        running: false,
        ready: false,
        working: false,
        attention: null,
      };
    case "turn_done":
    case "error":
      return {
        ...state,
        turns: [...state.turns, applyEvent(state.live ?? newTurn(""), event)],
        live: null,
        working: false,
        attention: null,
      };
    case "usage":
      return state;
    default:
      return {
        ...state,
        live: applyEvent(state.live ?? newTurn(""), event),
        attention: event.type === "permission_request" ? null : state.attention,
      };
  }
}

export function claudeReducer(state: ClaudeState, action: ClaudeAction): ClaudeState {
  if (action.type === "decide") {
    return state.live
      ? { ...state, live: decide(state.live, action.requestId, action.decision) }
      : state;
  }
  return action.events.reduce(apply, state);
}

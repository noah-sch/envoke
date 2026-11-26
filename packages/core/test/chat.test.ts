import { describe, expect, it } from "vitest";
import {
  ClaudeChat,
  chatHookSettings,
  CHAT_HOOKS,
  MemorySessionStore,
  outputText,
  PermissionBroker,
  type ChatSnapshot,
  type ClaudeChatEvent,
} from "../src/index.ts";

function setup() {
  const store = new MemorySessionStore();
  const broker = new PermissionBroker();
  const prompts: string[] = [];
  const chat = new ClaudeChat(store, broker, (_, prompt) => prompts.push(prompt));
  store.createSession({ id: "s", kind: "terminal", profileId: "claude-code", cwd: "/tmp" });
  const events: (ClaudeChatEvent | ChatSnapshot)[] = [];
  const stop = chat.subscribe("s", true, (e) => events.push(e));
  const signal = new AbortController().signal;
  const hook = (body: Record<string, unknown>, s: AbortSignal = signal) =>
    chat.handle("s", body, s);
  return { store, broker, chat, events, stop, hook, prompts };
}

describe("Claude Code chat bridge", () => {
  it("sends hooks for every chat event, with the token header from the environment", () => {
    const settings = JSON.parse(chatHookSettings("http://127.0.0.1:4317/api/hooks/s")) as {
      hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
    };
    expect(Object.keys(settings.hooks)).toEqual([...CHAT_HOOKS]);
    expect(settings.hooks.PermissionRequest![0]!.hooks[0]).toEqual({
      type: "http",
      url: "http://127.0.0.1:4317/api/hooks/s",
      headers: { Authorization: "Bearer $ENVOKE_HOOK_TOKEN" },
      allowedEnvVars: ["ENVOKE_HOOK_TOKEN"],
      timeout: 3600,
    });
    expect(settings.hooks.MessageDisplay![0]!.hooks[0]!.timeout).toBe(10);
    // No HTTP hooks on SessionStart: curl makes the same request, silently.
    const start = settings.hooks.SessionStart![0]!.hooks[0]!;
    expect(start.type).toBe("command");
    expect(start.command).toContain("--data-binary @- 'http://127.0.0.1:4317/api/hooks/s'");
    expect(start.command).toContain(">/dev/null 2>&1 || true");
  });

  it("turns a turn into chat events and stores it as a conversation", async () => {
    const { store, events, hook, prompts } = setup();
    expect(events[0]).toMatchObject({ type: "history", messages: [], running: true });

    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Liste les fichiers" });
    await hook({ hook_event_name: "MessageDisplay", message_id: "m1", delta: "Je ", final: false });
    await hook({
      hook_event_name: "MessageDisplay",
      message_id: "m1",
      delta: "regarde.\n",
      final: true,
    });
    await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "toolu_1",
    });
    await hook({
      hook_event_name: "PostToolUse",
      tool_use_id: "toolu_1",
      tool_response: { stdout: "a.txt", stderr: "" },
    });
    await hook({
      hook_event_name: "MessageDisplay",
      message_id: "m2",
      delta: "Un fichier.",
      final: true,
    });
    await hook({ hook_event_name: "Stop", last_assistant_message: "Un fichier." });

    expect(prompts).toEqual(["Liste les fichiers"]);
    expect(events.slice(1)).toEqual([
      { type: "notice", kind: "ready", message: "" },
      { type: "prompt", text: "Liste les fichiers" },
      { type: "text_delta", text: "Je " },
      { type: "text_delta", text: "regarde.\n" },
      { type: "tool_start", id: "toolu_1", name: "Bash", input: { command: "ls" }, title: "" },
      { type: "tool_end", id: "toolu_1", output: "a.txt", isError: false },
      { type: "text_delta", text: "Un fichier." },
      { type: "turn_done", stopReason: "end" },
    ]);
    expect(store.loadMessages("s")).toEqual([
      { role: "user", parts: [{ type: "text", text: "Liste les fichiers" }] },
      { role: "assistant", parts: [{ type: "text", text: "Je regarde.\n" }] },
      {
        role: "assistant",
        parts: [{ type: "tool_call", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "tool",
        parts: [{ type: "tool_result", toolCallId: "toolu_1", output: "a.txt", isError: false }],
      },
      { role: "assistant", parts: [{ type: "text", text: "Un fichier." }] },
    ]);
  });

  it("asks permission in envoke and answers Claude Code; 'always' stays in the session", async () => {
    const { broker, events, hook } = setup();
    await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_use_id: "toolu_9",
    });
    const suggestion = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test" }],
      behavior: "allow",
      destination: "localSettings",
    };
    const ask = (s?: AbortSignal) =>
      hook(
        {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          permission_suggestions: [suggestion],
        },
        s,
      );

    const always = ask();
    const request = events.at(-1) as Extract<ClaudeChatEvent, { type: "permission_request" }>;
    expect(request).toMatchObject({
      type: "permission_request",
      toolCallId: "toolu_9",
      tool: "Bash",
    });
    broker.resolve(request.requestId, "allow_always");
    expect(await always).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [{ ...suggestion, destination: "session" }],
        },
      },
    });

    const denied = ask();
    broker.resolve((events.at(-1) as typeof request).requestId, "deny");
    expect(await denied).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });

    // Answered in the terminal: Claude Code drops the request, envoke sends nothing back.
    const elsewhere = new AbortController();
    const dropped = ask(elsewhere.signal);
    elsewhere.abort();
    expect(await dropped).toBeNull();
  });

  it("gives a late viewer the turn in progress, then the rest", async () => {
    const { chat, hook } = setup();
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Salut" });
    await hook({ hook_event_name: "MessageDisplay", message_id: "m1", delta: "Bon", final: false });
    await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
      tool_use_id: "t",
    });
    void hook({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    });

    const late: (ClaudeChatEvent | ChatSnapshot)[] = [];
    chat.subscribe("s", true, (e) => late.push(e));
    const snapshot = late[0] as ChatSnapshot;
    expect(snapshot.working).toBe(true);
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0]).toMatchObject({ toolCallId: "t" });

    chat.process("s", false);
    expect(late.at(-1)).toEqual({ type: "process", running: false });
  });

  it("falls back on Stop's final message when no text streamed, and reports failures", async () => {
    const { events, hook } = setup();
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "?" });
    await hook({ hook_event_name: "Stop", last_assistant_message: "Réponse finale." });
    await hook({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      last_assistant_message: "API Error: Rate limit reached",
    });
    await hook({
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "En attente",
    });
    expect(events.slice(2)).toEqual([
      { type: "text_delta", text: "Réponse finale." },
      { type: "turn_done", stopReason: "end" },
      { type: "error", code: "rate_limit", message: "API Error: Rate limit reached" },
      { type: "notice", kind: "idle_prompt", message: "En attente" },
    ]);
  });

  it("checks each process's hook token", () => {
    const { chat } = setup();
    expect(chat.checkToken("s", "")).toBe(false);
    const token = chat.issueToken("s");
    expect(chat.checkToken("s", token)).toBe(true);
    expect(chat.checkToken("s", `${token}x`)).toBe(false);
    expect(chat.checkToken("autre", token)).toBe(false);
    chat.issueToken("s");
    expect(chat.checkToken("s", token)).toBe(false);
  });

  it("shows tool results as text", () => {
    expect(outputText({ stdout: "ok", stderr: "attention" })).toBe("ok\nattention");
    expect(outputText({ type: "text", file: { filePath: "/a", content: "contenu" } })).toBe(
      "contenu",
    );
    expect(outputText("brut")).toBe("brut");
    expect(outputText({ autre: 1 })).toBe('{\n  "autre": 1\n}');
    expect(outputText("x".repeat(20_010))).toMatch(/sortie tronquée\)$/);
  });
});

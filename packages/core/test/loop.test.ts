import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultTools,
  EnvokeError,
  PermissionBroker,
  runTurn,
  type Message,
} from "../src/index.ts";
import { call, collect, say, scriptedProvider } from "./helpers.ts";

let cwd: string;
let broker: PermissionBroker;
let appended: Message[];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "envoke-loop-"));
  await writeFile(path.join(cwd, "a.txt"), "a");
  await writeFile(path.join(cwd, "b.txt"), "b");
  broker = new PermissionBroker();
  appended = [];
});

function turn(
  provider: ReturnType<typeof scriptedProvider>,
  userText: string,
  signal = new AbortController().signal,
  maxIterations?: number,
) {
  return runTurn({
    sessionId: "s1",
    provider,
    model: "test-model",
    system: "system",
    tools: defaultTools,
    history: [],
    userText,
    cwd,
    signal,
    broker,
    append: (m) => appended.push(m),
    ...(maxIterations ? { maxIterations } : {}),
  });
}

describe("agent loop", () => {
  it("asks permission, runs the command, and feeds the result back to the model", async () => {
    const provider = scriptedProvider([
      call("bash", { command: "ls | wc -l" }),
      (req) => {
        const last = req.messages.at(-1)!;
        const result = last.parts[0];
        return say(
          `Il y a ${result?.type === "tool_result" ? result.output.trim().split("\n")[0]?.trim() : "?"} fichiers.`,
        )();
      },
    ]);
    const events = await collect(turn(provider, "Combien de fichiers ?"), (e) =>
      broker.resolve(e.requestId, "allow_once"),
    );
    expect(events.map((e) => e.type)).toEqual([
      "usage",
      "tool_start",
      "permission_request",
      "tool_end",
      "text_delta",
      "usage",
      "turn_done",
    ]);
    expect(events.find((e) => e.type === "text_delta")).toMatchObject({
      text: "Il y a 2 fichiers.",
    });
    expect(appended.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("reports a denial to the model without running anything", async () => {
    const provider = scriptedProvider([
      call("bash", { command: "touch created.txt" }),
      say("D'accord."),
    ]);
    const events = await collect(turn(provider, "Crée un fichier"), (e) =>
      broker.resolve(e.requestId, "deny"),
    );
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({
      isError: true,
      output: expect.stringContaining("refusé"),
    });
    const seen = provider.requests[1]!.messages.at(-1)!.parts[0];
    expect(seen).toMatchObject({ type: "tool_result", isError: true });
    expect(events.at(-1)).toEqual({ type: "turn_done", stopReason: "end" });
  });

  it("remembers 'always' for the command prefix, for this session only", async () => {
    const provider = scriptedProvider([
      call("bash", { command: "ls -a" }),
      call("bash", { command: "ls -l" }),
      call("bash", { command: "ls; echo hacked" }),
      say("fini"),
    ]);
    const asked: string[] = [];
    await collect(turn(provider, "go"), (e) => {
      asked.push(e.title);
      broker.resolve(e.requestId, asked.length === 1 ? "allow_always" : "deny");
    });
    expect(asked).toEqual(["ls -a", "ls; echo hacked"]);
  });

  it("does not ask for reads inside the working directory", async () => {
    const provider = scriptedProvider([call("read_file", { path: "a.txt" }), say("ok")]);
    const events = await collect(turn(provider, "lis a.txt"));
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({
      output: "a",
      isError: false,
    });
  });

  it("returns invalid tool input to the model as an error", async () => {
    const provider = scriptedProvider([call("bash", { cmd: "ls" }), say("oups")]);
    const events = await collect(turn(provider, "go"));
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({
      isError: true,
      output: expect.stringContaining("INVALID_INPUT"),
    });
  });

  it("stops at the iteration limit", async () => {
    const provider = scriptedProvider([call("read_file", { path: "a.txt" })]);
    const events = await collect(turn(provider, "boucle", undefined, 3));
    expect(events.at(-1)).toEqual({ type: "turn_done", stopReason: "max_iterations" });
    expect(provider.requests).toHaveLength(3);
  });

  it("aborts while waiting for permission and still answers every tool call", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([
      (): Message => ({
        role: "assistant",
        parts: [
          { type: "tool_call", id: "c1", name: "bash", input: { command: "ls" } },
          { type: "tool_call", id: "c2", name: "bash", input: { command: "pwd" } },
        ],
      }),
    ]);
    const events = await collect(turn(provider, "go", controller.signal), () => controller.abort());
    expect(events.at(-1)).toEqual({ type: "turn_done", stopReason: "aborted" });
    const results = appended.at(-1)!;
    expect(results.role).toBe("tool");
    expect(results.parts.map((p) => (p.type === "tool_result" ? p.toolCallId : ""))).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("turns a provider failure into a readable error event", async () => {
    const provider = scriptedProvider([
      () => new EnvokeError("auth", "Clé API Anthropic invalide ou absente."),
    ]);
    const events = await collect(turn(provider, "salut"));
    expect(events).toEqual([
      { type: "error", code: "auth", message: "Clé API Anthropic invalide ou absente." },
    ]);
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  MemoryStore,
  parseConfig,
  Runtime,
  type AgentEvent,
  type Config,
} from "../src/index.ts";
import { call, collect, say, scriptedProvider } from "./helpers.ts";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));

function config(subscriptionLogins: string[] = []): Config {
  return parseConfig({
    policy: { subscriptionLogins },
    connections: [
      { id: "anthropic", type: "anthropic" },
      { id: "chatgpt", type: "chatgpt" },
      {
        id: "fake",
        type: "acp",
        agent: "fake",
        env: { FAKE_KEY: "anthropic" },
        configDirEnv: "FAKE_HOME",
      },
      { id: "fake-sub", type: "acp", agent: "fake" },
      { id: "nokey", type: "openai-compat", baseURL: "http://127.0.0.1:9/v1" },
    ],
    profiles: [
      { id: "native", connection: "anthropic", model: "m" },
      { id: "fake", connection: "fake" },
      { id: "fake-sub", connection: "fake-sub" },
      { id: "nokey", connection: "nokey", model: "m" },
    ],
    defaultProfile: "native",
  });
}

let runtime: Runtime;
let cwd: string;
let store: MemorySessionStore;
let provider: ReturnType<typeof scriptedProvider>;

async function makeRuntime(subscriptionLogins: string[] = []) {
  await runtime?.dispose();
  store = new MemorySessionStore();
  runtime = new Runtime({
    config: config(subscriptionLogins),
    dataDir: await mkdtemp(path.join(tmpdir(), "envoke-data-")),
    credentials: new MemoryStore(),
    store,
    // "nokey" builds its real provider, which needs a key nobody linked.
    providerOverride: (profile) => (profile.id === "nokey" ? undefined : provider),
    acpLaunchOverride: () => ({ command: process.execPath, args: [FAKE_AGENT] }),
  });
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "envoke-cwd-"));
  provider = scriptedProvider([say("salut")]);
  await makeRuntime();
});

afterEach(async () => {
  await runtime.dispose();
});

const text = (events: AgentEvent[]) =>
  events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");

async function session(profileId: string) {
  return (await runtime.createSession({ profileId, cwd })).id;
}

describe("connections and policy", () => {
  it("reports what is linked and what the policy allows", async () => {
    await runtime.linkApiKey("anthropic", "sk-ant-test-key");
    const statuses = Object.fromEntries((await runtime.listConnections()).map((s) => [s.id, s]));
    expect(statuses.anthropic).toMatchObject({ access: "api_key", allowed: true, linked: true });
    expect(statuses.chatgpt).toMatchObject({
      access: "subscription",
      allowed: false,
      linked: false,
    });
    expect(statuses.fake).toMatchObject({
      access: "api_key",
      allowed: true,
      linked: true,
      requires: ["anthropic"],
    });
    expect(statuses["fake-sub"]).toMatchObject({ access: "subscription", allowed: false });
  });

  it("blocks the ChatGPT account and agent logins unless the policy allows them", async () => {
    await expect(runtime.beginChatGPTLogin()).rejects.toMatchObject({ code: "policy" });
    await runtime.linkApiKey("anthropic", "sk-ant-test-key");
    await expect(runtime.agentAuthenticate("fake", "login")).rejects.toMatchObject({
      code: "policy",
    });
    const events = await collect(
      runtime.send(await session("fake-sub"), "hello", new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "error", code: "policy", message: expect.stringContaining("pas autorisée") },
    ]);
  });

  it("hands a terminal sign-in back to the caller when allowed", async () => {
    await makeRuntime(["fake-sub"]);
    const methods = await runtime.agentAuthMethods("fake-sub");
    expect(methods.map((m) => [m.id, m.terminal])).toEqual([
      ["key", false],
      ["login", true],
    ]);
    const { terminal } = await runtime.agentAuthenticate("fake-sub", "login");
    expect(terminal?.args.at(-1)).toBe("--login");
  });

  it("asks to link the key an agent needs", async () => {
    const events = await collect(
      runtime.send(await session("fake"), "hello", new AbortController().signal),
    );
    expect(events[0]).toMatchObject({ type: "error", code: "auth_required" });
  });
});

describe("native sessions", () => {
  it("routes a session to its profile and keeps history across turns", async () => {
    const id = await session("native");
    await collect(runtime.send(id, "bonjour", new AbortController().signal));
    provider = scriptedProvider([say("re")]);
    expect(store.getSession(id)?.title).toBe("bonjour");
    await collect(runtime.send(id, "encore", new AbortController().signal));
    expect(store.loadMessages(id).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("answers permissions through the runtime and logs the decision", async () => {
    provider = scriptedProvider([call("bash", { command: "echo hi" }), say("fait")]);
    const id = await session("native");
    const events = await collect(runtime.send(id, "go", new AbortController().signal), (e) =>
      runtime.resolvePermission(e.requestId, "allow_once"),
    );
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ isError: false });
    expect(store.commands[0]).toMatchObject({ tool: "bash", decision: "allow_once", exitCode: 0 });
  });

  it("passes the response mode to the model for this turn only", async () => {
    const id = await session("native");
    await collect(runtime.send(id, "vite", new AbortController().signal, { effort: "low" }));
    await collect(runtime.send(id, "normal", new AbortController().signal));
    expect(provider.requests.map((r) => r.effort)).toEqual(["low", undefined]);
  });

  it("regenerates: drops the last answer and replays the last user message", async () => {
    provider = scriptedProvider([say("première"), say("seconde")]);
    const id = await session("native");
    await collect(runtime.send(id, "question", new AbortController().signal));
    const events = await collect(runtime.regenerate(id, new AbortController().signal));
    expect(text(events)).toBe("seconde");
    const messages = store.loadMessages(id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.parts).toEqual([{ type: "text", text: "seconde" }]);
    // The replayed request saw the question alone, not the dropped answer.
    expect(provider.requests.at(-1)!.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps the history when the backend cannot start", async () => {
    const id = await session("nokey");
    store.appendMessage(id, { role: "user", parts: [{ type: "text", text: "q" }] });
    store.appendMessage(id, { role: "assistant", parts: [{ type: "text", text: "r" }] });
    const events = await collect(runtime.regenerate(id, new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "error", code: "auth_required" });
    expect(store.loadMessages(id)).toHaveLength(2);
  });

  it("refuses to regenerate with an ACP agent", async () => {
    await runtime.linkApiKey("anthropic", "sk-ant-test-key");
    const id = await session("fake");
    const events = await collect(runtime.regenerate(id, new AbortController().signal));
    expect(events).toEqual([
      { type: "error", code: "bad_request", message: expect.stringContaining("agent") },
    ]);
  });

  it("tells the interface which engine and effort each profile uses", async () => {
    const profiles = Object.fromEntries((await runtime.listProfiles()).map((p) => [p.id, p]));
    expect(profiles.native).toMatchObject({ engine: "native", effort: null });
    expect(profiles.fake).toMatchObject({ engine: "acp" });
  });
});

describe("ACP agents", () => {
  beforeEach(async () => {
    await runtime.linkApiKey("anthropic", "sk-ant-test-key");
  });

  it("streams the agent's answer and stores the transcript", async () => {
    const id = await session("fake");
    const events = await collect(runtime.send(id, "hello", new AbortController().signal));
    expect(text(events)).toBe("echo:hello");
    expect(events.at(-1)).toEqual({ type: "turn_done", stopReason: "end" });
    expect(store.loadMessages(id)).toEqual([
      { role: "user", parts: [{ type: "text", text: "hello" }] },
      { role: "assistant", parts: [{ type: "text", text: "echo:hello" }] },
    ]);
  });

  it("injects the linked key and isolates the agent's own login", async () => {
    const events = await collect(
      runtime.send(await session("fake"), "env", new AbortController().signal),
    );
    expect(text(events)).toBe("key:sk-ant-test-key home:set");
  });

  it.each([
    ["allow_once", "ran:yes", false],
    ["allow_always", "ran:always", false],
    ["deny", "denied", true],
  ] as const)("relays a permission request (%s)", async (decision, output, isError) => {
    const id = await session("fake");
    const events = await collect(runtime.send(id, "tool", new AbortController().signal), (e) =>
      runtime.resolvePermission(e.requestId, decision),
    );
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "tool_start",
      "permission_request",
      "tool_end",
      "turn_done",
    ]);
    expect(events.find((e) => e.type === "permission_request")).toMatchObject({
      title: "List files",
      input: { command: "ls" },
    });
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ output, isError });
  });

  it("cancels a running turn", async () => {
    const controller = new AbortController();
    const id = await session("fake");
    const events: AgentEvent[] = [];
    for await (const e of runtime.send(id, "slow", controller.signal)) {
      events.push(e);
      if (e.type === "text_delta") controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: "turn_done", stopReason: "aborted" });
  });

  it("reloads the agent session after the process restarts, without replaying old text", async () => {
    const id = await session("fake");
    await collect(runtime.send(id, "first", new AbortController().signal));
    const agentSession = store.getSession(id)?.backendSessionId;
    expect(agentSession).toBeTruthy();
    await runtime.dispose(); // stops the agent process
    const events = await collect(runtime.send(id, "second", new AbortController().signal));
    expect(text(events)).toBe("echo:second");
    expect(store.getSession(id)?.backendSessionId).toBe(agentSession);
  });
});

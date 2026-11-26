import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryStore,
  parseConfig,
  Runtime,
  SqliteSessionStore,
  type AgentEvent,
  type Message,
  type ModelEvent,
  type ModelProvider,
  type ChatSnapshot,
  type ClaudeChatEvent,
  type TerminalEvent,
} from "@envoke/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.ts";

const FAKE_CLAUDE = fileURLToPath(
  new URL("../../core/test/fixtures/fake-claude.ts", import.meta.url),
);
/** Not 4317: launched agents post their hooks to this port, and a real envoke may be listening there. */
const PORT = 4391;
const TOKEN = "test-token-123";
const BASE = `http://127.0.0.1:${PORT}`;

/** First turn: a bash call; then a text answer. */
function provider(): ModelProvider {
  let n = 0;
  return {
    kind: "openai-compat",
    async *stream(): AsyncGenerator<ModelEvent> {
      const message: Message =
        n++ === 0
          ? {
              role: "assistant",
              parts: [{ type: "tool_call", id: "c1", name: "bash", input: { command: "echo hi" } }],
            }
          : { role: "assistant", parts: [{ type: "text", text: "terminé" }] };
      if (message.parts[0]?.type === "text") yield { type: "text_delta", text: "terminé" };
      yield { type: "done", stopReason: n === 1 ? "tool_calls" : "end", message };
    },
  };
}

let dbFile: string;
let store: SqliteSessionStore;
let runtime: Runtime;
let app: ReturnType<typeof createApp>;
let cwd: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "envoke-server-"));
  cwd = await mkdtemp(path.join(tmpdir(), "envoke-cwd-"));
  dbFile = path.join(dir, "envoke.sqlite");
  store = SqliteSessionStore.open(dbFile);
  runtime = new Runtime({
    config: parseConfig({
      connections: [{ id: "anthropic", type: "anthropic" }],
      profiles: [{ id: "p", connection: "anthropic", model: "m" }],
      defaultProfile: "p",
    }),
    dataDir: dir,
    credentials: new MemoryStore(),
    store,
    providerOverride: () => provider(),
    claudeCommand: { command: process.execPath, args: [FAKE_CLAUDE] },
  });
  app = createApp({ runtime, token: TOKEN, port: PORT });
});

afterEach(async () => {
  await runtime.dispose();
  store.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

function api(
  method: string,
  route: string,
  json?: unknown,
  headers: Record<string, string> = auth,
) {
  return app.request(`${BASE}${route}`, {
    method,
    headers: { ...headers, ...(json === undefined ? {} : { "content-type": "application/json" }) },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
}

function parseSSE(text: string): AgentEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)) as AgentEvent);
}

describe("security", () => {
  it("requires the token", async () => {
    expect((await api("GET", "/api/sessions", undefined, {})).status).toBe(401);
    expect(
      (await api("GET", "/api/sessions", undefined, { authorization: "Bearer wrong" })).status,
    ).toBe(401);
    expect((await api("GET", "/api/sessions")).status).toBe(200);
  });

  it("refuses foreign origins and hosts", async () => {
    expect(
      (await api("GET", "/api/sessions", undefined, { ...auth, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    const rebound = await app.request(`http://evil.example:${PORT}/api/sessions`, {
      headers: auth,
    });
    expect(rebound.status).toBe(403);
    expect((await api("GET", "/api/sessions", undefined, { ...auth, origin: BASE })).status).toBe(
      200,
    );
  });
});

describe("chat over SSE", () => {
  it("streams a turn, takes the permission decision over HTTP, and persists everything", async () => {
    const created = await api("POST", "/api/sessions", { cwd });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const response = await api("POST", `/api/sessions/${id}/messages`, { text: "dis bonjour" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const request = parseSSE(buffer).find((e) => e.type === "permission_request");
      if (request && request.type === "permission_request" && !buffer.includes("tool_end")) {
        const answered = await api("POST", `/api/permissions/${request.requestId}`, {
          decision: "allow_once",
        });
        expect(answered.status).toBe(204);
      }
    }
    const events = parseSSE(buffer);
    expect(events.map((e) => e.type)).toEqual([
      "tool_start",
      "permission_request",
      "tool_end",
      "text_delta",
      "turn_done",
    ]);

    const history = (await (await api("GET", `/api/sessions/${id}`)).json()) as {
      messages: Message[];
      session: { title: string };
    };
    expect(history.session.title).toBe("dis bonjour");
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(store.commandLog(id)).toMatchObject([
      { tool: "bash", decision: "allow_once", exit_code: 0 },
    ]);
  });

  it("answers 404 for an unknown permission request", async () => {
    expect((await api("POST", "/api/permissions/nope", { decision: "deny" })).status).toBe(404);
  });

  it("validates bodies and reports readable errors", async () => {
    const bad = await api("POST", "/api/sessions", { cwd: "/does/not/exist" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toContain(
      "introuvable",
    );
    expect((await api("POST", "/api/sessions", { nope: 1 })).status).toBe(400);
  });
});

describe("interface and new routes", () => {
  it("serves the interface without the token, with a strict CSP, and keeps /api locked", async () => {
    const web = await mkdtemp(path.join(tmpdir(), "envoke-web-"));
    await mkdir(path.join(web, "assets"));
    await writeFile(path.join(web, "index.html"), "<!doctype html><title>envoke</title>");
    await writeFile(path.join(web, "assets", "app-1a2b.js"), "console.log(1)");
    const withUi = createApp({ runtime, token: TOKEN, port: PORT, webDir: web });

    const page = await withUi.request(`${BASE}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain("<title>envoke</title>");
    const route = await withUi.request(`${BASE}/sessions/abc`);
    expect(await route.text()).toContain("<title>envoke</title>"); // app route → index.html
    const asset = await withUi.request(`${BASE}/assets/app-1a2b.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const escape = await withUi.request(`${BASE}/%2e%2e/%2e%2e/etc/passwd`);
    expect(await escape.text()).not.toContain("root:");
    expect((await withUi.request(`${BASE}/api/sessions`)).status).toBe(401);
    expect((await withUi.request(`http://evil.example:${PORT}/`)).status).toBe(403);
  });

  it("regenerates over SSE and reports the home directory", async () => {
    const { id } = (await (await api("POST", "/api/sessions", { cwd })).json()) as { id: string };
    await drain(
      await api("POST", `/api/sessions/${id}/messages`, { text: "salut", effort: "low" }),
    );
    const again = await drain(await api("POST", `/api/sessions/${id}/regenerate`, {}));
    expect(again.at(-1)).toMatchObject({ type: "turn_done" });
    const bad = await api("POST", `/api/sessions/${id}/messages`, { text: "x", effort: "nope" });
    expect(bad.status).toBe(400);
    const info = (await (await api("GET", "/api/info")).json()) as { home: string };
    expect(info.home.length).toBeGreaterThan(0);
  });
});

/** Reads a turn's SSE stream to the end, allowing every permission request once. */
async function drain(response: Response): Promise<AgentEvent[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const answered = new Set<string>();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (const e of parseSSE(buffer)) {
      if (e.type === "permission_request" && !answered.has(e.requestId)) {
        answered.add(e.requestId);
        await api("POST", `/api/permissions/${e.requestId}`, { decision: "allow_once" });
      }
    }
  }
  return parseSSE(buffer);
}

describe("connections", () => {
  it("links an API key without ever storing it in the database", async () => {
    const linked = await api("POST", "/api/connections/anthropic/link", {
      apiKey: "sk-ant-very-secret-key",
    });
    expect(((await linked.json()) as { linked: boolean }).linked).toBe(true);
    await api("POST", "/api/sessions", { cwd });
    store.close();
    const bytes = await readFile(dbFile);
    const wal = await readFile(`${dbFile}-wal`).catch(() => Buffer.alloc(0));
    expect(bytes.includes("sk-ant-very-secret-key")).toBe(false);
    expect(wal.includes("sk-ant-very-secret-key")).toBe(false);
    store = SqliteSessionStore.open(dbFile);
  });
});

describe("persistence", () => {
  it("keeps sessions across restarts and cascades deletes", () => {
    const s = store.createSession({ id: "s1", profileId: "p", cwd });
    store.appendMessage(s.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      native: { provider: "anthropic", data: [1] },
    });
    store.logCommand({
      sessionId: s.id,
      tool: "bash",
      input: { command: "ls" },
      decision: "deny",
      exitCode: null,
    });
    store.close();
    store = SqliteSessionStore.open(dbFile); // migrations run again on an up-to-date base
    expect(store.loadMessages("s1")).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        native: { provider: "anthropic", data: [1] },
      },
    ]);
    store.deleteSession("s1");
    expect(store.loadMessages("s1")).toEqual([]);
    expect(store.commandLog("s1")).toEqual([]);
  });
});

describe("Claude Code terminal", () => {
  /** Reads the SSE stream until `done` says so, then hangs up like a closed tab. */
  async function watch(id: string, done: (events: TerminalEvent[]) => boolean) {
    const controller = new AbortController();
    const response = await app.request(`${BASE}/api/terminals/${id}/stream?cols=80&rows=24`, {
      headers: auth,
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const events = () => parseSSE(buffer) as unknown as TerminalEvent[];
    while (!done(events())) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += value;
    }
    controller.abort();
    return events();
  }
  const screen = (events: TerminalEvent[]) =>
    events.map((e) => (e.type === "snapshot" || e.type === "data" ? e.data : "")).join("");

  it("reports the install, opens a terminal, streams it and takes keystrokes", async () => {
    expect(await (await api("GET", "/api/claude-code")).json()).toEqual({
      installed: true,
      path: process.execPath,
    });
    const created = await api("POST", "/api/terminals", { cwd, prompt: "salut" });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string; kind: string; title: string };
    expect(session).toMatchObject({ kind: "terminal", title: "salut" });

    const first = await watch(session.id, (e) => screen(e).includes("leaked:"));
    expect(first[0]).toMatchObject({ type: "snapshot", running: true });
    expect(screen(first)).toContain(`args: ["--session-id","${session.id}","salut"]`);

    expect((await api("POST", `/api/terminals/${session.id}/input`, { data: "ok\r" })).status).toBe(
      204,
    );
    expect(
      (await api("POST", `/api/terminals/${session.id}/resize`, { cols: 120, rows: 40 })).status,
    ).toBe(204);
    const again = await watch(session.id, (e) => screen(e).includes("reçu: ok"));
    expect(again[0]).toMatchObject({ type: "snapshot" });

    expect((await api("POST", `/api/terminals/${session.id}/stop`)).status).toBe(204);
    // The kill may land before or after this viewer attaches.
    const stopped = await watch(
      session.id,
      (e) => e.some((x) => x.type === "exit") || (e[0]?.type === "snapshot" && !e[0].running),
    );
    expect(stopped[0]?.type).toBe("snapshot");

    const listed = (await (await api("GET", "/api/sessions")).json()) as { kind: string }[];
    expect(listed.map((s) => s.kind)).toEqual(["terminal"]);
  });

  it("refuses chat routes on a terminal and terminal routes on a chat", async () => {
    const terminal = (await (await api("POST", "/api/terminals", { cwd })).json()) as {
      id: string;
    };
    const chat = (await (await api("POST", "/api/sessions", { cwd })).json()) as { id: string };
    expect((await api("POST", `/api/terminals/${chat.id}/input`, { data: "x" })).status).toBe(400);
    expect((await api("PATCH", `/api/sessions/${terminal.id}`, { profileId: "p" })).status).toBe(
      400,
    );
    const missing = await app.request(`${BASE}/api/terminals/${terminal.id}/stream`, {
      headers: auth,
    });
    expect(missing.status).toBe(400);
    expect((await api("GET", `/api/terminals/nope/stream?cols=80&rows=24`)).status).toBe(404);
    expect((await api("POST", "/api/terminals", { cwd: path.join(cwd, "absent") })).status).toBe(
      400,
    );
  });
});

describe("Claude Code chat view (real HTTP, fake Claude Code posting its hooks)", () => {
  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    return port;
  }

  it("shows a turn from the hooks, asks permission in envoke and sends messages", async () => {
    const port = await freePort();
    const live = createApp({ runtime, token: TOKEN, port });
    const server = serve({ fetch: live.fetch, hostname: "127.0.0.1", port });
    const base = `http://127.0.0.1:${port}`;
    const call = (method: string, route: string, json?: unknown) =>
      fetch(`${base}${route}`, {
        method,
        headers: { ...auth, ...(json === undefined ? {} : { "content-type": "application/json" }) },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      });
    const controller = new AbortController();
    try {
      const session = (await (await call("POST", "/api/terminals", { cwd })).json()) as {
        id: string;
      };
      const response = await fetch(`${base}/api/terminals/${session.id}/chat`, {
        headers: auth,
        signal: controller.signal,
      });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      const events = () => parseSSE(buffer) as unknown as (ClaudeChatEvent | ChatSnapshot)[];
      const until = async (check: (e: (ClaudeChatEvent | ChatSnapshot)[]) => boolean) => {
        while (!check(events())) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended: ${buffer}`);
          buffer += value;
        }
      };

      // SessionStart arrives through the hook once the fake Claude Code is up.
      await until((e) => e.some((x) => x.type === "notice" && x.kind === "ready"));
      expect(events()[0]).toMatchObject({ type: "history", messages: [], running: true });

      expect(
        (await call("POST", `/api/terminals/${session.id}/prompt`, { text: "liste" })).status,
      ).toBe(204);
      await until((e) => e.some((x) => x.type === "permission_request"));
      const request = events().find((x) => x.type === "permission_request") as Extract<
        ClaudeChatEvent,
        { type: "permission_request" }
      >;
      expect(request).toMatchObject({ toolCallId: "toolu_1", tool: "Bash" });
      expect(
        (await call("POST", `/api/permissions/${request.requestId}`, { decision: "allow_once" }))
          .status,
      ).toBe(204);
      await until((e) => e.some((x) => x.type === "turn_done"));

      expect(events().map((e) => e.type)).toEqual([
        "history",
        "notice",
        "prompt",
        "text_delta",
        "tool_start",
        "permission_request",
        "tool_end",
        "text_delta",
        "turn_done",
      ]);
      expect(events().find((e) => e.type === "tool_end")).toMatchObject({
        output: "a.txt\nb.txt",
        isError: false,
      });

      const stored = (await (await call("GET", `/api/sessions/${session.id}`)).json()) as {
        session: { title: string };
        messages: { role: string }[];
      };
      expect(stored.session.title).toBe("liste");
      expect(stored.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "assistant",
        "tool",
        "assistant",
      ]);

      const forged = await fetch(`${base}/api/hooks/${session.id}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "faux" }),
      });
      expect(forged.status).toBe(401);
    } finally {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

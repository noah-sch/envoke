import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  MemoryStore,
  parseConfig,
  Runtime,
  SqliteSessionStore,
  type TerminalEvent,
} from "../src/index.ts";
import { collect } from "./helpers.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.ts", import.meta.url));
const SIZE = { cols: 100, rows: 30 };

let runtime: Runtime;
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "envoke-term-"));
  runtime = new Runtime({
    config: parseConfig({
      connections: [{ id: "anthropic", type: "anthropic" }],
      profiles: [{ id: "p", connection: "anthropic", model: "m" }],
      defaultProfile: "p",
    }),
    dataDir: await mkdtemp(path.join(tmpdir(), "envoke-data-")),
    credentials: new MemoryStore(),
    store: new MemorySessionStore(),
    claudeCommand: { command: process.execPath, args: [FAKE_CLAUDE] },
  });
});

afterEach(async () => {
  await runtime.dispose();
});

/** A viewer: collects events, and waits until the screen it rebuilt shows some text. */
async function viewer(sessionId: string) {
  const events: TerminalEvent[] = [];
  const detach = await runtime.attachTerminal(sessionId, SIZE, (e) => events.push(e));
  const text = () =>
    events
      .map((e) => (e.type === "snapshot" || e.type === "data" ? e.data : ""))
      .join("")
      .replace(/\r/g, "");
  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}:\n${text()}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  // The snapshot arrives once the server's copy of the screen has caught up.
  await until(() => events.length > 0, "snapshot");
  return {
    events,
    detach,
    text,
    until,
    waitText: (needle: string) => until(() => text().includes(needle), JSON.stringify(needle)),
    waitExit: () => until(() => events.some((e) => e.type === "exit"), "exit"),
  };
}

describe("Claude Code terminal", () => {
  it("starts on first view with the session id and the first request, without secrets", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "sk-ant-test",
      ENVOKE_TOKEN: "secret",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_USE_BEDROCK: "0",
    });
    try {
      const session = await runtime.openTerminal({ cwd, prompt: "Explique ce dépôt" });
      expect(session).toMatchObject({ kind: "terminal", title: "Explique ce dépôt", cwd });
      const v = await viewer(session.id);
      expect(v.events[0]).toMatchObject({ type: "snapshot" });
      await v.waitText("leaked:");
      expect(v.text()).toContain(`args: ["--session-id","${session.id}","Explique ce dépôt"]`);
      expect(v.text()).toContain("leaked: [] term: xterm-256color kept: 0");
      v.detach();
    } finally {
      process.env = saved;
    }
  });

  it("relays input, and a viewer that comes back gets the screen so far", async () => {
    const session = await runtime.openTerminal({ cwd });
    expect(session.title).toBe(`Claude Code · ${path.basename(cwd)}`);
    const first = await viewer(session.id);
    await first.waitText("leaked:");
    expect(first.text()).toContain(`args: ["--session-id","${session.id}"]`);
    runtime.terminalInput(session.id, "bonjour\r");
    await first.waitText("reçu: bonjour");
    first.detach();

    const second = await viewer(session.id);
    expect(second.events[0]).toMatchObject({ type: "snapshot", running: true });
    await second.waitText("reçu: bonjour");
    second.detach();
  });

  it("reports the exit, keeps the last screen, and resumes the conversation", async () => {
    const session = await runtime.openTerminal({ cwd });
    const v = await viewer(session.id);
    await v.waitText("leaked:");
    runtime.terminalInput(session.id, "un message\r");
    await v.waitText("reçu: un message");
    runtime.terminalInput(session.id, "exit\r");
    await v.waitExit();
    expect(v.events.find((e) => e.type === "exit")).toEqual({ type: "exit", exitCode: 0 });
    v.detach();

    const after = await viewer(session.id);
    expect(after.events[0]).toMatchObject({ type: "snapshot", running: false, exitCode: 0 });
    expect(after.text()).toContain("reçu: un message");

    await runtime.resumeTerminal(session.id, SIZE);
    await after.until(() => after.events.some((e) => e.type === "start"), "start");
    await after.waitText(`args: ["--resume","${session.id}"]`);
    after.detach();
  });

  it("starts afresh under the same id when there was nothing to resume", async () => {
    const session = await runtime.openTerminal({ cwd });
    const v = await viewer(session.id);
    await v.waitText("leaked:");
    runtime.stopTerminal(session.id);
    await v.waitExit();

    await runtime.resumeTerminal(session.id, SIZE);
    await v.until(() => v.events.filter((e) => e.type === "start").length === 2, "fresh start");
    await v.waitText(`args: ["--session-id","${session.id}"]`);
    expect(runtime.store.getSession(session.id)?.kind).toBe("terminal");
    v.detach();
  });

  it("after a restart, shows an empty stopped screen until the user resumes", async () => {
    const session = runtime.store.createSession({
      id: "4a1d2c3e-0000-4000-8000-000000000001",
      kind: "terminal",
      profileId: "claude-code",
      cwd,
    });
    const v = await viewer(session.id);
    expect(v.events).toEqual([{ type: "snapshot", data: "", running: false, exitCode: null }]);
    v.detach();
  });

  it("deleting the session stops the process", async () => {
    const session = await runtime.openTerminal({ cwd });
    const v = await viewer(session.id);
    await v.waitText("leaked:");
    runtime.deleteSession(session.id);
    expect(runtime.store.getSession(session.id)).toBeUndefined();
    expect(() => runtime.terminalInput(session.id, "x")).toThrow(/inconnue/);
  });

  it("keeps chats and terminals apart", async () => {
    const terminal = await runtime.openTerminal({ cwd });
    const events = await collect(runtime.send(terminal.id, "salut", new AbortController().signal));
    expect(events).toEqual([
      { type: "error", code: "bad_request", message: "Cette session est un terminal Claude Code." },
    ]);
    expect(() => runtime.setSessionProfile(terminal.id, "p")).toThrow(/profil/);
    const chat = await runtime.createSession({ cwd });
    expect(chat.kind).toBe("chat");
    expect(() => runtime.terminalInput(chat.id, "x")).toThrow(/pas un terminal/);
    await expect(runtime.openTerminal({ cwd: path.join(cwd, "absent") })).rejects.toThrow(
      /introuvable/,
    );
  });
});

describe("SQLite store", () => {
  it("adds the kind column to an existing database: older sessions are chats", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "envoke-db-")), "envoke.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', backend_session_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO sessions VALUES ('old', 'p', '/tmp', '', NULL, '2026-01-01', '2026-01-01');
      PRAGMA user_version = 1;`);
    old.close();
    const store = SqliteSessionStore.open(file);
    store.createSession({ id: "new", kind: "terminal", profileId: "claude-code", cwd });
    expect(store.getSession("old")?.kind).toBe("chat");
    expect(store.getSession("new")?.kind).toBe("terminal");
    store.close();
  });
});

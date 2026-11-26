import { DatabaseSync } from "node:sqlite";
import type { AuditEntry } from "./agent/loop.ts";
import type { NewSession, SessionStore } from "./store.ts";
import type { Message, SessionRecord } from "./types.ts";

/** Numbered migrations: index + 1 is the schema version stored in PRAGMA user_version. */
const MIGRATIONS = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     profile_id TEXT NOT NULL,
     cwd TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     backend_session_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE messages (
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL,
     content TEXT NOT NULL,
     PRIMARY KEY (session_id, seq)
   );
   CREATE TABLE command_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     tool TEXT NOT NULL,
     input TEXT NOT NULL,
     decision TEXT NOT NULL,
     exit_code INTEGER,
     created_at TEXT NOT NULL
   );
   CREATE INDEX command_log_session ON command_log(session_id);
   CREATE INDEX sessions_updated ON sessions(updated_at);`,
  `ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';`,
];

interface SessionRow {
  id: string;
  kind: SessionRecord["kind"];
  profile_id: string;
  cwd: string;
  title: string;
  backend_session_id: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: SessionRow): SessionRecord => ({
  id: r.id,
  kind: r.kind,
  profileId: r.profile_id,
  cwd: r.cwd,
  title: r.title,
  backendSessionId: r.backend_session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Sessions, messages and the command log. Never any secret. */
export class SqliteSessionStore implements SessionStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(file: string): SqliteSessionStore {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    migrate(db);
    return new SqliteSessionStore(db);
  }

  close(): void {
    this.#db.close();
  }

  createSession(input: NewSession): SessionRecord {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        "INSERT INTO sessions (id, kind, profile_id, cwd, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.kind ?? "chat", input.profileId, input.cwd, input.title ?? "", now, now);
    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      SessionRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listSessions(): SessionRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
      .all() as unknown as SessionRow[];
    return rows.map(toRecord);
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "title" | "profileId" | "backendSessionId">>,
  ): void {
    const current = this.getSession(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.#db
      .prepare(
        "UPDATE sessions SET title = ?, profile_id = ?, backend_session_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(next.title, next.profileId, next.backendSessionId, new Date().toISOString(), id);
  }

  deleteSession(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  loadMessages(sessionId: string): Message[] {
    const rows = this.#db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as unknown as { role: Message["role"]; content: string }[];
    return rows.map((r) => ({ role: r.role, ...(JSON.parse(r.content) as Omit<Message, "role">) }));
  }

  appendMessage(sessionId: string, message: Message): void {
    const { role, ...content } = message;
    this.#db
      .prepare(
        "INSERT INTO messages (session_id, seq, role, content) " +
          "VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?)",
      )
      .run(sessionId, sessionId, role, JSON.stringify(content));
    this.#db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), sessionId);
  }

  truncateMessages(sessionId: string, keep: number): void {
    // seq runs 1..n without gaps: messages are only appended, and truncation keeps a prefix.
    this.#db.prepare("DELETE FROM messages WHERE session_id = ? AND seq > ?").run(sessionId, keep);
  }

  logCommand(entry: AuditEntry): void {
    this.#db
      .prepare(
        "INSERT INTO command_log (session_id, tool, input, decision, exit_code, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.sessionId,
        entry.tool,
        JSON.stringify(entry.input),
        entry.decision,
        entry.exitCode,
        new Date().toISOString(),
      );
  }

  commandLog(
    sessionId: string,
  ): { tool: string; input: string; decision: string; exit_code: number | null }[] {
    return this.#db
      .prepare(
        "SELECT tool, input, decision, exit_code FROM command_log WHERE session_id = ? ORDER BY id",
      )
      .all(sessionId) as unknown as {
      tool: string;
      input: string;
      decision: string;
      exit_code: number | null;
    }[];
  }
}

function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

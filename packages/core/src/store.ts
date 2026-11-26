import type { AuditEntry } from "./agent/loop.ts";
import type { Message, SessionRecord } from "./types.ts";

export interface NewSession {
  id: string;
  kind?: SessionRecord["kind"];
  profileId: string;
  cwd: string;
  title?: string;
}

/** Synchronous on purpose: node:sqlite is synchronous and fast for this volume. */
export interface SessionStore {
  createSession(input: NewSession): SessionRecord;
  getSession(id: string): SessionRecord | undefined;
  listSessions(): SessionRecord[];
  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "title" | "profileId" | "backendSessionId">>,
  ): void;
  deleteSession(id: string): void;
  loadMessages(sessionId: string): Message[];
  appendMessage(sessionId: string, message: Message): void;
  /** Keeps the first `keep` messages and drops the rest (Regenerate removes the last turn). */
  truncateMessages(sessionId: string, keep: number): void;
  logCommand(entry: AuditEntry): void;
}

export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #messages = new Map<string, Message[]>();
  readonly commands: AuditEntry[] = [];

  createSession(input: NewSession): SessionRecord {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: input.id,
      kind: input.kind ?? "chat",
      profileId: input.profileId,
      cwd: input.cwd,
      title: input.title ?? "",
      createdAt: now,
      updatedAt: now,
      backendSessionId: null,
    };
    this.#sessions.set(record.id, record);
    this.#messages.set(record.id, []);
    return record;
  }

  getSession(id: string): SessionRecord | undefined {
    return this.#sessions.get(id);
  }

  listSessions(): SessionRecord[] {
    return [...this.#sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "title" | "profileId" | "backendSessionId">>,
  ): void {
    const record = this.#sessions.get(id);
    if (record) Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  }

  deleteSession(id: string): void {
    this.#sessions.delete(id);
    this.#messages.delete(id);
  }

  loadMessages(sessionId: string): Message[] {
    return structuredClone(this.#messages.get(sessionId) ?? []);
  }

  appendMessage(sessionId: string, message: Message): void {
    this.#messages.get(sessionId)?.push(structuredClone(message));
    this.updateSession(sessionId, {});
  }

  truncateMessages(sessionId: string, keep: number): void {
    this.#messages.get(sessionId)?.splice(keep);
  }

  logCommand(entry: AuditEntry): void {
    this.commands.push(entry);
  }
}

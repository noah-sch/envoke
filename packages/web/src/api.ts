import type {
  AgentEvent,
  ChatSnapshot,
  ClaudeChatEvent,
  ClaudeCodeStatus,
  ConnectionStatus,
  Decision,
  Effort,
  ProfileInfo,
  SessionRecord,
  TerminalEvent,
} from "@envoke/core/types";
import { SseParser } from "./sse.ts";
import type { StoredMessage } from "./turns.ts";

const TOKEN_KEY = "envoke.token";

/**
 * The desktop shell opens `/#token=…`: the fragment never reaches the server or its logs. The
 * token is kept for this window only, then removed from the address bar.
 */
export function readToken(): string | null {
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (match?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]));
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ConnectionDetail extends ConnectionStatus {
  login: { state: "pending" | "linked" | "error"; error: string | null } | null;
}

export class Api {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async #fetch(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError("network", "Le moteur local ne répond pas. Relancez l'application.", 0);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { code: string; message: string };
      } | null;
      throw new ApiError(
        payload?.error?.code ?? "server",
        payload?.error?.message ?? `Erreur ${response.status}`,
        response.status,
      );
    }
    return response;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(method, path, body);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  info = () => this.#json<{ version: string; home: string }>("GET", "/api/info");
  profiles = () =>
    this.#json<{ defaultProfile: string; profiles: ProfileInfo[] }>("GET", "/api/profiles");
  connections = () => this.#json<ConnectionStatus[]>("GET", "/api/connections");
  connection = (id: string) => this.#json<ConnectionDetail>("GET", `/api/connections/${id}`);
  linkKey = (id: string, apiKey: string) =>
    this.#json<ConnectionStatus>("POST", `/api/connections/${id}/link`, { apiKey });
  beginLogin = (id: string) =>
    this.#json<{ authorizeUrl: string }>("POST", `/api/connections/${id}/link`, {});
  unlink = (id: string) => this.#json<{ revoked: boolean }>("DELETE", `/api/connections/${id}`);

  sessions = () => this.#json<SessionRecord[]>("GET", "/api/sessions");
  session = (id: string) =>
    this.#json<{ session: SessionRecord; messages: StoredMessage[]; running: boolean }>(
      "GET",
      `/api/sessions/${id}`,
    );
  createSession = (input: { cwd: string; profileId: string }) =>
    this.#json<SessionRecord>("POST", "/api/sessions", input);
  updateSession = (id: string, patch: { title?: string; profileId?: string }) =>
    this.#json<SessionRecord>("PATCH", `/api/sessions/${id}`, patch);
  deleteSession = (id: string) => this.#json<void>("DELETE", `/api/sessions/${id}`);
  abort = (id: string) => this.#json<void>("POST", `/api/sessions/${id}/abort`);
  decide = (requestId: string, decision: Decision) =>
    this.#json<void>("POST", `/api/permissions/${requestId}`, { decision });

  claudeCode = () => this.#json<ClaudeCodeStatus>("GET", "/api/claude-code");
  openTerminal = (input: { cwd: string; prompt?: string }) =>
    this.#json<SessionRecord>("POST", "/api/terminals", input);
  terminalInput = (id: string, data: string) =>
    this.#json<void>("POST", `/api/terminals/${id}/input`, { data });
  terminalResize = (id: string, size: TerminalSize) =>
    this.#json<void>("POST", `/api/terminals/${id}/resize`, size);
  terminalStop = (id: string) => this.#json<void>("POST", `/api/terminals/${id}/stop`);
  terminalResume = (id: string, size: TerminalSize) =>
    this.#json<void>("POST", `/api/terminals/${id}/resume`, size);

  claudePrompt = (id: string, text: string) =>
    this.#json<void>("POST", `/api/terminals/${id}/prompt`, { text });
  claudeInterrupt = (id: string) => this.#json<void>("POST", `/api/terminals/${id}/interrupt`);

  /** Follows Claude Code's chat view: a `history` snapshot first, then live events. */
  async claudeChat(
    id: string,
    onEvent: (event: ClaudeChatEvent | ChatSnapshot) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.#fetch("GET", `/api/terminals/${id}/chat`, undefined, signal);
    await this.#events(response, onEvent);
  }

  /** Follows a terminal until `signal` aborts or the engine hangs up. */
  async terminalStream(
    id: string,
    size: TerminalSize,
    onEvent: (event: TerminalEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const query = `cols=${size.cols}&rows=${size.rows}`;
    const response = await this.#fetch(
      "GET",
      `/api/terminals/${id}/stream?${query}`,
      undefined,
      signal,
    );
    await this.#events(response, onEvent);
  }

  /** Sends a message (or regenerates) and calls `onEvent` for each event as it streams in. */
  async stream(
    sessionId: string,
    request: { text: string } | { regenerate: true },
    effort: Effort | null,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const path =
      "text" in request
        ? `/api/sessions/${sessionId}/messages`
        : `/api/sessions/${sessionId}/regenerate`;
    const body = {
      ...("text" in request ? { text: request.text } : {}),
      ...(effort ? { effort } : {}),
    };
    const response = await this.#fetch("POST", path, body, signal);
    await this.#events(response, onEvent);
  }

  async #events<T>(response: Response, onEvent: (event: T) => void): Promise<void> {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const data of parser.push(value)) onEvent(JSON.parse(data) as T);
    }
  }
}

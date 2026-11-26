import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AuthMethod,
  type ClientConnection,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { PermissionBroker } from "../agent/permissions.ts";
import { EnvokeError, toEnvokeError } from "../errors.ts";
import { EventQueue } from "../queue.ts";
import type { SessionStore } from "../store.ts";
import { safeEnv } from "../tools/bash.ts";
import { BoundedOutput, truncateMiddle } from "../tools/output.ts";
import type { AgentBackend, AgentEvent, ContentPart, Decision, SendOptions } from "../types.ts";
import type { LaunchSpec } from "./registry.ts";

export interface AcpBackendOptions {
  connectionId: string;
  label: string;
  launch: () => Promise<LaunchSpec>;
  /** Variables injected into the agent process (API keys). Throws when a required key is missing. */
  env: () => Promise<Record<string, string>>;
  /** Auth method reading the injected key, called once per process. */
  authMethod?: string;
  store: SessionStore;
  broker: PermissionBroker;
  idleMs: number;
}

interface Turn {
  sessionId: string;
  events: EventQueue<AgentEvent>;
  signal: AbortSignal;
  tools: Map<string, { name: string; title: string; input: unknown; ended: boolean }>;
  text: string;
  parts: ContentPart[];
  results: ContentPart[];
}

interface AgentProcess {
  child: ChildProcess;
  connection: ClientConnection;
  init: InitializeResponse;
  /** ACP sessions this process knows (created or loaded since it started). */
  sessions: Set<string>;
  /** Sessions being reloaded: their replayed history is not part of any turn. */
  loading: Set<string>;
  turns: Map<string, Turn>;
  dead: boolean;
  stderr: BoundedOutput;
}

/**
 * Agent Client Protocol backend: the editor's agent (Claude Agent, Codex, Gemini CLI…) runs its
 * own loop and tools; we stream its updates and answer its permission requests. One long-lived
 * process per connection, shared by all sessions, started on first use, stopped when idle.
 */
export class AcpBackend implements AgentBackend {
  readonly #o: AcpBackendOptions;
  #process: AgentProcess | null = null;
  #starting: Promise<AgentProcess> | null = null;
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(options: AcpBackendOptions) {
    this.#o = options;
  }

  async authMethods(): Promise<AuthMethod[]> {
    return (await this.#ensureProcess()).init.authMethods ?? [];
  }

  /**
   * Runs one of the agent's own sign-in methods. A "terminal" method must be run interactively by
   * the caller; the returned command is the agent's program with the method's arguments.
   */
  async authenticate(
    methodId: string,
  ): Promise<{ terminal: (LaunchSpec & { env: Record<string, string> }) | null }> {
    const proc = await this.#ensureProcess();
    const method = proc.init.authMethods?.find((m) => m.id === methodId);
    if (!method) throw new EnvokeError("not_found", `Méthode de connexion inconnue : ${methodId}`);
    if ("type" in method && method.type === "terminal") {
      const spec = await this.#o.launch();
      return {
        terminal: {
          command: spec.command,
          args: [...spec.args, ...(method.args ?? [])],
          env: method.env ?? {},
        },
      };
    }
    await proc.connection.agent.request("authenticate", { methodId });
    return { terminal: null };
  }

  async *send(
    sessionId: string,
    userText: string,
    signal: AbortSignal,
    _options?: SendOptions,
  ): AsyncGenerator<AgentEvent> {
    const session = this.#o.store.getSession(sessionId);
    if (!session) throw new EnvokeError("not_found", `Session inconnue : ${sessionId}`);
    this.#cancelIdle();
    const proc = await this.#ensureProcess();
    const acpSessionId = await this.#ensureSession(
      proc,
      sessionId,
      session.cwd,
      session.backendSessionId,
    );
    if (proc.turns.has(acpSessionId))
      throw new EnvokeError("bad_request", "Un tour est déjà en cours dans cette session.");

    this.#o.store.appendMessage(sessionId, {
      role: "user",
      parts: [{ type: "text", text: userText }],
    });
    const turn: Turn = {
      sessionId,
      events: new EventQueue(),
      signal,
      tools: new Map(),
      text: "",
      parts: [],
      results: [],
    };
    proc.turns.set(acpSessionId, turn);
    const cancel = () =>
      void proc.connection.agent
        .notify("session/cancel", { sessionId: acpSessionId })
        .catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });

    proc.connection.agent
      .request("session/prompt", {
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: userText }],
      })
      .then((response) => {
        const stop = signal.aborted ? "cancelled" : response.stopReason;
        turn.events.push({
          type: "turn_done",
          stopReason:
            stop === "cancelled"
              ? "aborted"
              : stop === "max_tokens"
                ? "max_tokens"
                : stop === "refusal"
                  ? "refusal"
                  : stop === "max_turn_requests"
                    ? "max_iterations"
                    : "end",
        });
        turn.events.end();
      })
      .catch((error: unknown) => turn.events.fail(this.#agentError(error, proc)));

    try {
      for await (const event of turn.events) yield event;
    } catch (error) {
      const e = toEnvokeError(error);
      yield { type: "error", code: e.code, message: e.message };
    } finally {
      signal.removeEventListener("abort", cancel);
      proc.turns.delete(acpSessionId);
      this.#persist(turn);
      this.#scheduleIdle();
    }
  }

  async dispose(): Promise<void> {
    this.#cancelIdle();
    this.#kill();
  }

  #persist(turn: Turn): void {
    if (turn.text) turn.parts.unshift({ type: "text", text: turn.text });
    if (turn.parts.length > 0)
      this.#o.store.appendMessage(turn.sessionId, { role: "assistant", parts: turn.parts });
    if (turn.results.length > 0)
      this.#o.store.appendMessage(turn.sessionId, { role: "tool", parts: turn.results });
  }

  async #ensureSession(
    proc: AgentProcess,
    sessionId: string,
    cwd: string,
    known: string | null,
  ): Promise<string> {
    if (known && proc.sessions.has(known)) return known;
    const agent = proc.connection.agent;
    if (known) {
      const capabilities = proc.init.agentCapabilities;
      try {
        if (capabilities?.loadSession) {
          proc.loading.add(known);
          try {
            await agent.request("session/load", { sessionId: known, cwd, mcpServers: [] });
          } finally {
            proc.loading.delete(known);
          }
          proc.sessions.add(known);
          return known;
        }
        if (capabilities?.sessionCapabilities?.resume) {
          await agent.request("session/resume", { sessionId: known, cwd });
          proc.sessions.add(known);
          return known;
        }
      } catch {
        // The agent lost the session: start a new one below.
      }
    }
    let created: string;
    try {
      ({ sessionId: created } = await agent.request("session/new", { cwd, mcpServers: [] }));
    } catch (error) {
      throw this.#agentError(error, proc);
    }
    proc.sessions.add(created);
    this.#o.store.updateSession(sessionId, { backendSessionId: created });
    return created;
  }

  #ensureProcess(): Promise<AgentProcess> {
    if (this.#process && !this.#process.dead) return Promise.resolve(this.#process);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<AgentProcess> {
    const [spec, env] = await Promise.all([this.#o.launch(), this.#o.env()]);
    const child = spawn(spec.command, spec.args, {
      env: { ...safeEnv(), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = new BoundedOutput(4000);
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) =>
        reject(
          new EnvokeError("agent", `Impossible de lancer ${this.#o.label} : ${error.message}`, {
            cause: error,
          }),
        ),
      );
    });
    await spawned;

    const proc: AgentProcess = {
      child,
      connection: undefined as unknown as ClientConnection,
      init: undefined as unknown as InitializeResponse,
      sessions: new Set(),
      loading: new Set(),
      turns: new Map(),
      dead: false,
      stderr,
    };
    const app = client({ name: "envoke" })
      .onNotification("session/update", ({ params }) => this.#onUpdate(proc, params))
      .onRequest("session/request_permission", ({ params }) => this.#onPermission(proc, params));
    proc.connection = app.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      ),
    );
    child.once("exit", (code) => {
      proc.dead = true;
      proc.connection.close();
      const error = new EnvokeError(
        "agent",
        `${this.#o.label} s'est arrêté (code ${code ?? "?"}). ${proc.stderr}`.trim(),
      );
      for (const turn of proc.turns.values()) turn.events.fail(error);
      if (this.#process === proc) this.#process = null;
    });

    try {
      proc.init = await proc.connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "envoke", version: "0.1.0" },
      });
      const method = this.#o.authMethod;
      if (method && proc.init.authMethods?.some((m) => m.id === method)) {
        await proc.connection.agent.request("authenticate", { methodId: method });
      }
    } catch (error) {
      child.kill("SIGKILL");
      throw this.#agentError(error, proc);
    }
    this.#process = proc;
    return proc;
  }

  #onUpdate(proc: AgentProcess, { sessionId, update }: SessionNotification): void {
    if (proc.loading.has(sessionId)) return;
    const turn = proc.turns.get(sessionId);
    if (!turn) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          turn.text += update.content.text;
          turn.events.push({ type: "text_delta", text: update.content.text });
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text")
          turn.events.push({ type: "thinking_delta", text: update.content.text });
        break;
      case "tool_call": {
        const name = update.name ?? update.kind ?? "tool";
        turn.tools.set(update.toolCallId, {
          name,
          title: update.title,
          input: update.rawInput ?? {},
          ended: false,
        });
        turn.parts.push({
          type: "tool_call",
          id: update.toolCallId,
          name,
          input: update.rawInput ?? {},
        });
        turn.events.push({
          type: "tool_start",
          id: update.toolCallId,
          name,
          input: update.rawInput ?? {},
          title: update.title,
        });
        this.#maybeEnd(turn, update);
        break;
      }
      case "tool_call_update":
        this.#maybeEnd(turn, update);
        break;
      default:
        break;
    }
  }

  #maybeEnd(turn: Turn, update: ToolCallUpdate): void {
    if (update.status !== "completed" && update.status !== "failed") return;
    const tool = turn.tools.get(update.toolCallId);
    if (!tool || tool.ended) return;
    tool.ended = true;
    const output = toolOutput(update);
    const isError = update.status === "failed";
    turn.results.push({ type: "tool_result", toolCallId: update.toolCallId, output, isError });
    turn.events.push({ type: "tool_end", id: update.toolCallId, output, isError });
  }

  async #onPermission(
    proc: AgentProcess,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const turn = proc.turns.get(params.sessionId);
    if (!turn || turn.signal.aborted) return { outcome: { outcome: "cancelled" } };
    const known = turn.tools.get(params.toolCall.toolCallId);
    const tool = params.toolCall.name ?? known?.name ?? params.toolCall.kind ?? "tool";
    const title = params.toolCall.title ?? known?.title ?? tool;
    const input = params.toolCall.rawInput ?? known?.input ?? {};
    const { requestId, decision } = this.#o.broker.request(turn.sessionId, turn.signal);
    turn.events.push({
      type: "permission_request",
      requestId,
      toolCallId: params.toolCall.toolCallId,
      tool,
      title,
      input,
    });
    const d = await decision;
    this.#o.store.logCommand({
      sessionId: turn.sessionId,
      tool,
      input,
      decision: d,
      exitCode: null,
    });
    if (turn.signal.aborted) return { outcome: { outcome: "cancelled" } };
    const optionId = pickOption(params, d);
    return optionId
      ? { outcome: { outcome: "selected", optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  #agentError(error: unknown, proc: AgentProcess): EnvokeError {
    if (error instanceof EnvokeError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown }).code;
    if (code === -32000 || /auth/i.test(message)) {
      return new EnvokeError(
        "auth_required",
        `${this.#o.label} demande une connexion. Liez la clé API attendue, ou autorisez sa connexion d'abonnement dans la politique.`,
        { cause: error },
      );
    }
    return new EnvokeError("agent", `${this.#o.label} : ${message} ${proc.stderr}`.trim(), {
      cause: error,
    });
  }

  #scheduleIdle(): void {
    if (this.#process && this.#process.turns.size > 0) return;
    this.#cancelIdle();
    this.#idleTimer = setTimeout(() => this.#kill(), this.#o.idleMs);
    this.#idleTimer.unref();
  }

  #cancelIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #kill(): void {
    const proc = this.#process;
    this.#process = null;
    if (!proc) return;
    proc.dead = true;
    proc.connection.close();
    proc.child.kill("SIGTERM");
  }
}

/** Never grant more than asked: "allow once" never maps to an "always" option. */
function pickOption(params: RequestPermissionRequest, decision: Decision): string | null {
  const order: Record<Decision, string[]> = {
    allow_once: ["allow_once"],
    allow_always: ["allow_always", "allow_once"],
    deny: ["reject_once", "reject_always"],
  };
  for (const kind of order[decision]) {
    const option = params.options.find((o) => o.kind === kind);
    if (option) return option.optionId;
  }
  return null;
}

function toolOutput(update: ToolCallUpdate): string {
  const pieces: string[] = [];
  for (const c of update.content ?? []) {
    if (c.type === "content" && c.content.type === "text") pieces.push(c.content.text);
    else if (c.type === "diff") pieces.push(`[modification de ${c.path}]`);
    else if (c.type === "terminal") pieces.push(`[terminal ${c.terminalId}]`);
  }
  if (pieces.length === 0 && update.rawOutput !== undefined) {
    pieces.push(
      typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput),
    );
  }
  return truncateMiddle(pieces.join("\n"));
}

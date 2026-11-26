import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { AcpBackend } from "./acp/backend.ts";
import { AcpRegistry, type LaunchSpec } from "./acp/registry.ts";
import { PermissionBroker } from "./agent/permissions.ts";
import { ChatGPTAuth, type ChatGPTModel } from "./auth/chatgpt.ts";
import { NativeBackend } from "./backends/native.ts";
import {
  findConnection,
  findProfile,
  type Config,
  type Connection,
  type Profile,
} from "./config.ts";
import { secretKey, type CredentialStore } from "./credentials.ts";
import { EnvokeError, toEnvokeError } from "./errors.ts";
import { createAnthropicProvider } from "./providers/anthropic.ts";
import { createCompatProvider } from "./providers/openai-compat.ts";
import { createResponsesProvider } from "./providers/openai-responses.ts";
import type { SessionStore } from "./store.ts";
import { ClaudeChat, type HookInput } from "./terminal/chat.ts";
import { ClaudeCode, type ClaudeCommand, type TerminalSize } from "./terminal/claude-code.ts";
import { TerminalHost } from "./terminal/host.ts";
import { defaultTools, type Tool } from "./tools/index.ts";
import type {
  AgentBackend,
  AgentEvent,
  ChatSnapshot,
  ClaudeChatEvent,
  ClaudeCodeStatus,
  ConnectionStatus,
  Decision,
  ModelProvider,
  ProfileInfo,
  SendOptions,
  SessionRecord,
  TerminalEvent,
} from "./types.ts";

export interface RuntimeOptions {
  config: Config;
  dataDir: string;
  credentials: CredentialStore;
  store: SessionStore;
  appName?: string;
  tools?: Tool[];
  fetch?: typeof fetch;
  /** Tests: replace the provider built for a profile. */
  providerOverride?: (profile: Profile) => ModelProvider | undefined;
  /** Tests and custom setups: replace the registry lookup for an ACP connection. */
  acpLaunchOverride?: (connectionId: string) => LaunchSpec | undefined;
  chatgpt?: ChatGPTAuth;
  /** Tests: the program started in place of Claude Code. */
  claudeCommand?: ClaudeCommand;
}

/** Terminal sessions are not tied to a profile: the user's Claude Code signs in by itself. */
export const CLAUDE_CODE_PROFILE = "claude-code";
const CLAUDE_CODE_TITLE = "Claude Code";
/** Size of Claude Code's screen while only the chat view watches it. */
const CHAT_TERMINAL_SIZE = { cols: 120, rows: 40 };

/**
 * Everything the server and the CLI need: connection catalog, linking, backends per profile,
 * sessions and the permission broker. Backends are cached and rebuilt when a link changes.
 */
export class Runtime {
  readonly broker = new PermissionBroker();
  readonly config: Config;
  readonly store: SessionStore;
  readonly chatgpt: ChatGPTAuth;
  readonly registry: AcpRegistry;
  readonly #o: RuntimeOptions;
  readonly #native = new Map<string, NativeBackend>();
  readonly #acp = new Map<string, AcpBackend>();
  readonly #busy = new Set<string>();
  readonly #terminals = new TerminalHost();
  readonly #chat: ClaudeChat;
  readonly #claude: ClaudeCode;

  constructor(options: RuntimeOptions) {
    this.#o = options;
    this.config = options.config;
    this.store = options.store;
    this.chatgpt =
      options.chatgpt ??
      new ChatGPTAuth({
        store: options.credentials,
        appName: options.appName ?? "envoke",
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.#chat = new ClaudeChat(options.store, this.broker, (sessionId, prompt) => {
      // An untitled terminal takes its first request as title, like a chat.
      const session = this.store.getSession(sessionId);
      if (session?.title.startsWith(`${CLAUDE_CODE_TITLE} · `) && prompt.trim()) {
        this.store.updateSession(sessionId, { title: titleFrom(prompt) });
      }
    });
    this.#claude = new ClaudeCode(this.#terminals, this.#chat, options.claudeCommand);
    this.registry = new AcpRegistry({
      url: options.config.acp.registryUrl,
      dataDir: options.dataDir,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  // ── Connections ──────────────────────────────────────────────────────────

  async listConnections(): Promise<ConnectionStatus[]> {
    return Promise.all(this.config.connections.map((c) => this.connectionStatus(c.id)));
  }

  async connectionStatus(connectionId: string): Promise<ConnectionStatus> {
    const c = findConnection(this.config, connectionId);
    const base = {
      id: c.id,
      type: c.type,
      label: c.label ?? c.id,
      account: null,
      requires: [] as string[],
    };
    switch (c.type) {
      case "chatgpt": {
        const { linked, email } = await this.chatgpt.status();
        return {
          ...base,
          access: "subscription",
          allowed: this.#subscriptionAllowed(c.id),
          linked,
          account: email,
        };
      }
      case "openai-compat":
        if (c.auth === "none") return { ...base, access: "none", allowed: true, linked: true };
        return {
          ...base,
          access: "api_key",
          allowed: true,
          linked: (await this.#secret(c.id)) !== null,
        };
      case "acp": {
        const requires = Object.values(c.env);
        if (requires.length === 0) {
          const allowed = this.#subscriptionAllowed(c.id);
          return { ...base, access: "subscription", allowed, linked: allowed, requires };
        }
        const linked = (await Promise.all(requires.map((id) => this.#secret(id)))).every(
          (s) => s !== null,
        );
        return { ...base, access: "api_key", allowed: true, linked, requires };
      }
      default:
        return {
          ...base,
          access: "api_key",
          allowed: true,
          linked: (await this.#secret(c.id)) !== null,
        };
    }
  }

  async linkApiKey(connectionId: string, apiKey: string): Promise<void> {
    const c = findConnection(this.config, connectionId);
    if (
      c.type === "chatgpt" ||
      c.type === "acp" ||
      (c.type === "openai-compat" && c.auth === "none")
    ) {
      throw new EnvokeError("bad_request", `${c.label ?? c.id} ne se lie pas par clé API.`);
    }
    const key = apiKey.trim();
    if (key.length < 8 || /\s/.test(key)) throw new EnvokeError("bad_request", "Clé API invalide.");
    await this.#o.credentials.set(secretKey(c.id), key);
    await this.#invalidate(c.id);
  }

  async beginChatGPTLogin(
    connectionId = "chatgpt",
  ): Promise<{ authorizeUrl: string; completion: Promise<{ email: string | null }> }> {
    const c = findConnection(this.config, connectionId);
    if (c.type !== "chatgpt")
      throw new EnvokeError("bad_request", `${connectionId} n'est pas un compte ChatGPT.`);
    this.#assertSubscription(c);
    const login = await this.chatgpt.beginLogin();
    return { ...login, completion: login.completion.finally(() => this.#invalidate(c.id)) };
  }

  async agentAuthMethods(
    connectionId: string,
  ): Promise<{ id: string; name: string; description: string | null; terminal: boolean }[]> {
    const backend = this.#acpBackend(this.#acpConnection(connectionId));
    return (await backend.authMethods()).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? null,
      terminal: "type" in m && m.type === "terminal",
    }));
  }

  /** An ACP agent's own sign-in: only when the policy allows its subscription login. */
  async agentAuthenticate(connectionId: string, methodId: string) {
    const c = this.#acpConnection(connectionId);
    if (methodId !== c.authMethod) this.#assertSubscription(c);
    return this.#acpBackend(c).authenticate(methodId);
  }

  async unlink(connectionId: string): Promise<{ revoked: boolean }> {
    const c = findConnection(this.config, connectionId);
    let revoked = true;
    if (c.type === "chatgpt") ({ revoked } = await this.chatgpt.logout());
    else await this.#o.credentials.delete(secretKey(c.id));
    await this.#invalidate(c.id);
    return { revoked };
  }

  async listModels(connectionId: string): Promise<ChatGPTModel[]> {
    const c = findConnection(this.config, connectionId);
    if (c.type !== "chatgpt")
      throw new EnvokeError(
        "bad_request",
        "La liste des modèles n'est proposée que pour le compte ChatGPT.",
      );
    this.#assertSubscription(c);
    return this.chatgpt.listModels();
  }

  // ── Profiles and sessions ────────────────────────────────────────────────

  async listProfiles(): Promise<ProfileInfo[]> {
    return Promise.all(
      this.config.profiles.map(async (p) => {
        const status = await this.connectionStatus(p.connection);
        return {
          id: p.id,
          label: p.label ?? p.id,
          connection: p.connection,
          model: p.model ?? null,
          available: status.allowed && status.linked,
          engine: status.type === "acp" ? "acp" : "native",
          effort: p.effort ?? null,
        };
      }),
    );
  }

  async createSession(input: {
    profileId?: string;
    cwd: string;
    title?: string;
  }): Promise<SessionRecord> {
    const profile = findProfile(this.config, input.profileId ?? this.config.defaultProfile);
    const cwd = await existingDir(input.cwd);
    return this.store.createSession({
      id: randomUUID(),
      profileId: profile.id,
      cwd,
      ...(input.title ? { title: input.title } : {}),
    });
  }

  /** Switching profile keeps the history; a native backend replays it to the new model. */
  setSessionProfile(sessionId: string, profileId: string): void {
    findProfile(this.config, profileId);
    if (this.#session(sessionId).kind === "terminal") {
      throw new EnvokeError("bad_request", "Une session Claude Code ne change pas de profil.");
    }
    this.store.updateSession(sessionId, { profileId, backendSessionId: null });
  }

  deleteSession(sessionId: string): void {
    this.broker.forgetSession(sessionId);
    this.#claude.forget(sessionId);
    this.store.deleteSession(sessionId);
  }

  // ── Claude Code in a terminal ────────────────────────────────────────────

  claudeCode(): Promise<ClaudeCodeStatus> {
    return this.#claude.status();
  }

  /** A new terminal session; Claude Code starts once the first viewer attaches. */
  async openTerminal(input: { cwd: string; prompt?: string }): Promise<SessionRecord> {
    if (!(await this.#claude.status()).installed) {
      throw new EnvokeError("bad_request", "Claude Code n'est pas installé sur cet ordinateur.");
    }
    const cwd = await existingDir(input.cwd);
    const prompt = input.prompt?.trim() || null;
    const session = this.store.createSession({
      id: randomUUID(),
      kind: "terminal",
      profileId: CLAUDE_CODE_PROFILE,
      cwd,
      title: prompt ? titleFrom(prompt) : `${CLAUDE_CODE_TITLE} · ${path.basename(cwd)}`,
    });
    this.#claude.prepare(session.id, prompt);
    return session;
  }

  /** Streams the terminal: a snapshot of the screen, then everything it prints. */
  async attachTerminal(
    sessionId: string,
    size: TerminalSize,
    listener: (event: TerminalEvent) => void,
  ): Promise<() => void> {
    const session = this.#terminal(sessionId);
    await this.#claude.startIfFresh(sessionId, session.cwd, size);
    if (this.#terminals.running(sessionId)) this.#terminals.resize(sessionId, size.cols, size.rows);
    return this.#terminals.attach(sessionId, listener);
  }

  /** Claude Code's hooks post here (see `ClaudeChat`); the local server gives its address. */
  enableClaudeHooks(baseUrl: string): void {
    this.#claude.setHookBase(baseUrl);
  }

  claudeHookAllowed(sessionId: string, token: string): boolean {
    return this.#chat.checkToken(sessionId, token);
  }

  claudeHook(sessionId: string, input: HookInput, signal: AbortSignal): Promise<object | null> {
    return this.#chat.handle(sessionId, input, signal);
  }

  /** The chat view of a Claude Code session: a snapshot, then live events. Starts a new session. */
  async watchClaudeChat(
    sessionId: string,
    listener: (event: ClaudeChatEvent | ChatSnapshot) => void,
  ): Promise<() => void> {
    const session = this.#terminal(sessionId);
    await this.#claude.startIfFresh(sessionId, session.cwd, CHAT_TERMINAL_SIZE);
    return this.#chat.subscribe(sessionId, this.#terminals.running(sessionId), listener);
  }

  /** Types a message into Claude Code and submits it, as the user would in the terminal. */
  async sendToClaude(sessionId: string, text: string): Promise<void> {
    this.#terminal(sessionId);
    if (!this.#terminals.running(sessionId)) {
      throw new EnvokeError("bad_request", "Claude Code est arrêté : reprenez la session.");
    }
    // Bracketed paste keeps line breaks inside the message; Enter then submits it.
    this.#terminals.write(sessionId, `\x1b[200~${text}\x1b[201~`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.#terminals.write(sessionId, "\r");
  }

  /** Escape: Claude Code stops what it is doing. */
  interruptClaude(sessionId: string): void {
    this.#terminal(sessionId);
    this.#terminals.write(sessionId, "\x1b");
  }

  terminalInput(sessionId: string, data: string): void {
    this.#terminal(sessionId);
    this.#terminals.write(sessionId, data);
  }

  resizeTerminal(sessionId: string, size: TerminalSize): void {
    this.#terminal(sessionId);
    this.#terminals.resize(sessionId, size.cols, size.rows);
  }

  stopTerminal(sessionId: string): void {
    this.#terminal(sessionId);
    this.#terminals.stop(sessionId);
  }

  async resumeTerminal(sessionId: string, size: TerminalSize): Promise<void> {
    const session = this.#terminal(sessionId);
    await this.#claude.resume(sessionId, session.cwd, size);
    this.store.updateSession(sessionId, {});
  }

  /** Streams one turn. Never throws: failures become an `error` event. */
  send(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    options: SendOptions = {},
  ): AsyncGenerator<AgentEvent> {
    return this.#turn(sessionId, signal, options, () => text);
  }

  /**
   * Replays the last user message after dropping the answer to it. Native profiles only: an ACP
   * agent keeps its own history, which the protocol cannot rewind.
   */
  regenerate(
    sessionId: string,
    signal: AbortSignal,
    options: SendOptions = {},
  ): AsyncGenerator<AgentEvent> {
    return this.#turn(sessionId, signal, options, (session) => {
      const profile = findProfile(this.config, session.profileId);
      if (findConnection(this.config, profile.connection).type === "acp") {
        throw new EnvokeError("bad_request", "Régénérer n'est pas disponible avec un agent.");
      }
      const messages = this.store.loadMessages(sessionId);
      const last = messages.findLastIndex((m) => m.role === "user");
      if (last === -1) throw new EnvokeError("bad_request", "Aucun message à régénérer.");
      const text = messages[last]!.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
      this.store.truncateMessages(sessionId, last);
      return text;
    });
  }

  /**
   * One turn per session at a time. `prepare` runs once the backend is ready, so a failure to
   * build it (missing key, policy) leaves the history untouched.
   */
  async *#turn(
    sessionId: string,
    signal: AbortSignal,
    options: SendOptions,
    prepare: (session: SessionRecord) => string,
  ): AsyncGenerator<AgentEvent> {
    if (this.#busy.has(sessionId)) {
      yield {
        type: "error",
        code: "bad_request",
        message: "Un tour est déjà en cours dans cette session.",
      };
      return;
    }
    this.#busy.add(sessionId);
    try {
      const session = this.#session(sessionId);
      if (session.kind === "terminal") {
        throw new EnvokeError("bad_request", "Cette session est un terminal Claude Code.");
      }
      const backend = await this.#backendFor(findProfile(this.config, session.profileId));
      const text = prepare(session);
      if (!session.title) this.store.updateSession(sessionId, { title: titleFrom(text) });
      yield* backend.send(sessionId, text, signal, options);
    } catch (error) {
      const e = toEnvokeError(error);
      yield e.code === "aborted"
        ? { type: "turn_done", stopReason: "aborted" }
        : { type: "error", code: e.code, message: e.message };
    } finally {
      this.#busy.delete(sessionId);
    }
  }

  resolvePermission(requestId: string, decision: Decision): boolean {
    return this.broker.resolve(requestId, decision);
  }

  async dispose(): Promise<void> {
    this.#terminals.disposeAll();
    await Promise.all([...this.#acp.values()].map((b) => b.dispose()));
    this.#acp.clear();
    this.#native.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #session(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId);
    if (!session) throw new EnvokeError("not_found", `Session inconnue : ${sessionId}`);
    return session;
  }

  #terminal(sessionId: string): SessionRecord {
    const session = this.#session(sessionId);
    if (session.kind !== "terminal") {
      throw new EnvokeError("bad_request", "Cette session n'est pas un terminal.");
    }
    return session;
  }

  async #backendFor(profile: Profile): Promise<AgentBackend> {
    const c = findConnection(this.config, profile.connection);
    if (c.type === "acp") return this.#acpBackend(c);
    let backend = this.#native.get(profile.id);
    if (!backend) {
      const provider = this.#o.providerOverride?.(profile) ?? (await this.#provider(profile, c));
      backend = new NativeBackend({
        provider,
        model: () => this.#model(profile, c),
        tools: this.#o.tools ?? defaultTools,
        store: this.store,
        broker: this.broker,
      });
      this.#native.set(profile.id, backend);
    }
    return backend;
  }

  async #provider(
    profile: Profile,
    c: Exclude<Connection, { type: "acp" }>,
  ): Promise<ModelProvider> {
    const effort = profile.effort ? { effort: profile.effort } : {};
    switch (c.type) {
      case "anthropic":
        return createAnthropicProvider({
          apiKey: await this.#requireSecret(c),
          ...(c.baseURL ? { baseURL: c.baseURL } : {}),
          ...effort,
          showThinking: profile.showThinking,
          fallbacks: profile.fallbacks,
        });
      case "openai": {
        const apiKey = await this.#requireSecret(c);
        return createResponsesProvider({
          mode: "api_key",
          getToken: async () => apiKey,
          ...(c.baseURL ? { baseURL: c.baseURL } : {}),
          ...effort,
          showThinking: profile.showThinking,
        });
      }
      case "chatgpt":
        this.#assertSubscription(c);
        return createResponsesProvider({
          mode: "chatgpt",
          getToken: () => this.chatgpt.getAccessToken(),
          ...effort,
          showThinking: profile.showThinking,
        });
      case "openai-compat":
        return createCompatProvider({
          baseURL: c.baseURL,
          apiKey: c.auth === "none" ? null : await this.#requireSecret(c),
          name: c.label ?? c.id,
        });
    }
  }

  async #model(profile: Profile, c: Connection): Promise<string> {
    if (profile.model) return profile.model;
    if (c.type === "chatgpt") {
      const [first] = await this.chatgpt.listModels();
      if (first) return first.slug;
    }
    throw new EnvokeError("config", `Aucun modèle défini pour le profil ${profile.id}.`);
  }

  #acpConnection(connectionId: string): Extract<Connection, { type: "acp" }> {
    const c = findConnection(this.config, connectionId);
    if (c.type !== "acp")
      throw new EnvokeError("bad_request", `${connectionId} n'est pas un agent ACP.`);
    return c;
  }

  #acpBackend(c: Extract<Connection, { type: "acp" }>): AcpBackend {
    let backend = this.#acp.get(c.id);
    if (backend) return backend;
    const label = c.label ?? c.id;
    backend = new AcpBackend({
      connectionId: c.id,
      label,
      launch: async () => {
        const override = this.#o.acpLaunchOverride?.(c.id);
        if (override) return override;
        if (c.command) return { command: c.command.path, args: c.command.args };
        return this.registry.install(await this.registry.get(c.agent));
      },
      env: () => this.#agentEnv(c),
      ...(c.authMethod ? { authMethod: c.authMethod } : {}),
      store: this.store,
      broker: this.broker,
      idleMs: this.config.acp.idleMinutes * 60_000,
    });
    this.#acp.set(c.id, backend);
    return backend;
  }

  /** Keys the agent needs, and its config dir sandboxed unless its subscription login is allowed. */
  async #agentEnv(c: Extract<Connection, { type: "acp" }>): Promise<Record<string, string>> {
    const sources = Object.entries(c.env);
    const subscription = this.#subscriptionAllowed(c.id);
    if (sources.length === 0 && !subscription) {
      throw new EnvokeError(
        "policy",
        `${c.label ?? c.id} ne propose pas d'accès par clé API, et sa connexion d'abonnement n'est pas autorisée.`,
      );
    }
    const env: Record<string, string> = {};
    for (const [variable, source] of sources) {
      const value = await this.#secret(source);
      if (value === null) {
        const label = findConnection(this.config, source).label ?? source;
        throw new EnvokeError(
          "auth_required",
          `${c.label ?? c.id} a besoin de la connexion « ${label} » : liez d'abord sa clé API.`,
        );
      }
      env[variable] = value;
    }
    if (c.configDirEnv && !subscription) {
      const dir = path.join(this.#o.dataDir, "acp", "home", c.id);
      await mkdir(dir, { recursive: true });
      env[c.configDirEnv] = dir;
    }
    return env;
  }

  #subscriptionAllowed(connectionId: string): boolean {
    return this.config.policy.subscriptionLogins.includes(connectionId);
  }

  #assertSubscription(c: Connection): void {
    if (!this.#subscriptionAllowed(c.id)) {
      throw new EnvokeError(
        "policy",
        `La connexion par abonnement « ${c.label ?? c.id} » n'est pas autorisée dans ce produit.`,
      );
    }
  }

  /** Keychain first; `<ID>_API_KEY` in the environment as a development fallback. */
  async #secret(connectionId: string): Promise<string | null> {
    const stored = await this.#o.credentials.get(secretKey(connectionId));
    if (stored) return stored;
    return process.env[`${connectionId.toUpperCase().replace(/-/g, "_")}_API_KEY`] ?? null;
  }

  async #requireSecret(c: Connection): Promise<string> {
    const value = await this.#secret(c.id);
    if (value === null)
      throw new EnvokeError("auth_required", `Liez d'abord la clé API de « ${c.label ?? c.id} ».`);
    return value;
  }

  /** Drops cached backends that depend on this connection (a key changed, an account signed out). */
  async #invalidate(connectionId: string): Promise<void> {
    for (const p of this.config.profiles) {
      if (p.connection === connectionId) this.#native.delete(p.id);
    }
    for (const c of this.config.connections) {
      if (
        c.type === "acp" &&
        (c.id === connectionId || Object.values(c.env).includes(connectionId))
      ) {
        await this.#acp.get(c.id)?.dispose();
        this.#acp.delete(c.id);
      }
    }
  }
}

async function existingDir(dir: string): Promise<string> {
  const cwd = path.resolve(dir);
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) {
    throw new EnvokeError("bad_request", `Dossier de travail introuvable : ${cwd}`);
  }
  return cwd;
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

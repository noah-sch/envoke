import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  EnvokeError,
  type AgentEvent,
  type ChatSnapshot,
  type ClaudeChatEvent,
  type ErrorCode,
  type HookInput,
  type Runtime,
  type TerminalEvent,
} from "@envoke/core";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

export interface AppOptions {
  runtime: Runtime;
  /** Random secret required on every request (Authorization: Bearer …). */
  token: string;
  port: number;
  /** Origins allowed to call the API (the desktop shell's). Requests without Origin are allowed. */
  allowedOrigins?: string[];
  /** Built interface (packages/web/dist), served at / without the token. */
  webDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** The interface renders model output: no inline script, no foreign host, no framing. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const STATUS: Partial<Record<ErrorCode, 400 | 403 | 404 | 409 | 500 | 502>> = {
  bad_request: 400,
  not_found: 404,
  policy: 403,
  auth: 409,
  auth_required: 409,
  network: 502,
  config: 500,
};

const LinkBody = z.union([
  z.object({ apiKey: z.string().min(1) }),
  z.object({ methodId: z.string().min(1) }),
  z.object({}).strict(),
]);
const SessionBody = z.object({
  cwd: z.string().min(1),
  profileId: z.string().optional(),
  title: z.string().optional(),
});
const PatchBody = z.object({ title: z.string().optional(), profileId: z.string().optional() });
const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const MessageBody = z.object({ text: z.string().min(1), effort: Effort.optional() });
const RegenerateBody = z.object({ effort: Effort.optional() });
const DecisionBody = z.object({ decision: z.enum(["allow_once", "allow_always", "deny"]) });
const TerminalBody = z.object({
  cwd: z.string().min(1),
  prompt: z.string().max(100_000).optional(),
});
const Size = z.object({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
});
/** Keystrokes, or a paste. */
const InputBody = z.object({ data: z.string().min(1).max(1_000_000) });
const PromptBody = z.object({ text: z.string().trim().min(1).max(100_000) });

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const raw: unknown = await c.req.json().catch(() => {
    throw new EnvokeError("bad_request", "Corps JSON attendu.");
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new EnvokeError("bad_request", z.prettifyError(parsed.error));
  return parsed.data;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Local API consumed by the chat interface. Listens on 127.0.0.1 only (see main.ts); every
 * request needs the token, and Host/Origin are checked so a web page cannot drive the agent.
 */
export function createApp(options: AppOptions): Hono {
  const { runtime } = options;
  const hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const origins = new Set(
    options.allowedOrigins ?? [
      `http://127.0.0.1:${options.port}`,
      `http://localhost:${options.port}`,
    ],
  );
  const running = new Map<string, AbortController>();
  runtime.enableClaudeHooks(`http://127.0.0.1:${options.port}`);
  const logins = new Map<string, { state: "pending" | "linked" | "error"; error: string | null }>();
  const app = new Hono();

  app.use("*", async (c, next) => {
    // DNS rebinding: a foreign domain resolving to 127.0.0.1 still carries its own Host.
    if (!hosts.has(new URL(c.req.url).host))
      return c.json({ error: { code: "forbidden", message: "Hôte refusé." } }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.has(origin)) {
      return c.json({ error: { code: "forbidden", message: "Origine refusée." } }, 403);
    }
    // The interface's own files carry no data; the token arrives in the URL fragment.
    if (!c.req.path.startsWith("/api/")) return next();
    // Claude Code's hooks carry their session's own token, checked by the route.
    if (c.req.path.startsWith("/api/hooks/")) return next();
    const auth = c.req.header("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), options.token)) {
      return c.json(
        { error: { code: "unauthorized", message: "Jeton manquant ou invalide." } },
        401,
      );
    }
    await next();
  });

  app.onError((error, c) => {
    const e = error instanceof EnvokeError ? error : new EnvokeError("server", "Erreur interne.");
    return c.json({ error: { code: e.code, message: e.message } }, STATUS[e.code] ?? 500);
  });

  /** Streams a turn as SSE. Closing the request cancels the turn and its running command. */
  const streamTurn = (
    c: Context,
    sessionId: string,
    run: (signal: AbortSignal) => AsyncIterable<AgentEvent>,
  ) => {
    if (!runtime.store.getSession(sessionId))
      throw new EnvokeError("not_found", "Session inconnue.");
    if (running.has(sessionId)) {
      throw new EnvokeError("bad_request", "Un tour est déjà en cours dans cette session.");
    }
    const controller = new AbortController();
    running.set(sessionId, controller);
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => controller.abort());
      try {
        for await (const event of run(controller.signal)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
      } finally {
        running.delete(sessionId);
      }
    });
  };

  app.get("/api/info", (c) => c.json({ version: "0.1.0", home: homedir() }));

  // ── Connections ──
  app.get("/api/connections", async (c) => c.json(await runtime.listConnections()));

  app.get("/api/connections/:id", async (c) => {
    const id = c.req.param("id");
    return c.json({ ...(await runtime.connectionStatus(id)), login: logins.get(id) ?? null });
  });

  app.post("/api/connections/:id/link", async (c) => {
    const id = c.req.param("id");
    const input = await body(c, LinkBody);
    const status = await runtime.connectionStatus(id);
    if ("apiKey" in input) {
      await runtime.linkApiKey(id, input.apiKey);
      return c.json(await runtime.connectionStatus(id));
    }
    if ("methodId" in input) return c.json(await runtime.agentAuthenticate(id, input.methodId));
    if (status.type === "chatgpt") {
      const { authorizeUrl, completion } = await runtime.beginChatGPTLogin(id);
      logins.set(id, { state: "pending", error: null });
      completion.then(
        () => logins.set(id, { state: "linked", error: null }),
        (error: unknown) =>
          logins.set(id, {
            state: "error",
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      // The interface opens this URL in the system browser, then polls GET /api/connections/:id.
      return c.json({ authorizeUrl });
    }
    if (status.type === "acp") return c.json({ authMethods: await runtime.agentAuthMethods(id) });
    throw new EnvokeError("bad_request", "Clé API attendue : { apiKey }.");
  });

  app.delete("/api/connections/:id", async (c) => c.json(await runtime.unlink(c.req.param("id"))));

  app.get("/api/connections/:id/models", async (c) =>
    c.json(await runtime.listModels(c.req.param("id"))),
  );

  // ── Profiles and sessions ──
  app.get("/api/profiles", async (c) =>
    c.json({
      defaultProfile: runtime.config.defaultProfile,
      profiles: await runtime.listProfiles(),
    }),
  );

  app.get("/api/sessions", (c) => c.json(runtime.store.listSessions()));

  app.post("/api/sessions", async (c) => {
    const input = await body(c, SessionBody);
    const session = await runtime.createSession({
      cwd: input.cwd,
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.title ? { title: input.title } : {}),
    });
    return c.json(session, 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = runtime.store.getSession(id);
    if (!session) throw new EnvokeError("not_found", "Session inconnue.");
    // Provider payloads (thinking signatures, encrypted reasoning) stay server-side.
    const messages = runtime.store.loadMessages(id).map(({ role, parts }) => ({ role, parts }));
    return c.json({ session, messages, running: running.has(id) });
  });

  app.patch("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const input = await body(c, PatchBody);
    if (!runtime.store.getSession(id)) throw new EnvokeError("not_found", "Session inconnue.");
    if (input.profileId) runtime.setSessionProfile(id, input.profileId);
    if (input.title !== undefined) runtime.store.updateSession(id, { title: input.title });
    return c.json(runtime.store.getSession(id));
  });

  app.delete("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    running.get(id)?.abort();
    runtime.deleteSession(id);
    return c.body(null, 204);
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const { text, effort } = await body(c, MessageBody);
    return streamTurn(c, id, (signal) => runtime.send(id, text, signal, effort ? { effort } : {}));
  });

  app.post("/api/sessions/:id/regenerate", async (c) => {
    const id = c.req.param("id");
    const { effort } = await body(c, RegenerateBody);
    return streamTurn(c, id, (signal) => runtime.regenerate(id, signal, effort ? { effort } : {}));
  });

  app.post("/api/sessions/:id/abort", (c) => {
    const controller = running.get(c.req.param("id"));
    if (!controller) throw new EnvokeError("not_found", "Aucun tour en cours.");
    controller.abort();
    return c.body(null, 204);
  });

  app.post("/api/permissions/:requestId", async (c) => {
    const { decision } = await body(c, DecisionBody);
    if (!runtime.resolvePermission(c.req.param("requestId"), decision)) {
      throw new EnvokeError("not_found", "Demande de permission inconnue ou déjà traitée.");
    }
    return c.body(null, 204);
  });

  // ── Claude Code in a terminal (the user's own install and sign-in) ──
  app.get("/api/claude-code", async (c) => c.json(await runtime.claudeCode()));

  app.post("/api/terminals", async (c) => {
    const { cwd, prompt } = await body(c, TerminalBody);
    return c.json(await runtime.openTerminal({ cwd, ...(prompt ? { prompt } : {}) }), 201);
  });

  /** The screen so far, then everything the terminal prints, until the viewer leaves. */
  app.get("/api/terminals/:id/stream", async (c) => {
    const id = c.req.param("id");
    const size = Size.safeParse({
      cols: Number(c.req.query("cols")),
      rows: Number(c.req.query("rows")),
    });
    if (!size.success)
      throw new EnvokeError("bad_request", "Taille du terminal attendue : cols, rows.");
    // Attach before answering, so a missing session still gets a JSON error.
    const early: TerminalEvent[] = [];
    let send: ((event: TerminalEvent) => void) | null = null;
    const detach = await runtime.attachTerminal(id, size.data, (event) =>
      send ? send(event) : early.push(event),
    );
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      send = (event) => {
        chain = chain
          .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
          .catch(() => {});
      };
      early.splice(0).forEach(send);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      detach();
    });
  });

  /** Claude Code's chat view: the conversation so far, then live events. */
  app.get("/api/terminals/:id/chat", async (c) => {
    const early: (ClaudeChatEvent | ChatSnapshot)[] = [];
    let send: ((event: ClaudeChatEvent | ChatSnapshot) => void) | null = null;
    const detach = await runtime.watchClaudeChat(c.req.param("id"), (event) =>
      send ? send(event) : early.push(event),
    );
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      send = (event) => {
        chain = chain
          .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
          .catch(() => {});
      };
      early.splice(0).forEach(send);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      detach();
    });
  });

  app.post("/api/terminals/:id/prompt", async (c) => {
    const { text } = await body(c, PromptBody);
    await runtime.sendToClaude(c.req.param("id"), text);
    return c.body(null, 204);
  });

  app.post("/api/terminals/:id/interrupt", (c) => {
    runtime.interruptClaude(c.req.param("id"));
    return c.body(null, 204);
  });

  /**
   * Claude Code's HTTP hooks (`--settings` given at launch). A permission question keeps the
   * request open until the user answers; Claude Code closing it means it was answered elsewhere.
   */
  app.post("/api/hooks/:id", async (c) => {
    const id = c.req.param("id");
    const auth = c.req.header("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !runtime.claudeHookAllowed(id, auth.slice(7))) {
      return c.json({ error: { code: "unauthorized", message: "Jeton de hook invalide." } }, 401);
    }
    const input: unknown = await c.req.json().catch(() => null);
    if (!input || typeof input !== "object") {
      throw new EnvokeError("bad_request", "Corps JSON attendu.");
    }
    const answer = await runtime.claudeHook(id, input as HookInput, c.req.raw.signal);
    return answer ? c.json(answer) : c.body(null, 200);
  });

  app.post("/api/terminals/:id/input", async (c) => {
    const { data } = await body(c, InputBody);
    runtime.terminalInput(c.req.param("id"), data);
    return c.body(null, 204);
  });

  app.post("/api/terminals/:id/resize", async (c) => {
    runtime.resizeTerminal(c.req.param("id"), await body(c, Size));
    return c.body(null, 204);
  });

  app.post("/api/terminals/:id/stop", (c) => {
    runtime.stopTerminal(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/api/terminals/:id/resume", async (c) => {
    await runtime.resumeTerminal(c.req.param("id"), await body(c, Size));
    return c.body(null, 204);
  });

  if (options.webDir) {
    const root = path.resolve(options.webDir);
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) throw new EnvokeError("not_found", "Route inconnue.");
      const target = path.resolve(root, `.${decodeURIComponent(c.req.path)}`);
      const inside = target === root || target.startsWith(`${root}${path.sep}`);
      const isAsset = inside && path.extname(target) !== "";
      // Unknown paths without an extension are interface routes: serve the app.
      const file = isAsset ? target : path.join(root, "index.html");
      const content = await readFile(file).catch(() => null);
      if (!content) return c.text("Introuvable", 404);
      const hashed = file.includes(`${path.sep}assets${path.sep}`);
      return c.body(content, 200, {
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
    });
  }

  return app;
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { EnvokeError } from "./errors.ts";
import type { Effort } from "./types.ts";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "identifiant : minuscules, chiffres, - et _");

const ConnectionSchema = z.discriminatedUnion("type", [
  z.object({
    id,
    type: z.literal("anthropic"),
    label: z.string().optional(),
    baseURL: z.url().optional(),
  }),
  z.object({
    id,
    type: z.literal("openai"),
    label: z.string().optional(),
    baseURL: z.url().optional(),
  }),
  z.object({ id, type: z.literal("chatgpt"), label: z.string().optional() }),
  z.object({
    id,
    type: z.literal("openai-compat"),
    label: z.string().optional(),
    baseURL: z.url(),
    auth: z.enum(["api_key", "none"]).default("api_key"),
  }),
  z.object({
    id,
    type: z.literal("acp"),
    label: z.string().optional(),
    /** Agent id in the ACP registry. */
    agent: z.string(),
    /** Local command instead of the registry (development, custom agents). */
    command: z.object({ path: z.string(), args: z.array(z.string()).default([]) }).optional(),
    /** Environment variable -> id of the connection whose API key is injected. */
    env: z.record(z.string(), id).default({}),
    /** Agent auth method that reads the injected API key; always allowed. */
    authMethod: z.string().optional(),
    /**
     * Variable naming the agent's own config directory. Unless its subscription login is allowed,
     * it points to an app-owned directory, so a personal login on this machine is never used.
     */
    configDirEnv: z.string().optional(),
  }),
]);

const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]) satisfies z.ZodType<Effort>;

const ProfileSchema = z.object({
  id,
  label: z.string().optional(),
  connection: id,
  /** Required for native connections, except chatgpt (first listed model by default). */
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  showThinking: z.boolean().default(false),
  /** Anthropic: re-run a refused request on a fallback model (server side). */
  fallbacks: z.boolean().default(false),
});

const ConfigSchema = z.object({
  policy: z
    .object({
      /**
       * Connections allowed to sign in with a consumer subscription: the ChatGPT account, or an ACP
       * agent's own login. Empty by default for a commercial product.
       */
      subscriptionLogins: z.array(id).default([]),
    })
    .default({ subscriptionLogins: [] }),
  connections: z.array(ConnectionSchema),
  profiles: z.array(ProfileSchema),
  defaultProfile: id,
  acp: z
    .object({
      registryUrl: z
        .url()
        .default("https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"),
      idleMinutes: z.number().positive().default(10),
    })
    .default({
      registryUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
      idleMinutes: 10,
    }),
});

export type Connection = z.infer<typeof ConnectionSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Config = z.infer<typeof ConfigSchema>;

/** Catalog shipped with the product. The user's config.json replaces it entirely. */
export const DEFAULT_CONFIG: z.input<typeof ConfigSchema> = {
  policy: { subscriptionLogins: [] },
  connections: [
    { id: "anthropic", type: "anthropic", label: "Anthropic (clé API)" },
    { id: "openai", type: "openai", label: "OpenAI (clé API)" },
    {
      id: "gemini-api",
      type: "openai-compat",
      label: "Google Gemini (clé API)",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    },
    {
      id: "mistral",
      type: "openai-compat",
      label: "Mistral (clé API)",
      baseURL: "https://api.mistral.ai/v1",
    },
    {
      id: "openrouter",
      type: "openai-compat",
      label: "OpenRouter (clé API)",
      baseURL: "https://openrouter.ai/api/v1",
    },
    {
      id: "ollama",
      type: "openai-compat",
      label: "Ollama (local)",
      baseURL: "http://127.0.0.1:11434/v1",
      auth: "none",
    },
    { id: "chatgpt", type: "chatgpt", label: "Compte ChatGPT" },
    {
      id: "claude-agent",
      type: "acp",
      label: "Claude Agent",
      agent: "claude-acp",
      env: { ANTHROPIC_API_KEY: "anthropic" },
      configDirEnv: "CLAUDE_CONFIG_DIR",
    },
    {
      id: "codex",
      type: "acp",
      label: "Codex",
      agent: "codex-acp",
      env: { OPENAI_API_KEY: "openai" },
      configDirEnv: "CODEX_HOME",
    },
    {
      id: "gemini-cli",
      type: "acp",
      label: "Gemini CLI",
      agent: "gemini",
      env: { GEMINI_API_KEY: "gemini-api" },
      authMethod: "gemini-api-key",
    },
    { id: "copilot", type: "acp", label: "GitHub Copilot", agent: "github-copilot-cli" },
  ],
  profiles: [
    {
      id: "claude",
      label: "Claude Opus 5.5",
      connection: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
      showThinking: true,
      fallbacks: true,
    },
    { id: "chatgpt", label: "ChatGPT", connection: "chatgpt", effort: "medium" },
    { id: "claude-agent", label: "Claude Agent", connection: "claude-agent" },
    { id: "codex", label: "Codex", connection: "codex" },
    { id: "gemini-cli", label: "Gemini CLI", connection: "gemini-cli" },
    { id: "copilot", label: "GitHub Copilot", connection: "copilot" },
  ],
  defaultProfile: "claude",
};

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvokeError("config", `Configuration invalide :\n${z.prettifyError(result.error)}`);
  }
  const config = result.data;
  const connectionIds = new Set<string>();
  for (const c of config.connections) {
    if (connectionIds.has(c.id)) throw new EnvokeError("config", `Connexion en double : ${c.id}`);
    connectionIds.add(c.id);
  }
  for (const c of config.connections) {
    if (c.type !== "acp") continue;
    for (const [variable, source] of Object.entries(c.env)) {
      if (!connectionIds.has(source)) {
        throw new EnvokeError(
          "config",
          `${c.id}.env.${variable} référence une connexion inconnue : ${source}`,
        );
      }
    }
  }
  const profileIds = new Set<string>();
  for (const p of config.profiles) {
    if (profileIds.has(p.id)) throw new EnvokeError("config", `Profil en double : ${p.id}`);
    profileIds.add(p.id);
    const connection = config.connections.find((c) => c.id === p.connection);
    if (!connection)
      throw new EnvokeError(
        "config",
        `Le profil ${p.id} référence une connexion inconnue : ${p.connection}`,
      );
    const needsModel = connection.type !== "acp" && connection.type !== "chatgpt";
    if (needsModel && !p.model)
      throw new EnvokeError("config", `Le profil ${p.id} doit préciser un modèle`);
  }
  if (!profileIds.has(config.defaultProfile)) {
    throw new EnvokeError("config", `Profil par défaut inconnu : ${config.defaultProfile}`);
  }
  return config;
}

export function defaultDataDir(): string {
  if (process.env.ENVOKE_DATA_DIR) return path.resolve(process.env.ENVOKE_DATA_DIR);
  if (process.platform === "darwin")
    return path.join(homedir(), "Library", "Application Support", "envoke");
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(xdg ? path.resolve(xdg) : path.join(homedir(), ".local", "share"), "envoke");
}

/** Loads <dataDir>/config.json, or the shipped defaults when the file does not exist. */
export async function loadConfig(dataDir: string): Promise<Config> {
  const file = path.join(dataDir, "config.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig(DEFAULT_CONFIG);
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new EnvokeError("config", `${file} n'est pas un JSON valide`, { cause: error });
  }
  return parseConfig(raw);
}

export function findProfile(config: Config, profileId: string): Profile {
  const profile = config.profiles.find((p) => p.id === profileId);
  if (!profile) throw new EnvokeError("not_found", `Profil inconnu : ${profileId}`);
  return profile;
}

export function findConnection(config: Config, connectionId: string): Connection {
  const connection = config.connections.find((c) => c.id === connectionId);
  if (!connection) throw new EnvokeError("not_found", `Connexion inconnue : ${connectionId}`);
  return connection;
}

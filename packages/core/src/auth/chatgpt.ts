import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { CredentialStore } from "../credentials.ts";
import { EnvokeError } from "../errors.ts";

/**
 * "Sign in with ChatGPT" for local apps: OAuth authorization code + PKCE on a 127.0.0.1 loopback,
 * dynamic client registration on first sign-in, rotating refresh tokens.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */

const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_PATH = "/auth/callback";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 60_000;

const RECORD_KEY = "chatgpt:record";
const HOST_ID_KEY = "chatgpt:host-id";

export interface ChatGPTRecord {
  email: string | null;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number;
  scopes: string[];
  saved_at: string;
}

export interface ChatGPTAuthOptions {
  store: CredentialStore;
  /** Shown on the consent page (agent_name_hint); keep it identical across sign-ins. */
  appName: string;
  authBase?: string;
  apiBase?: string;
  /** Loopback ports tried in order. */
  ports?: number[];
  fetch?: typeof fetch;
  now?: () => number;
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
}

export interface ChatGPTModel {
  slug: string;
  displayName: string;
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");

export class ChatGPTAuth {
  readonly #o: Required<Omit<ChatGPTAuthOptions, "store">> & { store: CredentialStore };
  #refreshing: Promise<ChatGPTRecord> | null = null;
  #discovery: Promise<Discovery> | null = null;

  constructor(options: ChatGPTAuthOptions) {
    this.#o = {
      authBase: "https://auth.openai.com",
      apiBase: RESOURCE,
      ports: [1455, 1456, 1457, 1458, 1459],
      fetch: globalThis.fetch,
      now: Date.now,
      ...options,
    };
  }

  async status(): Promise<{ linked: boolean; email: string | null }> {
    const record = await this.#load();
    return { linked: record !== null, email: record?.email ?? null };
  }

  /**
   * Starts the loopback listener and returns the URL to open in the browser. `completion`
   * resolves once the user has consented and the tokens are saved.
   */
  async beginLogin(): Promise<{
    authorizeUrl: string;
    completion: Promise<{ email: string | null }>;
  }> {
    const existing = await this.#load();
    const hostId = await this.#hostId();
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));
    const nonce = base64url(randomBytes(16));
    const { server, port } = await this.#listen();
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    const url = new URL("/api/accounts/authorize", this.#o.authBase);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: existing?.client_id ?? "dynamic_agent_client",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ext_agent_host_id: hostId,
    };
    if (existing) {
      params.id_token_hint = existing.id_token;
      if (existing.email) params.login_hint = existing.email;
    } else {
      params.agent_name_hint = this.#o.appName;
    }
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const completion = this.#awaitCallback(server, state).then(async (callback) => {
      const clientId = existing ? existing.client_id : callback.clientId;
      if (!clientId)
        throw new EnvokeError("auth", "Enregistrement incomplet : aucun identifiant client reçu.");
      if (existing && callback.clientId && callback.clientId !== existing.client_id) {
        throw new EnvokeError(
          "auth",
          "Identifiant client inattendu dans la réponse : connexion annulée.",
        );
      }
      const tokens = await this.#token({
        grant_type: "authorization_code",
        client_id: clientId,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      });
      const record = await this.#toRecord(tokens, clientId, hostId, nonce, existing);
      await this.#save(record);
      return { email: record.email };
    });
    return { authorizeUrl: url.toString(), completion };
  }

  /** A valid access token, refreshed when it is about to expire. One refresh at a time. */
  async getAccessToken(): Promise<string> {
    const record = await this.#load();
    if (!record) throw new EnvokeError("auth_required", "Compte ChatGPT non connecté.");
    if (record.expires_at - this.#o.now() > REFRESH_MARGIN_MS) return record.access_token;
    // The refresh token rotates: two concurrent refreshes would revoke the session.
    this.#refreshing ??= this.#refresh(record).finally(() => {
      this.#refreshing = null;
    });
    return (await this.#refreshing).access_token;
  }

  async listModels(): Promise<ChatGPTModel[]> {
    const token = await this.getAccessToken();
    const response = await this.#o.fetch(new URL("models", `${this.#o.apiBase}/`), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new EnvokeError(
        "server",
        `Liste des modèles ChatGPT indisponible (${response.status}).`,
      );
    const body = (await response.json()) as {
      models?: { slug: string; display_name?: string; visibility?: string }[];
    };
    return (body.models ?? [])
      .filter((m) => m.visibility === "list")
      .map((m) => ({ slug: m.slug, displayName: m.display_name ?? m.slug }));
  }

  /** Revokes the refresh token, then forgets the tokens locally even if revocation failed. */
  async logout(): Promise<{ revoked: boolean }> {
    const record = await this.#load();
    if (!record) return { revoked: true };
    let revoked = false;
    try {
      const { revocation_endpoint } = await this.#discover();
      if (revocation_endpoint) {
        const response = await this.#o.fetch(revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: record.refresh_token,
            token_type_hint: "refresh_token",
            client_id: record.client_id,
          }),
        });
        revoked = response.ok;
      }
    } catch {
      revoked = false;
    }
    await this.#o.store.delete(RECORD_KEY);
    return { revoked };
  }

  async #refresh(record: ChatGPTRecord): Promise<ChatGPTRecord> {
    let tokens: TokenResponse;
    try {
      tokens = await this.#token({
        grant_type: "refresh_token",
        client_id: record.client_id,
        refresh_token: record.refresh_token,
        resource: RESOURCE,
      });
    } catch (error) {
      if (error instanceof EnvokeError && error.code === "auth") {
        await this.#o.store.delete(RECORD_KEY);
        throw new EnvokeError(
          "auth_required",
          "Session ChatGPT expirée : reconnectez votre compte.",
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    const updated: ChatGPTRecord = {
      ...record,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? record.refresh_token,
      id_token: tokens.id_token ?? record.id_token,
      token_type: tokens.token_type ?? record.token_type,
      expires_at: this.#o.now() + tokens.expires_in * 1000,
      scopes: tokens.scope ? tokens.scope.split(" ") : record.scopes,
      saved_at: new Date(this.#o.now()).toISOString(),
    };
    await this.#save(updated);
    return updated;
  }

  async #token(form: Record<string, string>): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.#o.fetch(new URL("/api/accounts/oauth/token", this.#o.authBase), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
    } catch (error) {
      throw new EnvokeError("network", "Impossible de joindre le service de connexion OpenAI.", {
        cause: error,
      });
    }
    const body = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & {
      error?: string;
    };
    if (!response.ok || !body.access_token || typeof body.expires_in !== "number") {
      const code = body.error ?? `HTTP ${response.status}`;
      const authError = response.status === 400 || response.status === 401;
      throw new EnvokeError(authError ? "auth" : "server", `Échange de jeton refusé (${code}).`);
    }
    return body as TokenResponse;
  }

  async #toRecord(
    tokens: TokenResponse,
    clientId: string,
    hostId: string,
    nonce: string,
    previous: ChatGPTRecord | null,
  ): Promise<ChatGPTRecord> {
    const scopes = (tokens.scope ?? "").split(" ").filter(Boolean);
    if (!scopes.includes(PLAN_SCOPE)) {
      throw new EnvokeError(
        "auth",
        "Autorisation d'utiliser votre forfait ChatGPT refusée sur la page de consentement.",
      );
    }
    if (!tokens.id_token || !tokens.refresh_token) {
      throw new EnvokeError("auth", "Réponse de connexion incomplète (jetons manquants).");
    }
    const { issuer, jwks_uri } = await this.#discover();
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(jwks_uri)), {
        issuer,
        audience: clientId,
        currentDate: new Date(this.#o.now()),
      }));
    } catch (error) {
      throw new EnvokeError("auth", "Jeton d'identité invalide : connexion refusée.", {
        cause: error,
      });
    }
    if (payload.nonce !== nonce)
      throw new EnvokeError("auth", "Jeton d'identité rejoué : connexion refusée.");
    return {
      email: typeof payload.email === "string" ? payload.email : (previous?.email ?? null),
      issuer,
      subject: String(payload.sub),
      client_id: clientId,
      ext_agent_host_id: hostId,
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type ?? "Bearer",
      expires_at: this.#o.now() + tokens.expires_in * 1000,
      scopes,
      saved_at: new Date(this.#o.now()).toISOString(),
    };
  }

  #discover(): Promise<Discovery> {
    this.#discovery ??= (async () => {
      const response = await this.#o.fetch(
        new URL("/.well-known/openid-configuration", this.#o.authBase),
      );
      if (!response.ok)
        throw new EnvokeError("network", "Configuration OpenID d'OpenAI indisponible.");
      return (await response.json()) as Discovery;
    })().catch((error: unknown) => {
      this.#discovery = null;
      throw error;
    });
    return this.#discovery;
  }

  async #hostId(): Promise<string> {
    const existing = await this.#o.store.get(HOST_ID_KEY);
    if (existing) return existing;
    const created = `urn:uuid:${randomUUID()}`;
    await this.#o.store.set(HOST_ID_KEY, created);
    return created;
  }

  async #load(): Promise<ChatGPTRecord | null> {
    const raw = await this.#o.store.get(RECORD_KEY);
    return raw ? (JSON.parse(raw) as ChatGPTRecord) : null;
  }

  async #save(record: ChatGPTRecord): Promise<void> {
    await this.#o.store.set(RECORD_KEY, JSON.stringify(record));
  }

  async #listen(): Promise<{ server: Server; port: number }> {
    for (const port of this.#o.ports) {
      const server = createServer();
      const ok = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (ok) {
        const address = server.address();
        return { server, port: typeof address === "object" && address ? address.port : port };
      }
    }
    throw new EnvokeError("network", "Aucun port local libre pour recevoir la connexion ChatGPT.");
  }

  #awaitCallback(
    server: Server,
    state: string,
  ): Promise<{ code: string; clientId: string | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new EnvokeError("auth", "Connexion ChatGPT expirée : recommencez."));
      }, LOGIN_TIMEOUT_MS);
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        const done = (status: number, text: string) => {
          res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
          clearTimeout(timer);
          server.close();
        };
        if (url.searchParams.get("state") !== state) {
          done(400, "Requête invalide.");
          reject(new EnvokeError("auth", "Paramètre state invalide : connexion refusée."));
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          done(200, "Connexion annulée. Vous pouvez fermer cet onglet.");
          reject(
            new EnvokeError(
              "auth",
              error === "access_denied"
                ? "Connexion refusée par l'utilisateur."
                : `Connexion échouée (${error}).`,
            ),
          );
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          done(400, "Code manquant.");
          reject(new EnvokeError("auth", "Réponse de connexion sans code."));
          return;
        }
        done(200, "Compte ChatGPT connecté. Vous pouvez fermer cet onglet.");
        resolve({ code, clientId: url.searchParams.get("client_id") });
      });
    });
  }
}

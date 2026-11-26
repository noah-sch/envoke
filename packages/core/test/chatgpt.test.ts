import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ChatGPTAuth, MemoryStore } from "../src/index.ts";
import { fakeServer, type FakeServer } from "./helpers.ts";

let privateKey: CryptoKey;
let jwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});

interface AuthServer extends FakeServer {
  tokenCalls: URLSearchParams[];
  /** Nonce of the current sign-in, copied into the ID tokens the server issues. */
  state: { nonce: string };
}

/** Fake auth.openai.com: discovery, JWKS, token (code + refresh), revocation. */
async function authServer(options: { scope?: string; delayMs?: number } = {}): Promise<AuthServer> {
  const tokenCalls: URLSearchParams[] = [];
  const state = { nonce: "" };
  let n = 0;
  const server: FakeServer = await fakeServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.path === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: server.url,
        jwks_uri: `${server.url}/jwks`,
        revocation_endpoint: `${server.url}/revoke`,
      });
    }
    if (req.path === "/jwks") return json(200, { keys: [jwk] });
    if (req.path === "/revoke") return json(200, {});
    if (req.path === "/api/accounts/oauth/token") {
      const form = new URLSearchParams(req.body);
      tokenCalls.push(form);
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      n++;
      const idToken = await new SignJWT({ email: "user@example.com", nonce: state.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(server.url)
        .setAudience("oaiapp_1")
        .setSubject("user-1")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
      return json(200, {
        access_token: `access-${n}`,
        refresh_token: `refresh-${n}`,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope:
          options.scope ??
          "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    }
    if (req.path === "/v1/models") {
      return json(200, {
        models: [
          { slug: "gpt-x", display_name: "GPT X", visibility: "list" },
          { slug: "hidden", visibility: "hide" },
        ],
      });
    }
    json(404, {});
  });
  return Object.assign(server, { tokenCalls, state });
}

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function auth(store = new MemoryStore(), now = () => Date.now()) {
  return new ChatGPTAuth({
    store,
    appName: "envoke",
    authBase: server!.url,
    apiBase: `${server!.url}/v1`,
    ports: [0],
    now,
  });
}

/** Plays the browser: follows the redirect the consent page would send. */
async function consent(
  authorizeUrl: string,
  extra: Record<string, string> = { code: "code-1", client_id: "oaiapp_1" },
) {
  const url = new URL(authorizeUrl);
  server!.state.nonce = url.searchParams.get("nonce")!;
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  for (const [k, v] of Object.entries(extra)) callback.searchParams.set(k, v);
  return fetch(callback);
}

describe("Sign in with ChatGPT", () => {
  it("registers dynamically, validates the ID token and stores the account", async () => {
    server = await authServer();
    const store = new MemoryStore();
    const a = auth(store);
    const { authorizeUrl, completion } = await a.beginLogin();
    const params = new URL(authorizeUrl).searchParams;
    expect(new URL(authorizeUrl).pathname).toBe("/api/accounts/authorize");
    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.get("agent_name_hint")).toBe("envoke");
    expect(params.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(params.get("resource")).toBe("https://api.openai.com/v1");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

    const page = await consent(authorizeUrl);
    expect(page.status).toBe(200);
    await expect(completion).resolves.toEqual({ email: "user@example.com" });

    const exchange = server.tokenCalls[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("client_id")).toBe("oaiapp_1");
    expect(exchange.get("code")).toBe("code-1");
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(exchange.get("redirect_uri")).toBe(params.get("redirect_uri"));
    expect(await a.getAccessToken()).toBe("access-1");
    expect(await a.status()).toEqual({ linked: true, email: "user@example.com" });
    expect(await a.listModels()).toEqual([{ slug: "gpt-x", displayName: "GPT X" }]);
  });

  it("rejects a callback with the wrong state", async () => {
    server = await authServer();
    const { authorizeUrl, completion } = await auth().beginLogin();
    const callback = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", "forged");
    callback.searchParams.set("code", "x");
    const settled = completion.catch((e: unknown) => e);
    await fetch(callback);
    expect(String(await settled)).toMatch(/state invalide/);
    expect(server.tokenCalls).toHaveLength(0);
  });

  it("handles a user who declines", async () => {
    server = await authServer();
    const { authorizeUrl, completion } = await auth().beginLogin();
    const settled = completion.catch((e: unknown) => e);
    await consent(authorizeUrl, { error: "access_denied" });
    expect(String(await settled)).toMatch(/refusée par l'utilisateur/);
  });

  it("refuses an account whose plan permission was not granted", async () => {
    server = await authServer({ scope: "openid profile email offline_access" });
    const { authorizeUrl, completion } = await auth().beginLogin();
    const settled = completion.catch((e: unknown) => e);
    await consent(authorizeUrl);
    expect(String(await settled)).toMatch(/forfait ChatGPT refusée/);
  });

  it("refreshes once when two requests need a new token at the same time", async () => {
    server = await authServer({ delayMs: 50 });
    let clock = Date.now();
    const store = new MemoryStore();
    const a = auth(store, () => clock);
    const { authorizeUrl, completion } = await a.beginLogin();
    await consent(authorizeUrl);
    await completion;
    clock += 3600_000; // expired
    const [t1, t2] = await Promise.all([a.getAccessToken(), a.getAccessToken()]);
    expect([t1, t2]).toEqual(["access-2", "access-2"]);
    const refreshes = server.tokenCalls.filter((f) => f.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.get("refresh_token")).toBe("refresh-1");
    expect(refreshes[0]!.get("client_id")).toBe("oaiapp_1");
  });

  it("revokes on logout and forgets the tokens", async () => {
    server = await authServer();
    const a = auth();
    const { authorizeUrl, completion } = await a.beginLogin();
    await consent(authorizeUrl);
    await completion;
    expect(await a.logout()).toEqual({ revoked: true });
    const revoke = server.requests.find((r) => r.path === "/revoke")!;
    expect(new URLSearchParams(revoke.body).get("token_type_hint")).toBe("refresh_token");
    expect(await a.status()).toEqual({ linked: false, email: null });
  });
});

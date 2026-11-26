import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/index.ts";

describe("config", () => {
  it("ships a valid default catalog with subscription logins blocked", () => {
    const config = parseConfig(DEFAULT_CONFIG);
    expect(config.policy.subscriptionLogins).toEqual([]);
    expect(config.connections.map((c) => c.id)).toContain("chatgpt");
  });

  it("uses the defaults when there is no config file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "envoke-cfg-"));
    expect((await loadConfig(dir)).defaultProfile).toBe("claude");
  });

  it("explains what is wrong in an invalid file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "envoke-cfg-"));
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ connections: [{ id: "x", type: "nope" }] }),
    );
    await expect(loadConfig(dir)).rejects.toMatchObject({
      code: "config",
      message: expect.stringContaining("Configuration invalide"),
    });
    await writeFile(path.join(dir, "config.json"), "{ not json");
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: "config" });
  });

  it("checks references between profiles and connections", () => {
    const base = {
      connections: [{ id: "a", type: "anthropic" }],
      profiles: [{ id: "p", connection: "missing", model: "m" }],
      defaultProfile: "p",
    };
    expect(() => parseConfig(base)).toThrow(/connexion inconnue/);
    expect(() => parseConfig({ ...base, profiles: [{ id: "p", connection: "a" }] })).toThrow(
      /doit préciser un modèle/,
    );
    expect(() =>
      parseConfig({
        ...base,
        connections: [...base.connections, { id: "g", type: "acp", agent: "x", env: { K: "zz" } }],
        profiles: [{ id: "p", connection: "a", model: "m" }],
      }),
    ).toThrow(/connexion inconnue : zz/);
  });

  it("never holds secrets: no field accepts a key", () => {
    const config = parseConfig({
      connections: [{ id: "a", type: "anthropic", apiKey: "sk-should-be-dropped" }],
      profiles: [{ id: "p", connection: "a", model: "m" }],
      defaultProfile: "p",
    });
    expect(JSON.stringify(config)).not.toContain("sk-should-be-dropped");
  });
});

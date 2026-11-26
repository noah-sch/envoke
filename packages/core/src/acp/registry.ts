import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { EnvokeError } from "../errors.ts";

const run = promisify(execFile);
const DAY_MS = 24 * 60 * 60_000;

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  distribution: {
    npx?: { package: string; args?: string[] };
    binary?: Record<string, { archive: string; cmd: string; args?: string[]; sha256?: string }>;
    uvx?: { package: string; args?: string[] };
  };
}

export interface LaunchSpec {
  command: string;
  args: string[];
}

export interface RegistryOptions {
  url: string;
  dataDir: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * ACP registry: lists agents and installs each one once into the data directory, so a launch
 * never waits on the network (no `npx` resolution at every start).
 */
export class AcpRegistry {
  readonly #o: Required<RegistryOptions>;
  readonly #installs = new Map<string, Promise<LaunchSpec>>();

  constructor(options: RegistryOptions) {
    this.#o = { fetch: globalThis.fetch, now: Date.now, ...options };
  }

  get #dir(): string {
    return path.join(this.#o.dataDir, "acp");
  }

  /** Cached for a day; the stale copy is used when offline. */
  async list(): Promise<RegistryAgent[]> {
    const cacheFile = path.join(this.#dir, "registry.json");
    let cached: { fetchedAt: number; agents: RegistryAgent[] } | null;
    try {
      cached = JSON.parse(await readFile(cacheFile, "utf8")) as {
        fetchedAt: number;
        agents: RegistryAgent[];
      };
    } catch {
      cached = null;
    }
    if (cached && this.#o.now() - cached.fetchedAt < DAY_MS) return cached.agents;
    try {
      const response = await this.#o.fetch(this.#o.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { agents: RegistryAgent[] };
      await mkdir(this.#dir, { recursive: true });
      await writeFile(cacheFile, JSON.stringify({ fetchedAt: this.#o.now(), agents: body.agents }));
      return body.agents;
    } catch (error) {
      if (cached) return cached.agents;
      throw new EnvokeError("network", "Registre des agents ACP inaccessible.", { cause: error });
    }
  }

  async get(agentId: string): Promise<RegistryAgent> {
    const agent = (await this.list()).find((a) => a.id === agentId);
    if (!agent) throw new EnvokeError("not_found", `Agent absent du registre ACP : ${agentId}`);
    return agent;
  }

  /** Installs the agent if needed and returns how to start it. Concurrent calls share the work. */
  install(agent: RegistryAgent): Promise<LaunchSpec> {
    const key = `${agent.id}@${agent.version}`;
    let pending = this.#installs.get(key);
    if (!pending) {
      pending = this.#install(agent).catch((error: unknown) => {
        this.#installs.delete(key);
        throw error;
      });
      this.#installs.set(key, pending);
    }
    return pending;
  }

  async #install(agent: RegistryAgent): Promise<LaunchSpec> {
    const dir = path.join(this.#dir, "agents", agent.id, agent.version);
    const { npx, binary, uvx } = agent.distribution;
    const target = binary?.[platformKey()];
    if (npx) return this.#installNpm(dir, npx.package, npx.args ?? []);
    if (target) return this.#installBinary(dir, target);
    if (uvx) return { command: "uvx", args: [uvx.package, ...(uvx.args ?? [])] };
    throw new EnvokeError("not_found", `${agent.name} n'est pas disponible pour ${platformKey()}.`);
  }

  async #installNpm(dir: string, spec: string, args: string[]): Promise<LaunchSpec> {
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const marker = path.join(dir, ".installed");
    if (!existsSync(marker)) {
      await mkdir(dir, { recursive: true });
      const npm = path.join(path.dirname(process.execPath), "npm");
      try {
        // Pinned version from the registry; install scripts disabled.
        await run(
          existsSync(npm) ? npm : "npm",
          ["install", "--prefix", dir, "--no-audit", "--no-fund", "--ignore-scripts", spec],
          {
            timeout: 10 * 60_000,
          },
        );
      } catch (error) {
        throw new EnvokeError("agent", `Installation de ${spec} impossible.`, { cause: error });
      }
      await writeFile(marker, new Date().toISOString());
    }
    const manifest = JSON.parse(
      await readFile(path.join(dir, "node_modules", name, "package.json"), "utf8"),
    ) as {
      bin?: string | Record<string, string>;
    };
    const baseName = name.split("/").pop() ?? name;
    let binName = baseName;
    if (manifest.bin && typeof manifest.bin === "object") {
      const names = Object.keys(manifest.bin);
      binName = names.includes(baseName) ? baseName : (names[0] ?? baseName);
    }
    const bin = await realpath(path.join(dir, "node_modules", ".bin", binName));
    // Run JavaScript entry points with our own Node: the user's machine may have none.
    const head = (await readFile(bin, "utf8").catch(() => "")).slice(0, 200);
    if (/\.[cm]?js$/.test(bin) || /^#!.*\bnode\b/.test(head)) {
      return { command: process.execPath, args: [bin, ...args] };
    }
    return { command: bin, args };
  }

  async #installBinary(
    dir: string,
    target: { archive: string; cmd: string; args?: string[]; sha256?: string },
  ): Promise<LaunchSpec> {
    const command = path.resolve(dir, target.cmd);
    if (path.relative(dir, command).startsWith(".."))
      throw new EnvokeError("agent", "Commande d'agent invalide.");
    if (!existsSync(command)) {
      await mkdir(dir, { recursive: true });
      const response = await this.#o.fetch(target.archive);
      if (!response.ok)
        throw new EnvokeError("network", `Téléchargement impossible : ${target.archive}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (target.sha256 && createHash("sha256").update(bytes).digest("hex") !== target.sha256) {
        throw new EnvokeError("agent", "Empreinte SHA-256 invalide : archive rejetée.");
      }
      const archive = path.join(dir, path.basename(new URL(target.archive).pathname));
      await writeFile(archive, bytes);
      if (archive.endsWith(".zip")) await run("unzip", ["-q", "-o", archive, "-d", dir]);
      else await run("tar", ["-xf", archive, "-C", dir]);
      await chmod(command, 0o755);
    }
    return { command, args: target.args ?? [] };
  }
}

export function platformKey(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${os}-${arch}`;
}

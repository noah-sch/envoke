import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { EnvokeError } from "../errors.ts";
import { safeEnv } from "../tools/bash.ts";
import type { ClaudeCodeStatus } from "../types.ts";
import { chatHookSettings, type ClaudeChat } from "./chat.ts";
import type { TerminalHost } from "./host.ts";

/** How to start Claude Code; tests point it at a fake program. */
export interface ClaudeCommand {
  command: string;
  /** Placed before Claude Code's own arguments. */
  args: string[];
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Markers a running Claude Code puts on the processes it starts. Inherited (envoke itself started
 * from Claude Code), they make the user's Claude Code act as a sub-session that saves nothing.
 * The user's own settings (CLAUDE_CODE_USE_BEDROCK…) are not markers and stay.
 */
const PARENT_SESSION =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT|CLAUDE_CODE_(CHILD_|SESSION_|MESSAGING_|ENTRYPOINT|EXECPATH|SSE_PORT))/;

/** A resume that fails this fast found no conversation to resume. */
const FAILED_RESUME_MS = 5000;

/** Where the official installers put the binary, besides PATH. */
function candidates(env: NodeJS.ProcessEnv): string[] {
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(homedir(), ".local", "bin"), path.join(homedir(), ".claude", "local"));
  return dirs.map((dir) => path.join(dir, name));
}

export async function findClaudeCode(env = process.env): Promise<string | null> {
  for (const file of candidates(env)) {
    const ok = await access(file, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return file;
  }
  return null;
}

/**
 * The user's own Claude Code, run in a terminal like in any terminal app. envoke never reads,
 * stores nor passes Claude credentials: the user signs in inside Claude Code, through Anthropic's
 * own flow, and the process gets an environment without secrets.
 */
export class ClaudeCode {
  readonly #host: TerminalHost;
  readonly #override: ClaudeCommand | undefined;
  /** Sessions created by this process and not started yet, with their first request. */
  readonly #fresh = new Map<string, string | null>();
  readonly #chat: ClaudeChat;
  /** Where Claude Code's hooks post (the local server); null: no chat view, terminal only. */
  #hookBase: string | null = null;

  constructor(host: TerminalHost, chat: ClaudeChat, override?: ClaudeCommand) {
    this.#host = host;
    this.#chat = chat;
    this.#override = override;
  }

  setHookBase(base: string): void {
    this.#hookBase = base;
  }

  async status(): Promise<ClaudeCodeStatus> {
    if (this.#override) return { installed: true, path: this.#override.command };
    const found = await findClaudeCode();
    return { installed: found !== null, path: found };
  }

  /** Remembers a new session: it starts when its first viewer attaches, at the viewer's size. */
  prepare(sessionId: string, prompt: string | null): void {
    this.#fresh.set(sessionId, prompt);
  }

  async startIfFresh(sessionId: string, cwd: string, size: TerminalSize): Promise<void> {
    if (!this.#fresh.has(sessionId) || this.#host.known(sessionId)) return;
    const prompt = this.#fresh.get(sessionId) ?? null;
    this.#fresh.delete(sessionId);
    // Our session id doubles as Claude Code's: `--resume` finds the conversation again later.
    await this.#start(sessionId, cwd, size, [
      "--session-id",
      sessionId,
      ...(prompt ? [prompt] : []),
    ]);
  }

  /** Reopens the conversation; one that was never saved starts afresh under the same id. */
  async resume(sessionId: string, cwd: string, size: TerminalSize): Promise<void> {
    if (this.#host.running(sessionId)) return;
    this.#fresh.delete(sessionId);
    const startedAt = Date.now();
    await this.#start(sessionId, cwd, size, ["--resume", sessionId], (exitCode) => {
      if (exitCode !== 0 && Date.now() - startedAt < FAILED_RESUME_MS) {
        void this.#start(sessionId, cwd, size, ["--session-id", sessionId]).catch(() => {});
      }
    });
  }

  forget(sessionId: string): void {
    this.#fresh.delete(sessionId);
    this.#host.forget(sessionId);
    this.#chat.forget(sessionId);
  }

  async #start(
    sessionId: string,
    cwd: string,
    size: TerminalSize,
    args: string[],
    onExit?: (exitCode: number) => void,
  ): Promise<void> {
    const command = this.#override ?? (await this.#locate());
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(safeEnv()).filter(
        (e): e is [string, string] => e[1] !== undefined && !PARENT_SESSION.test(e[0]),
      ),
    );
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    const hooks: string[] = [];
    if (this.#hookBase) {
      // A token for this process only: it lets Claude Code post this session's hooks, nothing else.
      env.ENVOKE_HOOK_TOKEN = this.#chat.issueToken(sessionId);
      hooks.push("--settings", chatHookSettings(`${this.#hookBase}/api/hooks/${sessionId}`));
    }
    this.#host.start(
      sessionId,
      {
        command: command.command,
        args: [...command.args, ...hooks, ...args],
        cwd,
        env,
        ...size,
      },
      (exitCode) => {
        this.#chat.process(sessionId, false);
        onExit?.(exitCode);
      },
    );
    this.#chat.process(sessionId, true);
  }

  async #locate(): Promise<ClaudeCommand> {
    const found = await findClaudeCode();
    if (!found) {
      throw new EnvokeError("bad_request", "Claude Code n'est pas installé sur cet ordinateur.");
    }
    return { command: found, args: [] };
  }
}

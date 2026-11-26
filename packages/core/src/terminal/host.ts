import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { spawn, type IPty } from "node-pty";
import type { TerminalEvent } from "../types.ts";

const { Terminal } = headless;
type Mirror = InstanceType<typeof Terminal>;

export interface TerminalLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

interface Entry {
  pty: IPty | null;
  /** Server-side copy of the screen: a viewer that comes back gets it as a snapshot. */
  mirror: Mirror;
  serializer: SerializeAddon;
  listeners: Set<(event: TerminalEvent) => void>;
  exitCode: number | null;
}

const SCROLLBACK = 5000;
/** RIS: full reset, scrollback included. */
const RESET = "\x1bc";

/**
 * Processes in a pseudo-terminal, one per session id. They keep running with no viewer; viewers
 * attach and detach freely. Nothing here knows which program runs.
 */
export class TerminalHost {
  readonly #entries = new Map<string, Entry>();

  known(id: string): boolean {
    return this.#entries.has(id);
  }

  running(id: string): boolean {
    return this.#entries.get(id)?.pty != null;
  }

  /** Starts (or restarts) the process for `id`. Viewers already attached see a `start` event. */
  start(id: string, launch: TerminalLaunch, onExit?: (exitCode: number) => void): void {
    if (this.running(id)) throw new Error(`Terminal already running: ${id}`);
    let entry = this.#entries.get(id);
    const emit = (event: TerminalEvent) => entry?.listeners.forEach((l) => l(event));
    if (entry) {
      // Reset in order with the stream: what the old process printed stays before it.
      entry.mirror.write(RESET);
      entry.mirror.resize(launch.cols, launch.rows);
      entry.exitCode = null;
      emit({ type: "start" });
    } else {
      const mirror = new Terminal({
        cols: launch.cols,
        rows: launch.rows,
        scrollback: SCROLLBACK,
        allowProposedApi: true,
      });
      const serializer = new SerializeAddon();
      mirror.loadAddon(serializer);
      entry = { pty: null, mirror, serializer, listeners: new Set(), exitCode: null };
      this.#entries.set(id, entry);
    }
    const current = entry;
    const pty = spawn(launch.command, launch.args, {
      name: "xterm-256color",
      cols: launch.cols,
      rows: launch.rows,
      cwd: launch.cwd,
      env: launch.env,
    });
    current.pty = pty;
    pty.onData((data) => {
      current.mirror.write(data);
      emit({ type: "data", data });
    });
    pty.onExit(({ exitCode }) => {
      if (current.pty !== pty) return;
      current.pty = null;
      current.exitCode = exitCode;
      emit({ type: "exit", exitCode });
      onExit?.(exitCode);
    });
  }

  /**
   * Subscribes to a terminal. The first event is always a snapshot of the screen; the events
   * that follow continue exactly where the snapshot ends.
   */
  attach(id: string, listener: (event: TerminalEvent) => void): () => void {
    const entry = this.#entries.get(id);
    if (!entry) {
      listener({ type: "snapshot", data: "", running: false, exitCode: null });
      return () => {};
    }
    const backlog: TerminalEvent[] = [];
    let live = false;
    const relay = (event: TerminalEvent) => (live ? listener(event) : backlog.push(event));
    entry.listeners.add(relay);
    // The mirror parses writes asynchronously. An empty write's callback runs once everything
    // written before it is parsed and nothing after: the serialized screen matches the backlog.
    const running = entry.pty !== null;
    const exitCode = entry.exitCode;
    entry.mirror.write("", () => {
      if (!entry.listeners.has(relay)) return;
      listener({ type: "snapshot", data: entry.serializer.serialize(), running, exitCode });
      for (const event of backlog) listener(event);
      live = true;
    });
    return () => entry.listeners.delete(relay);
  }

  write(id: string, data: string): void {
    this.#entries.get(id)?.pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.mirror.resize(cols, rows);
    entry.pty?.resize(cols, rows);
  }

  stop(id: string): void {
    this.#entries.get(id)?.pty?.kill();
  }

  /** Stops the process and drops the screen (the session was deleted). */
  forget(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    entry.pty?.kill();
    entry.pty = null;
    entry.mirror.dispose();
    entry.listeners.clear();
  }

  disposeAll(): void {
    for (const id of [...this.#entries.keys()]) this.forget(id);
  }
}

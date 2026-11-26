import type { TerminalEvent } from "@envoke/core/types";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "../api.ts";

/** Dark ink surface, coral cursor: Claude Code's default theme reads well on it. */
const THEME: ITheme = {
  background: "#141416",
  foreground: "#f5f4f2",
  cursor: "#ff6363",
  cursorAccent: "#141416",
  selectionBackground: "rgba(255, 99, 99, 0.35)",
  black: "#141416",
  red: "#ff6363",
  green: "#4cc38a",
  yellow: "#e5b454",
  blue: "#6ca6f0",
  magenta: "#d68ae0",
  cyan: "#5cc8c8",
  white: "#e3e1dc",
  brightBlack: "#63636b",
  brightRed: "#ff8585",
  brightGreen: "#6fd6a3",
  brightYellow: "#f0c978",
  brightBlue: "#8cbbf5",
  brightMagenta: "#e3a6ea",
  brightCyan: "#7fd8d8",
  brightWhite: "#ffffff",
};

const FONT = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

/**
 * Claude Code's own screen: xterm.js on the session's terminal stream. Loaded on demand (xterm is
 * most of the bundle). Start, stop and resume belong to the view around it.
 */
export function TerminalPane({
  api,
  sessionId,
  onUnauthorized,
}: {
  api: Api;
  sessionId: string;
  onUnauthorized: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to reconnect after the engine hung up. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const id = sessionId;
    const controller = new AbortController();
    const terminal = new Terminal({
      fontFamily: FONT,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener,noreferrer")),
    );

    // Keystrokes go out in order: one request at a time, the rest batched behind it.
    let pending = "";
    let sending = false;
    const pump = async () => {
      if (sending || !pending) return;
      sending = true;
      const data = pending;
      pending = "";
      try {
        await api.terminalInput(id, data);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
      } finally {
        sending = false;
        void pump();
      }
    };
    const typing = terminal.onData((data) => {
      pending += data;
      void pump();
    });

    let size = { cols: 0, rows: 0 };
    const resize = () => {
      if (!element.clientWidth) return;
      fit.fit();
      if (terminal.cols === size.cols && terminal.rows === size.rows) return;
      const first = size.cols === 0;
      size = { cols: terminal.cols, rows: terminal.rows };
      if (!first) api.terminalResize(id, size).catch(() => {});
    };
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(resize, 60);
    });

    const onEvent = (event: TerminalEvent) => {
      switch (event.type) {
        case "snapshot":
          terminal.reset();
          terminal.write(event.data);
          break;
        case "start":
          // Restarted (Reprendre) at another size: give it this screen's.
          terminal.reset();
          if (size.cols) api.terminalResize(id, size).catch(() => {});
          break;
        case "data":
          terminal.write(event.data);
          break;
        case "exit":
          break;
      }
    };

    const connect = async () => {
      // Cell size is measured from the font: wait for it before the first fit.
      await document.fonts.load(`13px ${FONT}`).catch(() => {});
      if (controller.signal.aborted) return;
      terminal.open(element);
      resize();
      observer.observe(element);
      terminal.focus();
      setError(null);
      try {
        const initial = size.cols ? size : { cols: 100, rows: 30 };
        await api.terminalStream(id, initial, onEvent, controller.signal);
        if (!controller.signal.aborted) setError("Connexion au moteur interrompue.");
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setError(e instanceof Error ? e.message : String(e));
      }
    };
    void connect();

    return () => {
      controller.abort();
      window.clearTimeout(timer);
      observer.disconnect();
      typing.dispose();
      terminal.dispose();
    };
  }, [api, sessionId, attempt, onUnauthorized]);

  return (
    <div className="term">
      <div className="term-host" ref={host} />
      {error && (
        <div className="term-bar" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
            Reconnecter
          </button>
        </div>
      )}
    </div>
  );
}

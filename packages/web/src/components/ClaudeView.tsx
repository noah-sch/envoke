import type { ChatSnapshot, ClaudeChatEvent, Decision, SessionRecord } from "@envoke/core/types";
import { lazy, Suspense, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ApiError, type Api } from "../api.ts";
import { claudeReducer, initialClaude } from "../claude.ts";
import { Icon } from "../icons.tsx";
import { Composer } from "./Composer.tsx";
import { LogoMark } from "./Logo.tsx";
import { Alert, TurnView } from "./Thread.tsx";
import { useToast } from "./Toast.tsx";

/** xterm is most of the bundle: loaded only when the terminal is shown. */
const TerminalPane = lazy(() =>
  import("./TerminalView.tsx").then((m) => ({ default: m.TerminalPane })),
);

/** Size Claude Code restarts at while only the chat watches it. */
const CHAT_SIZE = { cols: 120, rows: 40 };
/** Without a first hook by then, Claude Code is likely asking something in its terminal. */
const SLOW_START_MS = 6000;

const noop = () => {};

/**
 * A Claude Code session shown as a chat: messages, tool cards and permission questions come from
 * Claude Code's hooks. Its terminal stays one click away for /login, menus and dialogs.
 */
export function ClaudeView({
  api,
  session,
  onChanged,
  onToggleSidebar,
  onUnauthorized,
}: {
  api: Api;
  /** Undefined when the session no longer exists. */
  session: SessionRecord | undefined;
  /** The title may change with the first message. */
  onChanged: () => void;
  onToggleSidebar: () => void;
  onUnauthorized: () => void;
}) {
  const toast = useToast();
  const [state, dispatch] = useReducer(claudeReducer, initialClaude);
  const [view, setView] = useState<"chat" | "terminal">("chat");
  const [draft, setDraft] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [slowStart, setSlowStart] = useState(false);
  const id = session?.id;

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    // Text arrives line by line: apply events once per frame.
    let queue: (ClaudeChatEvent | ChatSnapshot)[] = [];
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      const events = queue;
      queue = [];
      dispatch({ type: "events", events });
      if (events.some((e) => e.type === "prompt")) onChanged();
    };
    api
      .claudeChat(
        id,
        (event) => {
          queue.push(event);
          frame ??= requestAnimationFrame(flush);
        },
        controller.signal,
      )
      .then(
        () => {
          if (!controller.signal.aborted) setStreamError("Connexion au moteur interrompue.");
        },
        (e: unknown) => {
          if (controller.signal.aborted) return;
          if (e instanceof ApiError && e.status === 401) onUnauthorized();
          else if (e instanceof ApiError && e.status === 404 && e.message === "Route inconnue.") {
            // The interface is read from disk, the engine's code only at launch: an engine started
            // before an update does not know this view yet.
            setStreamError(
              "Le moteur local date d'avant cette version de l'interface : relancez-le (pnpm serve), puis rouvrez cette session.",
            );
          } else setStreamError(e instanceof Error ? e.message : String(e));
        },
      );
    return () => {
      controller.abort();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [api, id, attempt, onChanged, onUnauthorized]);

  const starting = state.running && !state.ready;
  useEffect(() => {
    if (!starting) return;
    const timer = window.setTimeout(() => setSlowStart(true), SLOW_START_MS);
    return () => {
      window.clearTimeout(timer);
      setSlowStart(false);
    };
  }, [starting]);

  // Follow the answer while the reader stays at the bottom.
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state, view]);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else toast(e instanceof Error ? e.message : String(e));
  };
  const send = () => {
    const text = draft.trim();
    if (!id || !text) return;
    setDraft("");
    stick.current = true;
    api.claudePrompt(id, text).catch((e: unknown) => {
      setDraft(text);
      fail(e);
    });
  };
  const onDecide = (requestId: string, decision: Decision) => {
    dispatch({ type: "decide", requestId, decision });
    api.decide(requestId, decision).catch(fail);
  };
  const resume = () => {
    if (id) api.terminalResume(id, CHAT_SIZE).catch(fail);
  };
  const stop = () => {
    if (id) api.terminalStop(id).catch(fail);
  };
  const openTerminal = () => setView("terminal");

  const all = state.live ? [...state.turns, state.live] : state.turns;

  let banner = null;
  if (state.loaded && !state.running) {
    banner = (
      <Alert
        tone="warning"
        title="Claude Code est arrêté."
        text="Reprenez la session pour continuer la conversation."
        action={{ label: "Reprendre", onClick: resume }}
      />
    );
  } else if (state.attention) {
    banner = (
      <Alert
        tone="warning"
        title="Claude Code attend une réponse dans son terminal."
        text={state.attention}
        action={{ label: "Ouvrir le terminal", onClick: openTerminal }}
      />
    );
  } else if (starting && slowStart) {
    banner = (
      <Alert
        tone="warning"
        title="Claude Code ne répond pas encore."
        text="Il vous pose peut-être une question (dossier de confiance, connexion) : répondez-y dans son terminal."
        action={{ label: "Ouvrir le terminal", onClick: openTerminal }}
      />
    );
  }

  return (
    <>
      <header className="chat-head">
        <button
          type="button"
          className="icon-btn plain menu-toggle"
          aria-label="Afficher l'historique"
          onClick={onToggleSidebar}
        >
          <Icon name="menu" />
        </button>
        <div className="chat-title">
          <h1>{session?.title || "Claude Code"}</h1>
          {session && (
            <p className="chat-cwd">
              <Icon name="folder" size={14} />
              <span>{session.cwd}</span>
            </p>
          )}
        </div>
        {session && (
          <div className="segmented" role="group" aria-label="Affichage">
            <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}>
              <Icon name="chat" size={16} />
              Chat
            </button>
            <button
              type="button"
              aria-pressed={view === "terminal"}
              onClick={() => setView("terminal")}
            >
              <Icon name="terminal" size={16} />
              Terminal
            </button>
          </div>
        )}
        {state.loaded &&
          (state.running ? (
            <button type="button" className="btn btn-sm" onClick={stop}>
              Arrêter
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={resume}>
              Reprendre
            </button>
          ))}
      </header>

      {!session || !id ? (
        <div className="thread-inner">
          <Alert title="Session introuvable." text="Elle a peut-être été supprimée." />
        </div>
      ) : view === "terminal" ? (
        <Suspense fallback={null}>
          <TerminalPane api={api} sessionId={id} onUnauthorized={onUnauthorized} />
        </Suspense>
      ) : (
        <>
          <div
            className="thread"
            ref={thread}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
          >
            {streamError ? (
              <div className="thread-inner">
                <Alert
                  title="Conversation indisponible."
                  text={streamError}
                  action={{ label: "Reconnecter", onClick: () => setAttempt((n) => n + 1) }}
                />
              </div>
            ) : all.length === 0 ? (
              state.loaded && (
                <section className="claude-empty" aria-live="polite">
                  <LogoMark size={44} />
                  <h2>{starting ? "Claude Code démarre…" : "Claude Code est prêt."}</h2>
                  <p>
                    Écrivez votre demande ci-dessous. Ses réponses, les commandes qu&#39;il lance et
                    les fichiers qu&#39;il modifie s&#39;affichent ici, avec ses demandes
                    d&#39;accord.
                  </p>
                </section>
              )
            ) : (
              <div className="thread-inner">
                {all.map((turn, i) => (
                  <TurnView
                    key={turn.id}
                    turn={turn}
                    isLast={i === all.length - 1}
                    canRegenerate={false}
                    agent="Claude Code"
                    onDecide={onDecide}
                    onRegenerate={noop}
                    onOpenConnections={noop}
                  />
                ))}
              </div>
            )}
          </div>
          {banner && (
            <div className="composer-wrap">
              <div className="composer-alert">{banner}</div>
            </div>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={() => {
              if (id) api.claudeInterrupt(id).catch(fail);
            }}
            running={state.working}
            disabled={!state.running}
            placeholder={
              !state.loaded
                ? "Connexion à Claude Code…"
                : state.running
                  ? "Écrire à Claude Code…"
                  : "Claude Code est arrêté"
            }
            mode={null}
            onModeChange={noop}
          />
        </>
      )}
    </>
  );
}

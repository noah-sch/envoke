import type {
  AgentEvent,
  ClaudeCodeStatus,
  Decision,
  Effort,
  ProfileInfo,
  SessionRecord,
} from "@envoke/core/types";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ApiError, type Api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { applyEvent, decide, newTurn, turnsFromHistory, type Turn } from "../turns.ts";
import { Composer, modeOf } from "./Composer.tsx";
import { LogoMark } from "./Logo.tsx";
import { Menu } from "./Menu.tsx";
import { Alert, TurnView } from "./Thread.tsx";
import { useToast } from "./Toast.tsx";

interface State {
  turns: Turn[];
  live: Turn | null;
}

type Action =
  | { type: "load"; turns: Turn[] }
  | { type: "start"; user: string }
  | { type: "events"; events: AgentEvent[] }
  | { type: "finish" }
  | { type: "decide"; requestId: string; decision: Decision }
  | { type: "dropLast" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "load":
      return { turns: action.turns, live: null };
    case "start":
      return { ...state, live: newTurn(action.user) };
    case "events":
      return state.live ? { ...state, live: action.events.reduce(applyEvent, state.live) } : state;
    case "finish": {
      if (!state.live) return state;
      // A stream that ends without turn_done was cut (engine stopped, network).
      const done =
        state.live.status === "streaming"
          ? applyEvent(state.live, {
              type: "error",
              code: "network",
              message: "Connexion au moteur interrompue. Réessayez dans un instant.",
            })
          : state.live;
      return { turns: [...state.turns, done], live: null };
    }
    case "decide":
      return state.live
        ? { ...state, live: decide(state.live, action.requestId, action.decision) }
        : state;
    case "dropLast":
      return { ...state, turns: state.turns.slice(0, -1) };
  }
}

const SUGGESTIONS = [
  { label: "Résumer un document", prompt: "Résume le document suivant en cinq points :\n\n" },
  { label: "Rédiger un e-mail", prompt: "Rédige un e-mail court et cordial pour " },
  {
    label: "Expliquer du code",
    prompt: "Explique ce que fait le code de ce dossier, fichier par fichier.",
  },
  {
    label: "Préparer une réunion",
    prompt: "Prépare l'ordre du jour d'une réunion de 30 minutes sur ",
  },
];

export function ChatView({
  api,
  sessionId,
  title,
  profiles,
  defaultProfile,
  defaultCwd,
  claude,
  startWithClaude,
  onTerminal,
  onCreated,
  onChanged,
  onOpenConnections,
  onToggleSidebar,
}: {
  api: Api;
  sessionId: string | null;
  /** Current title from the sessions list: follows renames and the automatic title. */
  title: string | undefined;
  profiles: ProfileInfo[];
  defaultProfile: string;
  defaultCwd: string;
  /** The user's Claude Code install; null until known. */
  claude: ClaudeCodeStatus | null;
  /** Preselect Claude Code for this new chat. */
  startWithClaude: boolean;
  /** A Claude Code terminal was opened from this screen. */
  onTerminal: (session: SessionRecord) => void;
  onCreated: (session: SessionRecord) => void;
  onChanged: () => void;
  onOpenConnections: () => void;
  onToggleSidebar: () => void;
}) {
  const toast = useToast();
  const [state, dispatch] = useReducer(reducer, { turns: [], live: null });
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [profileId, setProfileId] = useState(defaultProfile);
  const [cwd, setCwd] = useState(defaultCwd);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  /** New chats only: open the user's Claude Code in a terminal instead of an envoke chat. */
  const [useClaude, setUseClaude] = useState(startWithClaude && sessionId === null);
  const [opening, setOpening] = useState(false);
  const [mode, setMode] = useState<Effort>(modeOf(profile?.effort ?? null));

  /** The session this view just created: already on screen, no reload. */
  const adopted = useRef<string | null>(null);

  useEffect(() => {
    if (sessionId === null) {
      setSession(null);
      setProfileId(defaultProfile);
      setLoadError(null);
      dispatch({ type: "load", turns: [] });
      return;
    }
    if (sessionId === adopted.current) return;
    let cancelled = false;
    setLoadError(null);
    api.session(sessionId).then(
      ({ session: s, messages }) => {
        if (cancelled) return;
        setSession(s);
        setProfileId(s.profileId);
        dispatch({ type: "load", turns: turnsFromHistory(messages) });
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, defaultProfile]);

  useEffect(() => {
    if (sessionId === null) setCwd(defaultCwd);
  }, [defaultCwd, sessionId]);

  useEffect(() => {
    setMode(modeOf(profile?.effort ?? null));
  }, [profile?.id, profile?.effort]);

  // Events arrive many times a second: apply them once per frame.
  const queue = useRef<AgentEvent[]>([]);
  const frame = useRef<number | null>(null);
  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const events = queue.current;
    queue.current = [];
    if (events.length) dispatch({ type: "events", events });
  }, []);
  const onEvent = useCallback(
    (event: AgentEvent) => {
      queue.current.push(event);
      frame.current ??= requestAnimationFrame(flush);
    },
    [flush],
  );

  const run = async (request: { text: string } | { regenerate: true }, user: string) => {
    let id = session?.id;
    setStartError(null);
    if (!id) {
      try {
        const created = await api.createSession({ cwd, profileId });
        adopted.current = created.id;
        setSession(created);
        onCreated(created);
        id = created.id;
      } catch (error) {
        setStartError(error instanceof Error ? error.message : String(error));
        return false;
      }
    }
    dispatch({ type: "start", user });
    setRunning(true);
    try {
      await api.stream(id, request, profile?.engine === "native" ? mode : null, onEvent);
    } catch (error) {
      const e = error instanceof ApiError ? error : new ApiError("network", String(error), 0);
      onEvent({ type: "error", code: e.code, message: e.message });
    } finally {
      flush();
      dispatch({ type: "finish" });
      setRunning(false);
      onChanged();
    }
    return true;
  };

  const openClaude = async () => {
    const text = draft.trim();
    setStartError(null);
    setOpening(true);
    try {
      onTerminal(await api.openTerminal({ cwd, ...(text ? { prompt: text } : {}) }));
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
      setOpening(false);
    }
  };

  const send = async () => {
    if (useClaude) return openClaude();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const started = await run({ text }, text);
    if (!started) setDraft(text);
  };

  const regenerate = () => {
    const last = state.turns.at(-1);
    if (!last || running) return;
    dispatch({ type: "dropLast" });
    void run({ regenerate: true }, last.user);
  };

  const stop = () => {
    if (session) api.abort(session.id).catch(() => {});
  };

  const onDecide = (requestId: string, decision: Decision) => {
    dispatch({ type: "decide", requestId, decision });
    api.decide(requestId, decision).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : "Décision non transmise.");
    });
  };

  const changeProfile = async (next: ProfileInfo) => {
    setProfileId(next.id);
    if (!session) return;
    try {
      setSession(await api.updateSession(session.id, { profileId: next.id }));
      toast(`Profil : ${next.label}.`);
    } catch (error) {
      setProfileId(session.profileId);
      toast(error instanceof Error ? error.message : "Changement de profil impossible.");
    }
  };

  // Follow the answer while the reader stays at the bottom.
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state]);
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);

  const all = state.live ? [...state.turns, state.live] : state.turns;
  const empty = all.length === 0;
  const claudeMode = useClaude && !session;
  const available = claudeMode || (profile?.available ?? false);
  const native = !claudeMode && profile?.engine === "native";

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
          <h1>{title || session?.title || "Nouveau chat"}</h1>
          <p className="chat-cwd">
            <Icon name="folder" size={14} />
            <span>{session?.cwd ?? cwd}</span>
          </p>
        </div>
        <Menu
          label="Profil de la conversation"
          align="right"
          button={
            <>
              {claudeMode ? "Claude Code" : (profile?.label ?? "Choisir un profil")}
              <Icon name="chevronDown" size={16} />
            </>
          }
          buttonClass="btn btn-sm"
        >
          {(close) => (
            <>
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={!claudeMode && p.id === profileId}
                  className="menu-item"
                  disabled={!p.available || running}
                  onClick={() => {
                    setUseClaude(false);
                    void changeProfile(p);
                    close();
                  }}
                >
                  <span className="menu-text">
                    {p.label}
                    <small>
                      {p.available
                        ? p.engine === "acp"
                          ? "Agent"
                          : (p.model ?? "Modèle du compte")
                        : "Non lié"}
                    </small>
                  </span>
                  {!claudeMode && p.id === profileId && (
                    <span className="check">
                      <Icon name="check" size={16} />
                    </span>
                  )}
                </button>
              ))}
              {!session && claude && (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={claudeMode}
                  className="menu-item"
                  disabled={!claude.installed || running}
                  onClick={() => {
                    setUseClaude(true);
                    close();
                  }}
                >
                  <span className="menu-text">
                    Claude Code
                    <small>
                      {claude.installed ? "Votre compte Claude, dans un terminal" : "Non installé"}
                    </small>
                  </span>
                  {claudeMode && (
                    <span className="check">
                      <Icon name="check" size={16} />
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  close();
                  onOpenConnections();
                }}
              >
                <Icon name="key" size={18} />
                Gérer les connexions
              </button>
            </>
          )}
        </Menu>
      </header>

      <div
        className="thread"
        ref={thread}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {loadError ? (
          <div className="thread-inner">
            <Alert title="Conversation introuvable." text={loadError} />
          </div>
        ) : empty ? (
          <section className="welcome" aria-labelledby="welcome-title">
            <div>
              <LogoMark size={56} />
              <h2 id="welcome-title">Invoquez la réponse.</h2>
              <p className="welcome-lead">
                {claudeMode
                  ? "Claude Code s'ouvre dans un terminal, connecté à votre compte Claude."
                  : "Bonjour. Que voulez-vous explorer aujourd'hui ?"}
              </p>
            </div>
            <div className="suggestions" aria-label="Suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="chip"
                  onClick={() => setDraft(s.prompt)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {!session && (
              <div className="cwd-field">
                <label className="field-label" htmlFor="cwd">
                  Dossier de travail
                </label>
                <input
                  id="cwd"
                  className="input mono"
                  value={cwd}
                  spellCheck={false}
                  onChange={(e) => setCwd(e.target.value)}
                />
                <p className="hint">
                  {claudeMode
                    ? "Claude Code y travaille avec ses propres demandes d'accord. Connectez-vous dans Claude Code avec /login : envoke ne voit jamais vos identifiants."
                    : "L'assistant y lit les fichiers et y lance les commandes, toujours après votre accord."}
                </p>
              </div>
            )}
            {startError && (
              <Alert
                title={
                  claudeMode
                    ? "Impossible d'ouvrir Claude Code."
                    : "Impossible de démarrer la conversation."
                }
                text={startError}
              />
            )}
          </section>
        ) : (
          <div className="thread-inner">
            {all.map((turn, i) => (
              <TurnView
                key={turn.id}
                turn={turn}
                isLast={i === all.length - 1}
                canRegenerate={native && !running && available}
                onDecide={onDecide}
                onRegenerate={regenerate}
                onOpenConnections={onOpenConnections}
              />
            ))}
          </div>
        )}
      </div>

      {!available && profile && (
        <div className="composer-wrap">
          <div className="composer-alert">
            <Alert
              tone="warning"
              title={`${profile.label} n'est pas encore lié.`}
              text="Liez la clé API ou le compte correspondant pour discuter avec ce profil."
              action={{ label: "Ouvrir les connexions", onClick: onOpenConnections }}
            />
          </div>
        </div>
      )}
      <Composer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        onStop={stop}
        running={running}
        disabled={!available || opening}
        placeholder={
          claudeMode
            ? "Première demande à Claude Code (facultatif)…"
            : empty
              ? "Posez une question, demandez une tâche…"
              : "Répondre…"
        }
        mode={native ? mode : null}
        onModeChange={setMode}
        {...(claudeMode ? { allowEmpty: true, sendLabel: "Ouvrir Claude Code" } : {})}
      />
    </>
  );
}

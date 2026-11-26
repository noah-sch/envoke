import type { ClaudeCodeStatus, ProfileInfo, SessionRecord } from "@envoke/core/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Api, ApiError, readToken } from "./api.ts";
import { ChatView } from "./components/ChatView.tsx";
import { ClaudeView } from "./components/ClaudeView.tsx";
import { Connections } from "./components/Connections.tsx";
import { LogoMark } from "./components/Logo.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ToastProvider, useToast } from "./components/Toast.tsx";

type View =
  { kind: "chat"; id: string | null } | { kind: "terminal"; id: string } | { kind: "connections" };

/** Routes live in the hash, so a reload keeps the open session: #/c/<id>, #/t/<id>, #/connexions. */
function parseRoute(hash: string): View {
  if (hash === "#/connexions") return { kind: "connections" };
  const terminal = /^#\/t\/([\w-]+)$/.exec(hash);
  if (terminal?.[1]) return { kind: "terminal", id: terminal[1] };
  const match = /^#\/c\/([\w-]+)$/.exec(hash);
  return { kind: "chat", id: match?.[1] ?? null };
}

function hashOf(view: View): string {
  if (view.kind === "connections") return "#/connexions";
  if (view.kind === "terminal") return `#/t/${view.id}`;
  return view.id ? `#/c/${view.id}` : "#/";
}

function go(view: View) {
  const hash = hashOf(view);
  if (window.location.hash !== hash) window.location.hash = hash;
}

function Gate({ reason }: { reason: string }) {
  return (
    <main className="gate">
      <div className="card">
        <LogoMark size={48} />
        <h1>Ouvrez envoke depuis l&#39;application.</h1>
        <p>{reason}</p>
        <p>
          En développement : lancez <code>pnpm serve</code> et ouvrez l&#39;adresse du champ{" "}
          <code>open</code>.
        </p>
      </div>
    </main>
  );
}

function Shell({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const api = useMemo(() => new Api(token), [token]);
  const [view, setView] = useState<View>(() => parseRoute(window.location.hash));
  /** Bumped on navigation only: creating a chat keeps the same view, mid-stream. */
  const [instance, setInstance] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [defaultProfile, setDefaultProfile] = useState("");
  const [home, setHome] = useState("");
  const [linked, setLinked] = useState({ count: 0, total: 0 });
  const [claude, setClaude] = useState<ClaudeCodeStatus | null>(null);
  /** A new chat opened from the Connections page starts on Claude Code. */
  const [claudeFirst, setClaudeFirst] = useState(false);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  const toast = useToast();
  /** Startup failures block the app; later ones (a refresh, a rename) only show a toast. */
  const fail = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else setFatal(error instanceof Error ? error.message : String(error));
    },
    [onUnauthorized],
  );
  const soft = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else toast(error instanceof Error ? error.message : String(error));
    },
    [onUnauthorized, toast],
  );

  const refreshSessions = useCallback(() => {
    api.sessions().then(setSessions, soft);
  }, [api, soft]);

  const refreshConnections = useCallback(() => {
    api.profiles().then(({ profiles: p, defaultProfile: d }) => {
      setProfiles(p);
      setDefaultProfile(d);
    }, soft);
    api.claudeCode().then(setClaude, soft);
    api.connections().then((list) => {
      const usable = list.filter((c) => c.allowed);
      setLinked({
        count: usable.filter((c) => c.linked && c.access !== "none").length,
        total: usable.length,
      });
    }, soft);
  }, [api, soft]);

  useEffect(() => {
    Promise.all([api.info(), api.profiles(), api.sessions()]).then(([info, p, s]) => {
      setHome(info.home);
      setProfiles(p.profiles);
      setDefaultProfile(p.defaultProfile);
      setSessions(s);
      setReady(true);
    }, fail);
    refreshConnections();
  }, [api, fail, refreshConnections]);

  useEffect(() => {
    const onHash = () => {
      setView(parseRoute(window.location.hash));
      setInstance((i) => i + 1);
      setDrawer(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (fatal) return <Gate reason={fatal} />;
  if (!ready) return null;

  const activeId = view.kind === "connections" ? null : view.id;
  // A new chat starts where the last one worked.
  const defaultCwd = sessions[0]?.cwd ?? home;

  return (
    <div className={`app ${drawer ? "drawer-open" : ""}`}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        connectionsOpen={view.kind === "connections"}
        linked={linked}
        onSelect={(id) =>
          go(
            sessions.find((s) => s.id === id)?.kind === "terminal"
              ? { kind: "terminal", id }
              : { kind: "chat", id },
          )
        }
        onNew={() => {
          setClaudeFirst(false);
          go({ kind: "chat", id: null });
          setDrawer(false);
        }}
        onRename={(id, title) => void api.updateSession(id, { title }).then(refreshSessions, soft)}
        onDelete={(id) =>
          void api.deleteSession(id).then(() => {
            if (id === activeId) go({ kind: "chat", id: null });
            refreshSessions();
          }, soft)
        }
        onOpenConnections={() => go({ kind: "connections" })}
      />
      <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <main className="main">
        <div className="panel">
          {view.kind === "connections" ? (
            <Connections
              api={api}
              claude={claude}
              onChange={refreshConnections}
              onOpenClaude={() => {
                setClaudeFirst(true);
                go({ kind: "chat", id: null });
              }}
              onToggleSidebar={() => setDrawer(true)}
            />
          ) : view.kind === "terminal" ? (
            <ClaudeView
              key={`${instance}-${view.id}`}
              api={api}
              session={sessions.find((s) => s.id === view.id)}
              onChanged={refreshSessions}
              onToggleSidebar={() => setDrawer(true)}
              onUnauthorized={onUnauthorized}
            />
          ) : (
            <ChatView
              key={instance}
              api={api}
              sessionId={view.id}
              title={sessions.find((s) => s.id === view.id)?.title}
              profiles={profiles}
              defaultProfile={defaultProfile}
              defaultCwd={defaultCwd}
              claude={claude}
              startWithClaude={claudeFirst}
              onTerminal={(s) => {
                setSessions((list) => [s, ...list]);
                go({ kind: "terminal", id: s.id });
              }}
              onCreated={(s) => {
                setSessions((list) => [s, ...list]);
                setView({ kind: "chat", id: s.id });
                history.replaceState(null, "", `#/c/${s.id}`);
              }}
              onChanged={refreshSessions}
              onOpenConnections={() => go({ kind: "connections" })}
              onToggleSidebar={() => setDrawer(true)}
            />
          )}
        </div>
      </main>
    </div>
  );
}

export function App() {
  const [token, setToken] = useState(() => readToken());
  const [reason, setReason] = useState(
    "Cette fenêtre a besoin du jeton que le moteur local crée à son démarrage.",
  );
  const onUnauthorized = useCallback(() => {
    sessionStorage.clear();
    setReason("Le jeton de cette fenêtre n'est plus valide : le moteur a redémarré.");
    setToken(null);
  }, []);
  return (
    <ToastProvider>
      {token ? <Shell token={token} onUnauthorized={onUnauthorized} /> : <Gate reason={reason} />}
    </ToastProvider>
  );
}

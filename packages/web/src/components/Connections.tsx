import type { ClaudeCodeStatus, ConnectionStatus } from "@envoke/core/types";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { Alert } from "./Thread.tsx";
import { useToast } from "./Toast.tsx";

function StatusBadge({ c }: { c: ConnectionStatus }) {
  if (!c.allowed) return <span className="badge warning">Non autorisée</span>;
  if (c.linked) return <span className="badge success">{c.type === "acp" ? "Prêt" : "Liée"}</span>;
  return <span className="badge">{c.type === "acp" ? "Clé manquante" : "Non liée"}</span>;
}

function describe(c: ConnectionStatus, labels: Map<string, string>): string {
  if (c.type === "chatgpt") {
    if (!c.allowed) return "Abonnement ChatGPT : pas encore ouvert dans ce produit.";
    return c.account ? `Connecté : ${c.account}` : "Utilise les limites de votre forfait ChatGPT.";
  }
  if (c.type === "acp") {
    if (c.access === "subscription") {
      return c.allowed
        ? "Se connecte avec le compte de l'agent."
        : "Abonnement de l'agent : pas encore ouvert dans ce produit.";
    }
    return `Agent qui utilise la clé : ${c.requires.map((id) => labels.get(id) ?? id).join(", ")}.`;
  }
  if (c.access === "none") return "Modèle local, aucune clé nécessaire.";
  return "Clé API, facturée par le fournisseur.";
}

function KeyRow({
  c,
  labels,
  api,
  onChange,
}: {
  c: ConnectionStatus;
  labels: Map<string, string>;
  api: Api;
  onChange: () => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.linkKey(c.id, key);
      setKey("");
      toast(`${c.label} liée.`);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    try {
      await api.unlink(c.id);
      toast(`${c.label} déliée.`);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row">
      <div className="row-main">
        <p className="row-name">{c.label}</p>
        <p className="row-desc">{describe(c, labels)}</p>
        {error && <p className="row-desc row-error">{error}</p>}
      </div>
      <div className="row-actions">
        <StatusBadge c={c} />
        {c.access === "api_key" &&
          (c.linked ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => void unlink()}
            >
              Délier
            </button>
          ) : (
            <form className="key-form" onSubmit={(e) => void link(e)}>
              <label className="sr-only" htmlFor={`key-${c.id}`}>
                Clé API {c.label}
              </label>
              <input
                id={`key-${c.id}`}
                className="input mono"
                type="password"
                autoComplete="off"
                placeholder="Collez votre clé"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || key.trim().length < 8}
              >
                Lier
              </button>
            </form>
          ))}
      </div>
    </div>
  );
}

function ChatGPTRow({
  c,
  labels,
  api,
  onChange,
}: {
  c: ConnectionStatus;
  labels: Map<string, string>;
  api: Api;
  onChange: () => void;
}) {
  const toast = useToast();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(poll.current), []);

  const connect = async () => {
    setError(null);
    try {
      const { authorizeUrl } = await api.beginLogin(c.id);
      window.open(authorizeUrl, "_blank", "noopener");
      setWaiting(true);
      const started = Date.now();
      poll.current = window.setInterval(async () => {
        const detail = await api.connection(c.id).catch(() => null);
        const state = detail?.login?.state;
        if (state === "linked" || state === "error" || Date.now() - started > 5 * 60_000) {
          window.clearInterval(poll.current);
          setWaiting(false);
          if (state === "linked") toast("Compte ChatGPT connecté.");
          else setError(detail?.login?.error ?? "Connexion expirée : recommencez.");
          onChange();
        }
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="row">
      <div className="row-main">
        <p className="row-name">{c.label}</p>
        <p className="row-desc">{describe(c, labels)}</p>
        {waiting && (
          <p className="row-desc">
            Terminez la connexion dans la page ouverte par votre navigateur…
          </p>
        )}
        {error && <p className="row-desc row-error">{error}</p>}
      </div>
      <div className="row-actions">
        <StatusBadge c={c} />
        {c.allowed &&
          (c.linked ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                void api.unlink(c.id).then(({ revoked }) => {
                  toast(
                    revoked
                      ? "Compte déconnecté."
                      : "Déconnecté ici ; révocation distante non confirmée.",
                  );
                  onChange();
                })
              }
            >
              Déconnecter
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={waiting}
              onClick={() => void connect()}
            >
              Se connecter avec ChatGPT
            </button>
          ))}
      </div>
    </div>
  );
}

const CLAUDE_CODE_SETUP = "https://code.claude.com/docs/en/setup";

/** The user's own Claude Code: envoke runs it in a terminal and never touches the sign-in. */
function ClaudeCodeRow({
  status,
  onOpen,
}: {
  status: ClaudeCodeStatus | null;
  onOpen: () => void;
}) {
  const installed = status?.installed ?? false;
  return (
    <div className="row">
      <div className="row-main">
        <p className="row-name">Claude Code · votre compte Claude</p>
        <p className="row-desc">
          {installed
            ? "S'ouvre dans un terminal intégré, avec votre abonnement. Connectez-vous dans Claude Code (/login) : envoke ne voit jamais vos identifiants."
            : "Installez Claude Code sur cet ordinateur pour l'utiliser avec votre abonnement Claude."}
        </p>
        {status?.path && <p className="row-desc mono">{status.path}</p>}
      </div>
      <div className="row-actions">
        <span className={`badge ${installed ? "success" : ""}`}>
          {installed ? "Installé" : "Non installé"}
        </span>
        {installed ? (
          <button type="button" className="btn btn-sm" onClick={onOpen}>
            Ouvrir Claude Code
          </button>
        ) : (
          <a
            className="btn btn-sm"
            href={CLAUDE_CODE_SETUP}
            target="_blank"
            rel="noopener noreferrer"
          >
            Installer
          </a>
        )}
      </div>
    </div>
  );
}

function AgentRow({
  c,
  labels,
  onOpen,
}: {
  c: ConnectionStatus;
  labels: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const missing = c.requires.filter(Boolean);
  return (
    <div className="row">
      <div className="row-main">
        <p className="row-name">{c.label}</p>
        <p className="row-desc">{describe(c, labels)}</p>
      </div>
      <div className="row-actions">
        <StatusBadge c={c} />
        {c.allowed && !c.linked && missing[0] && (
          <button type="button" className="btn btn-sm" onClick={() => onOpen(missing[0]!)}>
            Lier {labels.get(missing[0]) ?? missing[0]}
          </button>
        )}
      </div>
    </div>
  );
}

export function Connections({
  api,
  claude,
  onChange,
  onOpenClaude,
  onToggleSidebar,
}: {
  api: Api;
  claude: ClaudeCodeStatus | null;
  onChange: () => void;
  onOpenClaude: () => void;
  onToggleSidebar: () => void;
}) {
  const [list, setList] = useState<ConnectionStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    api
      .connections()
      .then(setList, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    onChange();
  };
  useEffect(() => {
    api
      .connections()
      .then(setList, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);

  const labels = new Map((list ?? []).map((c) => [c.id, c.label]));
  const focusKey = (id: string) => document.getElementById(`key-${id}`)?.focus();
  const keys = list?.filter((c) => c.type !== "chatgpt" && c.type !== "acp") ?? [];
  const accounts = list?.filter((c) => c.type === "chatgpt") ?? [];
  const agents = list?.filter((c) => c.type === "acp") ?? [];

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
          <h1>Connexions</h1>
        </div>
      </header>
      <div className="page">
        <div className="page-inner">
          <div>
            <h2 className="page-title">Vos comptes et vos clés</h2>
            <p className="page-lead">
              Liez une clé API ou un compte pour discuter avec un modèle. Les clés restent dans le
              trousseau de votre système, jamais dans l&#39;application.
            </p>
          </div>
          {error && <Alert title="Connexions indisponibles." text={error} />}
          {list && (
            <>
              <section className="section" aria-labelledby="accounts-title">
                <h2 id="accounts-title">Comptes</h2>
                <div className="card">
                  <ClaudeCodeRow status={claude} onOpen={onOpenClaude} />
                  {accounts.map((c) => (
                    <ChatGPTRow key={c.id} c={c} labels={labels} api={api} onChange={refresh} />
                  ))}
                </div>
              </section>
              <section className="section" aria-labelledby="keys-title">
                <h2 id="keys-title">Clés API</h2>
                <div className="card">
                  {keys.map((c) => (
                    <KeyRow key={c.id} c={c} labels={labels} api={api} onChange={refresh} />
                  ))}
                </div>
              </section>
              <section className="section" aria-labelledby="agents-title">
                <h2 id="agents-title">Agents</h2>
                <div className="card">
                  {agents.map((c) => (
                    <AgentRow key={c.id} c={c} labels={labels} onOpen={focusKey} />
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

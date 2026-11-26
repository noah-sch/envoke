import type { SessionRecord } from "@envoke/core/types";
import { useMemo, useState, type KeyboardEvent } from "react";
import { groupByDate } from "../dates.ts";
import { Icon } from "../icons.tsx";
import { Wordmark } from "./Logo.tsx";
import { Menu } from "./Menu.tsx";

const labelOf = (s: SessionRecord) =>
  s.title || (s.kind === "terminal" ? "Claude Code" : "Nouveau chat");

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

function SessionItem({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionRecord;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [title, setTitle] = useState(session.title);
  const label = labelOf(session);

  if (mode === "edit") {
    const save = () => {
      const next = title.trim();
      if (next && next !== session.title) onRename(next);
      setMode("view");
    };
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") {
        setTitle(session.title);
        setMode("view");
      }
    };
    return (
      <div className="item">
        <label className="sr-only" htmlFor={`rename-${session.id}`}>
          Nouveau titre
        </label>
        <input
          id={`rename-${session.id}`}
          className="input item-edit"
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onKey}
          onBlur={save}
        />
      </div>
    );
  }

  if (mode === "confirm") {
    return (
      <div className="item" role="group" aria-label={`Supprimer ${label}`}>
        <span className="item-label">Supprimer ?</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMode("view")}>
          Annuler
        </button>
        <button type="button" className="btn btn-sm danger" onClick={onDelete} autoFocus>
          Supprimer
        </button>
      </div>
    );
  }

  return (
    <div className={`item ${active ? "active" : ""}`}>
      <button
        type="button"
        className="item-link"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        title={session.kind === "terminal" ? `${label} · Claude Code` : label}
      >
        {session.kind === "terminal" && (
          <span className="item-kind" aria-label="Claude Code :">
            <Icon name="terminal" size={16} />
          </span>
        )}
        {label}
      </button>
      <Menu
        label={`Actions pour ${label}`}
        align="right"
        buttonClass="icon-btn plain"
        button={<Icon name="more" />}
      >
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                close();
                setTitle(session.title);
                setMode("edit");
              }}
            >
              <Icon name="pencil" size={18} />
              Renommer
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item danger"
              onClick={() => {
                close();
                setMode("confirm");
              }}
            >
              <Icon name="trash" size={18} />
              Supprimer
            </button>
          </>
        )}
      </Menu>
    </div>
  );
}

export function Sidebar({
  sessions,
  activeId,
  connectionsOpen,
  linked,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onOpenConnections,
}: {
  sessions: SessionRecord[];
  activeId: string | null;
  connectionsOpen: boolean;
  linked: { count: number; total: number };
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenConnections: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = fold(query.trim());
    const matching = q ? sessions.filter((s) => fold(labelOf(s)).includes(q)) : sessions;
    return groupByDate(matching);
  }, [sessions, query]);

  return (
    <nav className="sidebar" aria-label="Historique des conversations">
      <div className="sidebar-head">
        <Wordmark />
        <button
          type="button"
          className="icon-btn"
          aria-label={searching ? "Fermer la recherche" : "Rechercher une conversation"}
          aria-pressed={searching}
          onClick={() => {
            setSearching((v) => !v);
            setQuery("");
          }}
        >
          <Icon name={searching ? "close" : "search"} />
        </button>
      </div>

      {searching && (
        <div className="search">
          <label className="sr-only" htmlFor="search">
            Rechercher
          </label>
          <input
            id="search"
            className="input"
            placeholder="Rechercher…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
          />
        </div>
      )}

      <button type="button" className="btn btn-outline" onClick={onNew}>
        <Icon name="plus" size={18} />
        Nouveau chat
      </button>

      <div className="sidebar-list">
        {groups.length === 0 && (
          <p className="sidebar-empty">
            {query ? "Aucune conversation trouvée." : "Vos conversations apparaîtront ici."}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.label} className="group" aria-label={g.label}>
            <h2 className="group-title">{g.label}</h2>
            {g.items.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                active={!connectionsOpen && s.id === activeId}
                onSelect={() => onSelect(s.id)}
                onRename={(title) => onRename(s.id, title)}
                onDelete={() => onDelete(s.id)}
              />
            ))}
          </section>
        ))}
      </div>

      <div className="sidebar-foot">
        <button
          type="button"
          className={`account ${connectionsOpen ? "active" : ""}`}
          aria-current={connectionsOpen ? "page" : undefined}
          onClick={onOpenConnections}
        >
          <span className="account-icon">
            <Icon name="key" size={18} />
          </span>
          <span>
            <span className="account-name">Connexions</span>
            <span className="account-meta">
              {linked.count} liée{linked.count > 1 ? "s" : ""} sur {linked.total}
            </span>
          </span>
        </button>
      </div>
    </nav>
  );
}

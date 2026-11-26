import type { Decision } from "@envoke/core/types";
import { useState } from "react";
import { Icon, type IconName } from "../icons.tsx";
import type { ToolBlock } from "../turns.ts";

/** By lower-cased tool name: envoke's tools, ACP kinds and Claude Code's tools. */
const ICONS: Record<string, IconName> = {
  bash: "terminal",
  execute: "terminal",
  read_file: "file",
  read: "file",
  write_file: "pencil",
  write: "pencil",
  edit_file: "pencil",
  edit: "pencil",
  multiedit: "pencil",
  notebookedit: "pencil",
  grep: "search",
  glob: "search",
  webfetch: "bolt",
};

const DECIDED: Record<Decision, string> = {
  allow_once: "Autorisé une fois",
  allow_always: "Autorisé pour cette conversation",
  deny: "Refusé",
};

function permissionText(name: string, who: string): string {
  const tool = name.toLowerCase();
  if (tool === "bash" || tool === "execute")
    return `${who} veut exécuter cette commande dans le dossier de travail.`;
  if (/^(write|edit|multiedit|notebookedit)/.test(tool)) return `${who} veut modifier ce fichier.`;
  return `${who} veut effectuer cette action.`;
}

export function ToolCard({
  block,
  onDecide,
  agent = "envoke",
}: {
  block: ToolBlock;
  onDecide: (requestId: string, decision: Decision) => void;
  /** Who asks, in the permission sentence. */
  agent?: string;
}) {
  const pending = block.permission?.state === "pending";
  const [open, setOpen] = useState(false);
  const hasOutput = block.output !== null && block.output.trim() !== "";
  const state =
    block.status === "running" ? (
      <span className="tool-state">
        {pending ? "En attente" : <span className="spinner" aria-label="En cours" />}
      </span>
    ) : block.status === "error" ? (
      <span className="tool-state error">
        <Icon name="close" size={16} />
        Échec
      </span>
    ) : (
      <span className="tool-state done">
        <Icon name="check" size={16} />
        Fait
      </span>
    );

  return (
    <div className={`tool ${pending ? "pending" : ""}`}>
      <button
        type="button"
        className="tool-head"
        disabled={!hasOutput}
        aria-expanded={hasOutput ? open : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-icon">
          <Icon name={ICONS[block.name.toLowerCase()] ?? "bolt"} size={16} />
        </span>
        <span className="tool-title" title={block.title}>
          {block.title}
        </span>
        {state}
        {hasOutput && <Icon name={open ? "chevronDown" : "chevronRight"} size={16} />}
      </button>

      {pending && block.permission && (
        <div className="permission">
          <p>{permissionText(block.name, agent)}</p>
          <pre>{block.title}</pre>
          <div className="permission-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onDecide(block.permission!.requestId, "allow_once")}
            >
              Autoriser une fois
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onDecide(block.permission!.requestId, "allow_always")}
            >
              Toujours pour cette conversation
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onDecide(block.permission!.requestId, "deny")}
            >
              Refuser
            </button>
          </div>
        </div>
      )}
      {!pending && block.permission && (
        <div className="decided">{DECIDED[block.permission.state as Decision]}</div>
      )}
      {open && hasOutput && <pre className="tool-output">{block.output}</pre>}
    </div>
  );
}

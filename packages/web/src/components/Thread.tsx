import type { Decision } from "@envoke/core/types";
import { Icon } from "../icons.tsx";
import { answerText, type Block, type Turn } from "../turns.ts";
import { Avatar } from "./Logo.tsx";
import { Markdown } from "./Markdown.tsx";
import { useCopy } from "./Toast.tsx";
import { ToolCard } from "./ToolCard.tsx";

const STOP_NOTES: Partial<Record<NonNullable<Turn["stop"]>, string>> = {
  aborted: "Réponse interrompue.",
  max_tokens: "Réponse coupée : limite de longueur atteinte.",
  refusal: "Le modèle a refusé de répondre à cette demande.",
  max_iterations: "Arrêté après 50 étapes : reformulez ou découpez la demande.",
};

const LINK_CODES = new Set(["auth_required", "auth", "policy"]);

export function Alert({
  title,
  text,
  tone = "danger",
  action,
}: {
  title: string;
  text?: string;
  tone?: "danger" | "warning";
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className={`alert ${tone === "warning" ? "warning" : ""}`} role="alert">
      <span className="alert-icon">
        <Icon name={tone === "warning" ? "warning" : "close"} size={18} />
      </span>
      <div className="alert-body">
        <p className="alert-title">{title}</p>
        {text && <p className="alert-text">{text}</p>}
        {action && (
          <button type="button" className="btn btn-sm" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

function BlockView({
  block,
  agent,
  onDecide,
  onOpenConnections,
}: {
  block: Block;
  agent: string | undefined;
  onDecide: (requestId: string, decision: Decision) => void;
  onOpenConnections: () => void;
}) {
  switch (block.kind) {
    case "text":
      return <Markdown text={block.text} />;
    case "thinking":
      return (
        <details className="thinking">
          <summary>
            Réflexion
            <Icon name="chevronDown" size={16} />
          </summary>
          <p className="thinking-text">{block.text}</p>
        </details>
      );
    case "tool":
      return <ToolCard block={block} onDecide={onDecide} {...(agent ? { agent } : {})} />;
    case "error":
      return (
        <Alert
          title={LINK_CODES.has(block.code) ? "Connexion requise." : "La réponse n'a pas abouti."}
          text={block.message}
          {...(LINK_CODES.has(block.code)
            ? { action: { label: "Ouvrir les connexions", onClick: onOpenConnections } }
            : {})}
        />
      );
  }
}

export function TurnView({
  turn,
  isLast,
  canRegenerate,
  agent,
  onDecide,
  onRegenerate,
  onOpenConnections,
}: {
  turn: Turn;
  isLast: boolean;
  canRegenerate: boolean;
  /** Name shown while writing and in permission questions (default: envoke). */
  agent?: string;
  onDecide: (requestId: string, decision: Decision) => void;
  onRegenerate: () => void;
  onOpenConnections: () => void;
}) {
  const copy = useCopy();
  const streaming = turn.status === "streaming";
  const waiting = turn.blocks.some((b) => b.kind === "tool" && b.permission?.state === "pending");
  const answer = answerText(turn);
  const note = turn.stop ? STOP_NOTES[turn.stop] : undefined;

  return (
    <article className="turn" aria-busy={streaming}>
      {turn.user && <div className="user-msg">{turn.user}</div>}
      <div className="assistant">
        <Avatar />
        <div className="assistant-body">
          {turn.blocks.map((block, i) => (
            <BlockView
              key={block.kind === "tool" ? block.id : i}
              block={block}
              agent={agent}
              onDecide={onDecide}
              onOpenConnections={onOpenConnections}
            />
          ))}
          {streaming && !waiting && (
            <div className="typing" role="status">
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {agent ?? "envoke"} rédige…
            </div>
          )}
          {!streaming && note && <p className="stop-note">{note}</p>}
          {!streaming && (answer || (isLast && canRegenerate)) && (
            <div className="turn-actions">
              {answer && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Copier la réponse"
                  onClick={() => copy(answer, "Réponse copiée.")}
                >
                  <Icon name="copy" />
                </button>
              )}
              {isLast && canRegenerate && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Régénérer la réponse"
                  onClick={onRegenerate}
                >
                  <Icon name="regenerate" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

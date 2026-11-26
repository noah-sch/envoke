import type { Effort } from "@envoke/core/types";
import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "../icons.tsx";
import { Menu } from "./Menu.tsx";

export const MODES: { effort: Effort; label: string; hint: string }[] = [
  { effort: "low", label: "Rapide", hint: "Réponse directe, peu de réflexion" },
  { effort: "medium", label: "Équilibré", hint: "Le bon compromis au quotidien" },
  { effort: "high", label: "Approfondi", hint: "Plus de réflexion, plus de temps" },
];

export function modeOf(effort: Effort | null): Effort {
  if (effort === "low" || effort === "medium") return effort;
  return effort ? "high" : "medium";
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  disabled,
  placeholder,
  mode,
  onModeChange,
  allowEmpty = false,
  sendLabel = "Envoyer",
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  disabled: boolean;
  placeholder: string;
  /** Null when the profile's engine has no response modes (ACP agents). */
  mode: Effort | null;
  onModeChange: (effort: Effort) => void;
  /** Sending with nothing typed is allowed (opening Claude Code). */
  allowEmpty?: boolean;
  sendLabel?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);

  // Grows with its content up to the CSS max-height.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const canSend = !disabled && !running && (allowEmpty || value.trim() !== "");
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canSend) onSend();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const current = MODES.find((m) => m.effort === mode);

  return (
    <div className="composer-wrap">
      <form className="composer" onSubmit={submit}>
        <label htmlFor="message" className="sr-only">
          Message
        </label>
        <textarea
          id="message"
          ref={area}
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <div className="composer-bar">
          {current && (
            <Menu
              label="Mode de réponse"
              direction="up"
              button={
                <>
                  Mode {current.label.toLowerCase()}
                  <Icon name="chevronDown" size={16} />
                </>
              }
              buttonClass="btn btn-sm"
            >
              {(close) =>
                MODES.map((m) => (
                  <button
                    key={m.effort}
                    type="button"
                    role="menuitemradio"
                    aria-checked={m.effort === mode}
                    className="menu-item"
                    onClick={() => {
                      onModeChange(m.effort);
                      close();
                    }}
                  >
                    <span className="menu-text">
                      {m.label}
                      <small>{m.hint}</small>
                    </span>
                    {m.effort === mode && (
                      <span className="check">
                        <Icon name="check" size={16} />
                      </span>
                    )}
                  </button>
                ))
              }
            </Menu>
          )}
          <div className="end">
            {running ? (
              <button
                type="button"
                className="icon-btn"
                aria-label="Arrêter la réponse"
                onClick={onStop}
              >
                <Icon name="stop" />
              </button>
            ) : (
              <button
                type="submit"
                className="icon-btn primary"
                aria-label={sendLabel}
                disabled={!canSend}
              >
                <Icon name="send" />
              </button>
            )}
          </div>
        </div>
      </form>
      <p className="composer-hint">Entrée pour envoyer · Maj + Entrée pour aller à la ligne</p>
    </div>
  );
}

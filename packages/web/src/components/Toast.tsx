import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icons.tsx";

const ToastContext = createContext<(message: string) => void>(() => {});

export function useToast(): (message: string) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setMessage(text);
    timer.current = window.setTimeout(() => setMessage(null), 2400);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite">
        {message && (
          <div className="toast" role="status">
            <span className="ok">
              <Icon name="check" size={18} />
            </span>
            {message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

/** Copies text and confirms with a toast. */
export function useCopy(): (text: string, confirmation: string) => void {
  const toast = useToast();
  return useCallback(
    (text: string, confirmation: string) => {
      navigator.clipboard.writeText(text).then(
        () => toast(confirmation),
        () => toast("Copie impossible dans ce navigateur."),
      );
    },
    [toast],
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "../components/ui/Icon";

export type ToastTone = "success" | "error" | "info" | "warning";

export interface ToastInput {
  tone: ToastTone;
  title: string;
  message?: string;
  /** `0` keeps the toast on screen until it is dismissed. */
  durationMs?: number;
}

export interface Toast extends Required<Omit<ToastInput, "message">> {
  id: string;
  message?: string;
}

export interface ToastContextValue {
  toasts: readonly Toast[];
  push(toast: ToastInput): string;
  dismiss(id: string): void;
  clear(): void;
}

const TONE_ICONS: Record<ToastTone, IconName> = {
  success: "check",
  error: "alertTriangle",
  info: "info",
  warning: "warning",
};

/** How long each tone stays on screen. Failures never expire on their own. */
const TONE_DURATIONS: Record<ToastTone, number> = {
  success: 5000,
  info: 6000,
  warning: 9000,
  error: 0,
};

const MAX_VISIBLE = 4;

const ToastContext = createContext<ToastContextValue | null>(null);

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `toast-${sequence}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput): string => {
      const id = nextId();
      const durationMs = input.durationMs ?? TONE_DURATIONS[input.tone];
      const toast: Toast = {
        id,
        tone: input.tone,
        title: input.title,
        durationMs,
        ...(input.message === undefined ? {} : { message: input.message }),
      };
      setToasts((current) => [toast, ...current].slice(0, MAX_VISIBLE));
      if (durationMs > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), durationMs),
        );
      }
      return id;
    },
    [dismiss],
  );

  const clear = useCallback((): void => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, push, dismiss, clear }),
    [clear, dismiss, push, toasts],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications">
        <ol className="toast-list" aria-live="polite" aria-relevant="additions text">
          {toasts.map((toast) => (
            <li key={toast.id} className={`toast toast--${toast.tone}`}>
              <Icon name={TONE_ICONS[toast.tone]} size={20} className="toast__icon" />
              <div className="toast__body">
                <p className="toast__title">{toast.title}</p>
                {toast.message !== undefined && toast.message.length > 0 ? (
                  <p className="toast__message">{toast.message}</p>
                ) : null}
              </div>
              <button
                type="button"
                className="toast__dismiss"
                onClick={() => dismiss(toast.id)}
              >
                <Icon name="x" size={16} />
                <span className="visually-hidden">Dismiss this message</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </ToastContext.Provider>
  );
}

/** Raises a message. Throws outside the provider so a missing toast cannot pass silently. */
export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (value === null) {
    throw new Error(
      "useToast must be used inside <ToastProvider>. Mount ToastProvider above the router in " +
        "src/main.tsx; components rendered on their own, such as in a test, need their own " +
        "provider too.",
    );
  }
  return value;
}

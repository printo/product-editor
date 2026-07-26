'use client';

import { useEffect, useRef } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export type ToastTone = 'success' | 'error';

interface ToastProps {
  /** Null hides the toast. Setting a message (re)starts the dismiss timer. */
  message: string | null;
  tone: ToastTone;
  onDismiss: () => void;
  /** Auto-dismiss delay in ms. */
  duration?: number;
}

const TONE = {
  success: {
    Icon: CheckCircle2,
    shell: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    icon: 'text-emerald-600',
    bar: 'bg-emerald-500',
  },
  error: {
    Icon: AlertCircle,
    shell: 'bg-rose-50 border-rose-200 text-rose-800',
    icon: 'text-rose-600',
    bar: 'bg-rose-500',
  },
} as const;

/**
 * Auto-dismissing toast. Replaces the inline feedback banners, which pushed the
 * page content down and could sit off-screen when the action was triggered from
 * a scrolled-down row.
 *
 * onDismiss is held in a ref so an inline arrow at the call site doesn't reset
 * the timer on every parent re-render — with the callback in the dep array a
 * chatty parent could keep the toast alive indefinitely.
 */
export const Toast = ({ message, tone, onDismiss, duration = 5000 }: ToastProps) => {
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => dismissRef.current(), duration);
    return () => clearTimeout(timer);
  }, [message, duration]);

  if (!message) return null;
  const { Icon, shell, icon, bar } = TONE[tone];

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-auto relative overflow-hidden w-[min(92vw,420px)] border rounded-xl shadow-lg animate-in fade-in slide-in-from-bottom-3 ${shell}`}
    >
      <div className="flex items-start gap-3 p-4 pr-10">
        <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${icon}`} />
        <p className="text-sm font-medium break-words">{message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="absolute top-3 right-3 p-1 rounded-md opacity-60 hover:opacity-100 transition-opacity"
      >
        <X className="w-4 h-4" />
      </button>
      <div
        className={`absolute bottom-0 left-0 h-0.5 ${bar}`}
        style={{ animation: `toast-countdown ${duration}ms linear forwards` }}
      />
      <style jsx global>{`
        @keyframes toast-countdown {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
};

/** Fixed bottom-right stack. Sits above the z-[2000] header. */
export const ToastStack = ({ children }: { children: React.ReactNode }) => (
  <div className="fixed bottom-4 right-4 z-[3000] flex flex-col gap-2 items-end pointer-events-none">
    {children}
  </div>
);

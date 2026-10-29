'use client';

import { clsx } from 'clsx';
import type { OrientationChoice } from '@/lib/layout-orientation';

/**
 * Portrait / Landscape as a pill: the dashboard card's choice before the
 * editor opens, and the Create-a-template dialog's facing. Fixed before
 * anything is drawn, so a design is never half one way and half the other.
 * `locked` disables both with the reason as the tooltip; `disabled` one
 * side with its own.
 */
export function OrientationToggle({ value, onChange, locked = null, disabled = {}, title, size = 'sm', className }: {
  value: OrientationChoice | null;
  onChange: (choice: OrientationChoice) => void;
  locked?: string | null;
  disabled?: Partial<Record<OrientationChoice, string>>;
  title?: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Print orientation"
      title={locked ?? title ?? 'Portrait or landscape'}
      className={clsx('flex items-center rounded-full border border-indigo-100 bg-slate-50 p-0.5', locked && 'opacity-50', className)}
    >
      {(['portrait', 'landscape'] as const).map(choice => {
        const reason = locked ?? disabled[choice] ?? null;
        const pressed = !locked && value === choice;
        return (
          <button
            key={choice}
            type="button"
            disabled={Boolean(reason)}
            aria-pressed={pressed}
            title={reason ?? undefined}
            onClick={() => onChange(choice)}
            className={clsx(
              'flex-1 rounded-full font-black uppercase tracking-widest transition-colors disabled:cursor-not-allowed',
              size === 'sm' ? 'px-2 py-1 text-[10px]' : 'px-3 py-1.5 text-[11px]',
              pressed ? 'bg-indigo-600 text-white' : 'text-indigo-600 hover:bg-indigo-50 disabled:text-slate-400 disabled:hover:bg-transparent',
            )}
          >
            {choice}
          </button>
        );
      })}
    </div>
  );
}

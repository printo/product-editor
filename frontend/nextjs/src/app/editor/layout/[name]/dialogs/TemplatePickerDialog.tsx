'use client';

import { useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Check, LayoutTemplate as TemplateIcon, RefreshCw, X } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { templateColours, type LayoutTemplate } from '../template';

/**
 * The customer's template picker: the layout's published templates plus
 * "start blank". Picking one with cards already on the page asks first,
 * since the previous template's decoration on every card is replaced
 * (photos and the customer's own additions stay). With the template already
 * in force the same entry offers "Apply to all cards" for cards edited since.
 */
export function TemplatePickerDialog({ templates, activeTemplate, cardCount, firstStep, onPick, onClose }: {
  templates: LayoutTemplate[];
  activeTemplate: LayoutTemplate | null;
  /** Cards on the design right now, across every side. */
  cardCount: number;
  /** The embed's template_flow: picking (or skipping) is the first step. */
  firstStep: boolean;
  onPick: (template: LayoutTemplate | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{ template: LayoutTemplate | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useModalA11y(dialogRef, null, true);

  const choose = async (template: LayoutTemplate | null) => {
    const unchanged = (template?.id ?? null) === (activeTemplate?.id ?? null);
    if (cardCount > 0 && !pending) {
      // Re-applying the current template, or swapping, rewrites every card.
      setPending({ template });
      return;
    }
    if (unchanged && cardCount === 0) { onClose(); return; }
    setBusy(true);
    try {
      await onPick(template);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const confirmCopy = (() => {
    if (!pending) return null;
    const n = cardCount;
    const cards = n === 1 ? 'your card' : `your ${n} cards`;
    if (!pending.template) return `Remove the template from ${cards}? Your photos and anything you added yourself stay.`;
    if (pending.template.id === activeTemplate?.id) {
      return `Apply "${pending.template.displayName}" to ${cards} again? Changes you made to its decoration are replaced; your photos and anything you added yourself stay.`;
    }
    return `Use "${pending.template.displayName}" on ${cards}? The current decoration is replaced; your photos and anything you added yourself stay.`;
  })();

  return (
    <div className="fixed inset-0 z-[2001] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose a template"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-start justify-between gap-4 p-6 pb-4 border-b border-slate-100">
          <div>
            <p className="text-sm font-black text-slate-900 uppercase tracking-tight">
              {firstStep ? 'Start with a template' : 'Templates'}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Ready-made decoration for this product. Every photo you add gets it; you can still change each card afterwards.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {pending ? (
          <div className="p-6 flex flex-col gap-5" role="alertdialog" aria-label="Confirm template change">
            <p className="text-xs text-slate-600 leading-relaxed">{confirmCopy}</p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => choose(pending.template)}
                disabled={busy}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50"
              >
                {busy ? 'Applying…' : pending.template ? 'Apply to all cards' : 'Remove template'}
              </button>
              <button
                onClick={() => setPending(null)}
                disabled={busy}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95"
              >
                Go back
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6 overflow-y-auto">
            {templates.length === 0 ? (
              <p className="text-xs text-slate-500">No templates for this product yet.</p>
            ) : (
              <ul className="grid grid-cols-2 sm:grid-cols-3 gap-4" aria-label="Templates">
                <li>
                  <button
                    onClick={() => choose(null)}
                    aria-pressed={!activeTemplate}
                    className={clsx(
                      'w-full text-left rounded-xl border-2 p-3 transition-all hover:border-indigo-300',
                      !activeTemplate ? 'border-indigo-500 bg-indigo-50/40' : 'border-slate-200',
                    )}
                  >
                    <div className="aspect-[4/3] rounded-lg border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center text-[10px] font-bold uppercase tracking-widest text-slate-400">
                      {firstStep ? 'Skip' : 'None'}
                    </div>
                    <p className="mt-2 text-[11px] font-black uppercase tracking-tight text-slate-800">Start blank</p>
                  </button>
                </li>
                {templates.map(t => {
                  const active = t.id === activeTemplate?.id;
                  const { bgColor } = templateColours(t, 'default');
                  return (
                    <li key={t.id}>
                      <button
                        onClick={() => choose(t)}
                        aria-pressed={active}
                        className={clsx(
                          'w-full text-left rounded-xl border-2 p-3 transition-all hover:border-indigo-300',
                          active ? 'border-indigo-500 bg-indigo-50/40' : 'border-slate-200',
                        )}
                      >
                        <div className="aspect-[4/3] rounded-lg overflow-hidden border border-slate-200 flex items-center justify-center" style={{ backgroundColor: bgColor }}>
                          {t.thumbnailUrl ? (
                            <img src={t.thumbnailUrl} alt="" className="w-full h-full object-contain" loading="lazy" />
                          ) : (
                            <TemplateIcon className="w-6 h-6 text-slate-400" />
                          )}
                        </div>
                        <p className="mt-2 text-[11px] font-black uppercase tracking-tight text-slate-800 flex items-center gap-1.5">
                          {active && <Check className="w-3.5 h-3.5 text-indigo-600" />}
                          <span className="truncate">{t.displayName}</span>
                          {active && cardCount > 0 && <RefreshCw className="w-3 h-3 text-slate-400 ml-auto shrink-0" aria-label="Apply to all cards" />}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

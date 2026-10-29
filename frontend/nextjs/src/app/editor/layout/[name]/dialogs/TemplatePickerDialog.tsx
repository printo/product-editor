'use client';

import { useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Check, LayoutTemplate as TemplateIcon, Play, RefreshCw, X } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { templateColours, type LayoutTemplate } from '../layout-template';

/**
 * The customer's template picker: the layout's published templates plus
 * "start blank". Picking one with cards already on the page asks first,
 * since the previous template's decoration on every card is replaced
 * (photos and the customer's own additions stay). With the template already
 * in force the same entry offers "Apply to all cards" for cards edited since.
 *
 * The grid is a row of equal cards, the way printo.in's "Choose a Design"
 * page shows designs (Kannan, 2026-10-29): the thumbnail sits inside a
 * fixed box, so a portrait and a landscape template make cards of one
 * height, the name is centred under it, and "Start blank" is the first
 * card. Customers never see the template id.
 */

/** One card's shell: white, bordered, the whole card a button. */
const cardClass = (selected: boolean) => clsx(
  'w-full h-full flex flex-col items-center rounded-lg border bg-white p-3 text-center transition-all hover:border-indigo-300 hover:shadow-md',
  selected ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-200',
);
const thumbClass = 'w-full aspect-[4/3] rounded-lg bg-slate-50 flex items-center justify-center overflow-hidden';
const nameClass = 'mt-3 w-full text-[12px] font-bold text-slate-800 leading-snug line-clamp-2 min-h-[2.6em] flex items-start justify-center gap-1.5';
export function TemplatePickerDialog({ templates, activeTemplate, cardCount, firstStep, onPick, onClose }: {
  templates: LayoutTemplate[];
  activeTemplate: LayoutTemplate | null;
  /** Cards on the design right now, across every side. */
  cardCount: number;
  /** Picking (or skipping) is the first step on a fresh design: the close
   *  control reads "Start blank" and does that, so there is no third outcome. */
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
        className="bg-white rounded-xl shadow-xl ring-1 ring-slate-900/5 w-full max-w-4xl max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200"
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
          {firstStep ? (
            <button
              onClick={() => choose(null)}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              Start blank
            </button>
          ) : (
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {pending ? (
          <div className="p-6 flex flex-col gap-5" role="alertdialog" aria-label="Confirm template change">
            <p className="text-xs text-slate-600 leading-relaxed">{confirmCopy}</p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => choose(pending.template)}
                disabled={busy}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50"
              >
                {busy ? 'Applying…' : pending.template ? 'Apply to all cards' : 'Remove template'}
              </button>
              <button
                onClick={() => setPending(null)}
                disabled={busy}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all active:scale-95"
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
              <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4" aria-label="Templates">
                <li>
                  <button onClick={() => choose(null)} aria-pressed={!activeTemplate} className={cardClass(!activeTemplate)}>
                    <div className={thumbClass}>
                      <span className="w-12 h-12 rounded-lg border-2 border-indigo-600 text-indigo-600 flex items-center justify-center" aria-hidden="true">
                        <Play className="w-5 h-5 fill-current" />
                      </span>
                    </div>
                    <p className={nameClass}>Start blank</p>
                  </button>
                </li>
                {templates.map(t => {
                  const active = t.id === activeTemplate?.id;
                  const { bgColor } = templateColours(t, 'default');
                  return (
                    <li key={t.id}>
                      <button onClick={() => choose(t)} aria-pressed={active} className={cardClass(active)}>
                        <div className={thumbClass}>
                          {t.thumbnailUrl ? (
                            <img src={t.thumbnailUrl} alt="" className="max-w-full max-h-full object-contain p-2" loading="lazy" />
                          ) : (
                            <span className="w-3/4 h-3/4 rounded-md border border-slate-200 flex items-center justify-center" style={{ backgroundColor: bgColor }}>
                              <TemplateIcon className="w-6 h-6 text-slate-400" />
                            </span>
                          )}
                        </div>
                        <p className={nameClass}>
                          {active && <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0 mt-0.5" />}
                          <span>{t.displayName}</span>
                          {active && cardCount > 0 && <RefreshCw className="w-3 h-3 text-slate-400 shrink-0 mt-0.5" aria-label="Apply to all cards" />}
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

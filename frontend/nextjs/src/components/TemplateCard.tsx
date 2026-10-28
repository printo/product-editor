'use client';

/**
 * One template on the ops lists (every template, or one layout's): the
 * thumbnail, name, id and status, the notes a page adds (where it was
 * designed, what it is offered on), the "layout changed" and "no longer the
 * same size" flags, and the actions. Shared by both pages so their cards
 * cannot drift; the delete confirm lives here for the same reason.
 */
import { useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { Edit2, Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useModalA11y } from '@/lib/use-modal-a11y';
import type { LayoutTemplate } from '@/app/editor/layout/[name]/layout-template';

/** A template as GET /api/ops/templates serves it. */
export type OpsTemplate = LayoutTemplate & {
  status: 'draft' | 'published';
  layoutChanged?: boolean;
  homeRetired?: boolean;
  alsoOnMismatch?: string[];
};

/** Editing always happens on the home layout's route, whatever list the card is on. */
export function templateEditHref(t: Pick<OpsTemplate, 'id' | 'layoutName'>): string {
  return `/editor/layouts/templates/${encodeURIComponent(t.layoutName)}/${encodeURIComponent(t.id)}`;
}

const FLAG = 'text-[10px] font-bold uppercase tracking-tight text-amber-700 bg-amber-50 px-2 py-1 rounded-md';

interface TemplateCardProps {
  template: OpsTemplate;
  busy: boolean;
  /** Under the name: where it was designed, what it is offered on. */
  notes?: ReactNode;
  /** Between Edit and Publish, e.g. the per-layout page's Duplicate. */
  extraActions?: ReactNode;
  onSetStatus: (t: OpsTemplate, status: 'draft' | 'published') => void;
  onDelete: (t: OpsTemplate) => void;
  /** How the page names a layout, when it knows the display names. */
  displayNameOf?: (name: string) => string;
}

export function TemplateCard({ template: t, busy, notes, extraActions, onSetStatus, onDelete, displayNameOf = n => n }: TemplateCardProps) {
  const mismatch = t.alsoOnMismatch ?? [];
  const published = t.status === 'published';
  return (
    <li className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden flex flex-col">
      <div className="aspect-[4/3] bg-slate-50 border-b border-slate-100 flex items-center justify-center">
        {t.thumbnailUrl ? (
          <img src={t.thumbnailUrl} alt="" className="w-full h-full object-contain" />
        ) : (
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">No preview yet</span>
        )}
      </div>
      <div className="p-4 flex flex-col gap-2 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-900 truncate">{t.displayName}</p>
            <p className="text-[10px] text-slate-400 font-mono truncate">{t.id}</p>
          </div>
          <span className={clsx(
            'shrink-0 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-tight',
            published ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500',
          )}>
            {t.status}
          </span>
        </div>
        {notes}
        {t.homeRetired && <p className={FLAG}>Home layout retired: customers no longer see this template anywhere</p>}
        {t.layoutChanged && !t.homeRetired && <p className={FLAG}>Layout changed, please review</p>}
        {mismatch.length > 0 && (
          <p className={FLAG} title={mismatch.map(displayNameOf).join(', ')}>
            No longer the same size: {mismatch.map(displayNameOf).join(', ')}
          </p>
        )}
        <div className="mt-auto pt-2 flex items-center gap-1">
          <Link
            href={templateEditHref(t)}
            className="p-2 text-[#F17A26] hover:bg-[#F17A26]/10 rounded-lg transition-all inline-flex items-center gap-1 text-[10px] font-bold uppercase"
            title="Edit template"
            aria-label={`Edit ${t.displayName}`}
          >
            <Edit2 className="w-4 h-4" /> Edit
          </Link>
          {extraActions}
          <button
            type="button"
            onClick={() => onSetStatus(t, published ? 'draft' : 'published')}
            disabled={busy}
            className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-all disabled:opacity-30 inline-flex items-center gap-1 text-[10px] font-bold uppercase"
            title={published ? 'Unpublish: hide from customers' : 'Publish: show to customers'}
            aria-label={published ? `Unpublish ${t.displayName}` : `Publish ${t.displayName}`}
          >
            {published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            {published ? 'Unpublish' : 'Publish'}
          </button>
          <button
            type="button"
            onClick={() => onDelete(t)}
            disabled={busy}
            className="p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-all disabled:opacity-30 ml-auto"
            title="Delete template"
            aria-label={`Delete ${t.displayName}`}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </li>
  );
}

interface DeleteTemplateDialogProps {
  template: OpsTemplate | null;
  onConfirm: (t: OpsTemplate) => void;
  onCancel: () => void;
}

export function DeleteTemplateDialog({ template, onConfirm, onCancel }: DeleteTemplateDialogProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useModalA11y(ref, onCancel, template !== null);
  if (!template) return null;
  return (
    <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div ref={ref} tabIndex={-1} role="alertdialog" aria-modal="true" aria-label="Delete template" className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-7 outline-none">
        <p className="text-sm font-black text-slate-900 uppercase tracking-tight mb-2">Delete &ldquo;{template.displayName}&rdquo;?</p>
        <p className="text-xs text-slate-500 leading-relaxed mb-6">
          Customers stop seeing it on every layout it is offered on. Designs that already use it keep their decoration.
        </p>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => onConfirm(template)} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-rose-600 text-white rounded-xl hover:bg-rose-700 transition-all active:scale-95">Delete</button>
          <button type="button" onClick={onCancel} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95">Cancel</button>
        </div>
      </div>
    </div>
  );
}

'use client';

/**
 * Ops: the templates of one layout. New, Edit, Duplicate, Publish /
 * Unpublish, Delete. Lives under /editor/layouts so proxy.ts keeps it to the
 * Ops tier; every call goes through the internal proxy, whose path gate
 * makes the writes ops-only.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Copy, Edit2, Eye, EyeOff, Loader2, Plus, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useHeader } from '@/context/HeaderContext';
import { isTemplateId, slugFromName } from '@/app/editor/layout/[name]/template-authoring';
import type { LayoutTemplate } from '@/app/editor/layout/[name]/layout-template';

type OpsTemplate = LayoutTemplate & { status: 'draft' | 'published'; layoutChanged?: boolean };

const API = '/api/internal/proxy';

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { detail?: string }).detail || fallback;
}

export default function LayoutTemplatesPage() {
  const params = useParams<{ layout: string }>();
  const layoutName = String(params?.layout ?? '');
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();

  const [templates, setTemplates] = useState<OpsTemplate[]>([]);
  const [layoutDisplayName, setLayoutDisplayName] = useState<string>(layoutName);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<OpsTemplate | null>(null);

  useEffect(() => {
    setTitle('Templates');
    setDescription(`Ready-made decoration for ${layoutDisplayName}`);
    setCenterActions(null);
    setRightActions(
      <Link
        href="/editor/layouts"
        aria-label="Back to Layouts"
        className="flex items-center gap-1.5 p-2.5 md:px-3 md:py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-full md:rounded border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="hidden md:inline">Layouts</span>
      </Link>,
    );
    return () => { setTitle(''); setDescription(''); setCenterActions(null); setRightActions(null); };
  }, [layoutDisplayName, setTitle, setDescription, setCenterActions, setRightActions]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [listRes, layoutRes] = await Promise.all([
        fetch(`${API}/ops/templates?layout=${encodeURIComponent(layoutName)}`, { cache: 'no-store' }),
        fetch(`${API}/layouts/${encodeURIComponent(layoutName)}`),
      ]);
      if (!listRes.ok) throw new Error(await readError(listRes, `Could not load templates (HTTP ${listRes.status}).`));
      const data = await listRes.json();
      setTemplates(Array.isArray(data?.templates) ? data.templates : []);
      if (layoutRes.ok) {
        const layout = await layoutRes.json();
        if (typeof layout?.displayName === 'string' && layout.displayName) setLayoutDisplayName(layout.displayName);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load templates.');
    } finally {
      setLoading(false);
    }
  }, [layoutName]);

  useEffect(() => { if (layoutName) void load(); }, [layoutName, load]);
  // Arriving from a scrolled Layouts page, the router keeps the scroll and the
  // fixed top bar covers the New template button; start at the top.
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const act = async (id: string, run: () => Promise<Response>, failure: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await run();
      if (!res.ok) throw new Error(await readError(res, failure));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : failure);
    } finally {
      setBusyId(null);
    }
  };

  const setStatus = (t: OpsTemplate, status: 'draft' | 'published') => act(
    t.id,
    () => fetch(`${API}/ops/templates/${encodeURIComponent(t.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    }),
    status === 'published' ? 'Could not publish the template.' : 'Could not unpublish the template.',
  );

  const duplicate = (t: OpsTemplate) => {
    const taken = new Set(templates.map(x => x.id));
    const base = slugFromName(`${t.id}-copy`) || 'copy';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    if (!isTemplateId(id)) { setError('Could not make an id for the copy.'); return; }
    return act(
      t.id,
      () => fetch(`${API}/ops/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, layout: layoutName, display_name: `Copy of ${t.displayName}`, status: 'draft', decoration: t.decoration }),
      }),
      'Could not duplicate the template.',
    );
  };

  const remove = (t: OpsTemplate) => {
    setDeleteConfirm(null);
    return act(t.id, () => fetch(`${API}/ops/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' }), 'Could not delete the template.');
  };

  return (
    <div className="min-h-screen bg-transparent">
      <main className="max-w-[1100px] mx-auto px-4 sm:px-8 pt-3 pb-12">
        <div className="flex items-center justify-between gap-4 mb-5">
          <p className="text-xs text-slate-500">
            Customers pick a template, add photos, and every card gets its decoration. Drafts stay hidden until published.
          </p>
          <Link
            href={`/editor/layouts/templates/${encodeURIComponent(layoutName)}/new`}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-[11px] font-bold uppercase tracking-tight rounded-lg hover:bg-indigo-700 shadow-sm transition-all shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> New template
          </Link>
        </div>

        {error && (
          <div role="alert" className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl">{error}</div>
        )}

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="w-7 h-7 animate-spin text-indigo-600" /></div>
        ) : templates.length === 0 ? (
          <div className="text-center py-20 text-slate-500 bg-white rounded-2xl border shadow-sm text-sm">
            No templates for this layout yet.
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-label="Templates">
            {templates.map(t => {
              const busy = busyId === t.id;
              return (
                <li key={t.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden flex flex-col">
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
                        t.status === 'published' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500',
                      )}>
                        {t.status}
                      </span>
                    </div>
                    {t.layoutChanged && (
                      <p className="text-[10px] font-bold uppercase tracking-tight text-amber-700 bg-amber-50 px-2 py-1 rounded-md">
                        Layout changed, please review
                      </p>
                    )}
                    <div className="mt-auto pt-2 flex items-center gap-1">
                      <Link
                        href={`/editor/layouts/templates/${encodeURIComponent(layoutName)}/${encodeURIComponent(t.id)}`}
                        className="p-2 text-[#F17A26] hover:bg-[#F17A26]/10 rounded-lg transition-all inline-flex items-center"
                        title="Edit template"
                        aria-label={`Edit ${t.displayName}`}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Link>
                      <button
                        onClick={() => duplicate(t)}
                        disabled={busy}
                        className="p-2 text-[#64318E] hover:bg-[#64318E]/10 rounded-lg transition-all disabled:opacity-30"
                        title="Duplicate template"
                        aria-label={`Duplicate ${t.displayName}`}
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setStatus(t, t.status === 'published' ? 'draft' : 'published')}
                        disabled={busy}
                        className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-all disabled:opacity-30 inline-flex items-center gap-1 text-[10px] font-bold uppercase"
                        title={t.status === 'published' ? 'Unpublish: hide from customers' : 'Publish: show to customers'}
                        aria-label={t.status === 'published' ? `Unpublish ${t.displayName}` : `Publish ${t.displayName}`}
                      >
                        {t.status === 'published' ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        {t.status === 'published' ? 'Unpublish' : 'Publish'}
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(t)}
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
            })}
          </ul>
        )}
      </main>

      {deleteConfirm && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div role="alertdialog" aria-modal="true" aria-label="Delete template" className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-7">
            <p className="text-sm font-black text-slate-900 uppercase tracking-tight mb-2">Delete &ldquo;{deleteConfirm.displayName}&rdquo;?</p>
            <p className="text-xs text-slate-500 leading-relaxed mb-6">
              Customers stop seeing it. Designs that already use it keep their decoration.
            </p>
            <div className="flex items-center gap-3">
              <button onClick={() => remove(deleteConfirm)} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-rose-600 text-white rounded-xl hover:bg-rose-700 transition-all active:scale-95">Delete</button>
              <button onClick={() => setDeleteConfirm(null)} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

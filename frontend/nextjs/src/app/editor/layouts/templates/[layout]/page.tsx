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
import { ArrowLeft, Copy, LayoutTemplate as TemplateIcon, Loader2, Plus } from 'lucide-react';
import { useHeader } from '@/context/HeaderContext';
import { readError } from '@/lib/read-error';
import { isTemplateId, slugFromName, type TemplateCandidate } from '@/app/editor/layout/[name]/template-authoring';
import { DeleteTemplateDialog, TemplateCard, type OpsTemplate } from '@/components/TemplateCard';

const API = '/api/internal/proxy';

export default function LayoutTemplatesPage() {
  const params = useParams<{ layout: string }>();
  const layoutName = String(params?.layout ?? '');
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();

  const [templates, setTemplates] = useState<OpsTemplate[]>([]);
  const [layoutNames, setLayoutNames] = useState<Map<string, string>>(new Map());
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
      <div className="flex items-center gap-2">
        <Link
          href="/editor/layouts/templates"
          aria-label="All templates"
          className="flex items-center gap-1.5 p-2.5 md:px-3 md:py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-full md:rounded border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
        >
          <TemplateIcon className="w-3.5 h-3.5" />
          <span className="hidden md:inline">All templates</span>
        </Link>
        <Link
          href="/editor/layouts"
          aria-label="Back to Layouts"
          className="flex items-center gap-1.5 p-2.5 md:px-3 md:py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-full md:rounded border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Layouts</span>
        </Link>
      </div>,
    );
    return () => { setTitle(''); setDescription(''); setCenterActions(null); setRightActions(null); };
  }, [layoutDisplayName, setTitle, setDescription, setCenterActions, setRightActions]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [listRes, layoutRes, candidatesRes] = await Promise.all([
        fetch(`${API}/ops/templates?layout=${encodeURIComponent(layoutName)}`, { cache: 'no-store' }),
        fetch(`${API}/layouts/${encodeURIComponent(layoutName)}`),
        fetch(`${API}/ops/templates/candidates`, { cache: 'no-store' }),
      ]);
      if (!listRes.ok) throw new Error(await readError(listRes, `Could not load templates (HTTP ${listRes.status}).`));
      const data = await listRes.json();
      setTemplates(Array.isArray(data?.templates) ? data.templates : []);
      if (layoutRes.ok) {
        const layout = await layoutRes.json();
        if (typeof layout?.displayName === 'string' && layout.displayName) setLayoutDisplayName(layout.displayName);
      }
      if (candidatesRes.ok) {
        // Only for naming the other layouts a template is designed on or offered on.
        const cands = await candidatesRes.json().catch(() => null);
        const list: TemplateCandidate[] = Array.isArray(cands?.layouts) ? cands.layouts : [];
        setLayoutNames(new Map(list.map(c => [c.name, c.displayName])));
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
      // The copy lives on the same home layout as the original: its
      // decoration is in percent of that canvas, and it is offered on the
      // same other layouts, minus any the server would now refuse.
      () => fetch(`${API}/ops/templates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id, layout: t.layoutName, display_name: `Copy of ${t.displayName}`, status: 'draft',
          decoration: t.decoration, also_on: (t.alsoOn ?? []).filter(n => !(t.alsoOnMismatch ?? []).includes(n)),
        }),
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
            {templates.map(t => (
              <TemplateCard
                key={t.id}
                template={t}
                busy={busyId === t.id}
                displayNameOf={name => layoutNames.get(name) ?? name}
                notes={(t.layoutName !== layoutName || (t.alsoOn?.length ?? 0) > 0) && (
                  <p className="text-[10px] text-slate-500">
                    {t.layoutName !== layoutName
                      ? <>Designed on <span className="font-semibold text-slate-700">{layoutNames.get(t.layoutName) ?? t.layoutName}</span>, offered here too</>
                      : <>Also offered on {t.alsoOn!.length} other {t.alsoOn!.length === 1 ? 'layout' : 'layouts'}</>}
                  </p>
                )}
                extraActions={(
                  <button
                    type="button"
                    onClick={() => duplicate(t)}
                    disabled={busyId === t.id}
                    className="p-2 text-[#64318E] hover:bg-[#64318E]/10 rounded-lg transition-all disabled:opacity-30"
                    title="Duplicate template"
                    aria-label={`Duplicate ${t.displayName}`}
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                )}
                onSetStatus={setStatus}
                onDelete={setDeleteConfirm}
              />
            ))}
          </ul>
        )}
      </main>

      <DeleteTemplateDialog template={deleteConfirm} onConfirm={remove} onCancel={() => setDeleteConfirm(null)} />
    </div>
  );
}

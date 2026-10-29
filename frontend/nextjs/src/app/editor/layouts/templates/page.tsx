'use client';

/**
 * Ops: every template, whatever layout it was authored on, with the size it
 * is keyed on (its home layout's window box), the way it faces and the
 * layouts it is offered on. Create a template picks the size, then Portrait
 * or Landscape, then the home layout to design on; the size is read from
 * that layout's photo windows, never typed, and a layout drawn the other
 * way opens turned a quarter turn, as a customer order in that orientation
 * sees it. Ticking the other same-size layouts happens in the authoring
 * page, where each can be previewed first. Lives under /editor/layouts so proxy.ts keeps it to
 * the Ops tier; every call goes through the internal proxy, whose path gate
 * makes the writes ops-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Plus, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { useHeader } from '@/context/HeaderContext';
import { readError } from '@/lib/read-error';
import { useModalA11y } from '@/lib/use-modal-a11y';
import {
  NO_PRINT_AREAS_KEY, drawnFacing, groupBySize, layoutsInFacing, pairKey, sizeLabel, type BoxFacing, type SizeGroup, type TemplateCandidate,
} from '@/app/editor/layout/[name]/template-authoring';
import { DeleteTemplateDialog, OfferedOn, TemplateCard, type OpsTemplate } from '@/components/TemplateCard';
import { OrientationToggle } from '@/components/ui/OrientationToggle';

const API = '/api/internal/proxy';
/** A filter value that names a size group rather than one layout. */
const SIZE_FILTER = 'size:';

export default function AllTemplatesPage() {
  const router = useRouter();
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();

  const [templates, setTemplates] = useState<OpsTemplate[]>([]);
  const [candidates, setCandidates] = useState<TemplateCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<OpsTemplate | null>(null);
  // One dropdown: a size group ("size:<key>") or one layout.
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  // Create asks for the size first, then the way it faces, then which layout
  // of that size to design on (turned when it is drawn the other way).
  const [createSize, setCreateSize] = useState('');
  const [createFacing, setCreateFacing] = useState<BoxFacing | null>(null);
  const [createLayout, setCreateLayout] = useState('');

  const createRef = useRef<HTMLDivElement | null>(null);
  const closeCreate = useCallback(() => setCreating(false), []);
  const closeDelete = useCallback(() => setDeleteConfirm(null), []);
  useModalA11y(createRef, closeCreate, creating);

  useEffect(() => {
    setTitle('Templates');
    setDescription('Every template, the size it is keyed on, and the layouts it is offered on');
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
  }, [setTitle, setDescription, setCenterActions, setRightActions]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [listRes, candidatesRes] = await Promise.all([
        fetch(`${API}/ops/templates`, { cache: 'no-store' }),
        fetch(`${API}/ops/templates/candidates`, { cache: 'no-store' }),
      ]);
      if (!listRes.ok) throw new Error(await readError(listRes, `Could not load templates (HTTP ${listRes.status}).`));
      if (!candidatesRes.ok) throw new Error(await readError(candidatesRes, `Could not load the layouts (HTTP ${candidatesRes.status}).`));
      const list = await listRes.json();
      const cands = await candidatesRes.json();
      setTemplates(Array.isArray(list?.templates) ? list.templates : []);
      setCandidates(Array.isArray(cands?.layouts) ? cands.layouts : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Arriving from a scrolled Layouts page, the router keeps the scroll and the
  // fixed top bar covers the toolbar; start at the top.
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const byName = useMemo(() => new Map(candidates.map(c => [c.name, c])), [candidates]);
  const groups = useMemo(() => groupBySize(candidates), [candidates]);
  const displayNameOf = useCallback((name: string) => byName.get(name)?.displayName ?? name, [byName]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter(t => {
      const home = byName.get(t.layoutName);
      if (filter.startsWith(SIZE_FILTER)) {
        if ((pairKey(home?.windowKey) ?? NO_PRINT_AREAS_KEY) !== filter.slice(SIZE_FILTER.length)) return false;
      } else if (filter && t.layoutName !== filter && !(t.alsoOn ?? []).includes(filter)) {
        return false;
      }
      if (q && !`${t.displayName} ${t.id}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [templates, byName, filter, query]);

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

  const remove = (t: OpsTemplate) => {
    setDeleteConfirm(null);
    return act(t.id, () => fetch(`${API}/ops/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' }), 'Could not delete the template.');
  };

  // Sizes a template can be keyed on: groups with print areas.
  const sizeGroups = useMemo(() => groups.filter(g => g.key !== NO_PRINT_AREAS_KEY), [groups]);
  const createGroup = sizeGroups.find(g => g.key === createSize) ?? null;
  // A square size faces either way and gets no toggle.
  const facingChoice = createGroup && !createGroup.facings.includes('square') ? createFacing : null;
  const createLayouts = useMemo(
    () => (createGroup ? (facingChoice ? layoutsInFacing(createGroup, facingChoice) : createGroup.layouts.map(layout => ({ layout, turned: false }))) : []),
    [createGroup, facingChoice],
  );
  const cannotTurn = createGroup && facingChoice ? createGroup.layouts.length - createLayouts.length : 0;

  // The way a size faces by default: the way its first layout is drawn.
  const defaultFacing = (g: SizeGroup | undefined): BoxFacing | null => {
    if (!g || g.facings.includes('square')) return null;
    const drawn = g.layouts[0] ? drawnFacing(g.layouts[0]) : null;
    return drawn && g.facings.includes(drawn) ? drawn : g.facings[0] ?? null;
  };
  const firstLayoutFor = (g: SizeGroup | undefined, facing: BoxFacing | null) =>
    (g ? (facing ? layoutsInFacing(g, facing)[0]?.layout.name : g.layouts[0]?.name) : undefined) ?? '';

  const openCreate = () => {
    const first = sizeGroups[0];
    const facing = defaultFacing(first);
    setCreateSize(first?.key ?? '');
    setCreateFacing(facing);
    setCreateLayout(firstLayoutFor(first, facing));
    setCreating(true);
  };

  const pickSize = (key: string) => {
    const g = sizeGroups.find(x => x.key === key);
    const facing = defaultFacing(g);
    setCreateSize(key);
    setCreateFacing(facing);
    setCreateLayout(firstLayoutFor(g, facing));
  };

  const pickFacing = (facing: BoxFacing) => {
    setCreateFacing(facing);
    setCreateLayout(firstLayoutFor(createGroup ?? undefined, facing));
  };

  // The authoring page pre-ticks every other layout of the size that can show
  // the facing (`tick=size`), so a template created by size reaches the whole
  // size unless ops untick one; `orientation` is the way it faces.
  const startCreate = () => {
    if (!createLayout) return;
    setCreating(false);
    const facing = facingChoice === 'portrait' || facingChoice === 'landscape' ? `&orientation=${facingChoice}` : '';
    router.push(`/editor/layouts/templates/${encodeURIComponent(createLayout)}/new?tick=size${facing}`);
  };

  const inputClass = 'px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';

  return (
    <div className="min-h-screen bg-transparent">
      <main className="max-w-[1100px] mx-auto px-4 sm:px-8 pt-3 pb-12">
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <label className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search templates"
              aria-label="Search templates"
              className={clsx(inputClass, 'w-full pl-9')}
            />
          </label>
          <select value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter by size or layout" className={inputClass}>
            <option value="">All layouts</option>
            {groups.map(g => (
              <optgroup key={g.key} label={g.label}>
                <option value={`${SIZE_FILTER}${g.key}`}>{g.key === NO_PRINT_AREAS_KEY ? 'Every layout without print areas' : 'Every layout of this size'}</option>
                {g.layouts.map(c => <option key={c.name} value={c.name}>{c.displayName}</option>)}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            onClick={openCreate}
            disabled={loading || sizeGroups.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-[11px] font-bold uppercase tracking-tight rounded-lg hover:bg-indigo-700 shadow-sm transition-all shrink-0 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Create a template
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-5">
          A template is keyed on the size of its home layout&rsquo;s print areas, bleed included, faces one way (portrait or landscape), and can
          be offered on every other layout with the same size; customers see it only on orders facing that way. Customers pick a template,
          add photos, and every card gets its decoration. Drafts stay hidden until published.
        </p>

        {error && (
          <div role="alert" className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl">{error}</div>
        )}

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="w-7 h-7 animate-spin text-indigo-600" /></div>
        ) : visible.length === 0 ? (
          <div className="text-center py-20 text-slate-500 bg-white rounded-2xl border shadow-sm text-sm">
            {templates.length === 0 ? 'No templates yet.' : 'No template matches these filters.'}
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-label="Templates">
            {visible.map(t => {
              const offeredOn = [t.layoutName, ...(t.alsoOn ?? [])];
              return (
                <TemplateCard
                  key={t.id}
                  template={t}
                  busy={busyId === t.id}
                  displayNameOf={displayNameOf}
                  notes={(
                    <dl className="text-[11px] text-slate-600 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                      <dt className="font-bold uppercase tracking-tight text-slate-400">Size</dt>
                      <dd>{sizeLabel({ printAreaBox: t.printAreaBox ?? null, bleedMm: t.bleedMm ?? 0 })}</dd>
                      <dt className="font-bold uppercase tracking-tight text-slate-400">On</dt>
                      <dd><OfferedOn names={offeredOn} displayNameOf={displayNameOf} /></dd>
                    </dl>
                  )}
                  onSetStatus={setStatus}
                  onDelete={setDeleteConfirm}
                />
              );
            })}
          </ul>
        )}
      </main>

      <DeleteTemplateDialog template={deleteConfirm} onConfirm={remove} onCancel={closeDelete} />

      {creating && (
        <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div ref={createRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Create a template" className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-7 outline-none">
            <p className="text-sm font-black text-slate-900 uppercase tracking-tight mb-1">Create a template</p>
            <p className="text-xs text-slate-500 leading-relaxed mb-4">
              Pick the size (the print areas plus their bleed) and which way it faces. The template is designed on one layout of that size
              and offered on every layout of that size for orders facing that way; you can untick any of them after previewing.
            </p>
            <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500 mb-4">
              Size
              <select
                id="create-template-size"
                value={createSize}
                onChange={e => pickSize(e.target.value)}
                className={clsx(inputClass, 'normal-case tracking-normal')}
              >
                {sizeGroups.map(g => (
                  <option key={g.key} value={g.key}>
                    {g.label} · {g.layouts.length} {g.layouts.length === 1 ? 'layout' : 'layouts'}
                  </option>
                ))}
              </select>
            </label>
            {createGroup && !createGroup.facings.includes('square') && (
              <div className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500 mb-4">
                <span id="create-template-facing">Faces</span>
                <OrientationToggle
                  value={facingChoice === 'portrait' || facingChoice === 'landscape' ? facingChoice : null}
                  onChange={pickFacing}
                  size="md"
                  title="Which way the template faces: customers see it on orders facing that way"
                  disabled={Object.fromEntries((['portrait', 'landscape'] as const)
                    .filter(f => !createGroup.facings.includes(f))
                    .map(f => [f, `No layout of this size can be shown in ${f}`]))}
                />
                <span className="text-[10px] font-medium normal-case tracking-normal text-slate-400">
                  A layout drawn the other way opens turned a quarter turn, as a customer ordering {facingChoice ?? 'it that way'} sees it.
                </span>
              </div>
            )}
            <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500 mb-6">
              Design it on
              <select
                id="create-template-layout"
                value={createLayout}
                onChange={e => setCreateLayout(e.target.value)}
                disabled={!createGroup || createLayouts.length === 0}
                className={clsx(inputClass, 'normal-case tracking-normal')}
              >
                {createLayouts.map(({ layout: c, turned }) => (
                  <option key={c.name} value={c.name}>
                    {c.displayName}{turned ? ' (opens turned)' : ''}{c.templateCount > 0 ? ` (${c.templateCount})` : ''}
                  </option>
                ))}
              </select>
              {createLayouts.length > 1 && (
                <span className="text-[10px] font-medium normal-case tracking-normal text-slate-400">
                  Any of these works as the drawing surface; the others are ticked for you on the next page.
                </span>
              )}
              {cannotTurn > 0 && (
                <span className="text-[10px] font-medium normal-case tracking-normal text-amber-700">
                  {cannotTurn} {cannotTurn === 1 ? 'layout' : 'layouts'} of this size cannot be turned and will not offer a {facingChoice} template.
                </span>
              )}
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={startCreate}
                disabled={!createLayout}
                className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50"
              >
                Continue
              </button>
              <button type="button" onClick={closeCreate} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all active:scale-95">Cancel</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

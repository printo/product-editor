'use client';

/**
 * Ops: author one template for a layout, in the customer's own canvas
 * editor on a blank card per side (optionally with a sample photo that is
 * never saved). What ops draw, minus the photos, is the decoration
 * (template-authoring.ts). Images from the Uploads tab are uploaded as
 * stickers at save; the thumbnail is the first side rendered without photos.
 *
 * Routes:
 *   /editor/layouts/templates/<layout>/new   → a new template
 *   /editor/layouts/templates/<layout>/<id>  → edit that template
 *
 * Under /editor/layouts, so proxy.ts keeps it to the Ops tier; the internal
 * proxy's path gate makes the ops/templates writes ops-only.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Check, Image as ImageIcon, Layers, Loader2, PencilRuler, Save } from 'lucide-react';
import { useHeader } from '@/context/HeaderContext';
import { GoogleFontLinks, useGoogleFonts } from '@/components/GoogleFontLinks';
import { usePdfPageImport } from '@/components/use-pdf-page-import';
import { normalizeLayout, type NormalizedLayout } from '@/lib/layout-utils';
import { readError } from '@/lib/read-error';
import { DEFAULT_OVERLAY_FONT, pickerFonts } from '@/lib/overlay-fonts';
import { CanvasEditorModal } from '@/app/editor/layout/[name]/CanvasEditorModal';
import { renderCanvas } from '@/app/editor/layout/[name]/fabric-renderer';
import { useObjectUrls } from '@/app/editor/layout/[name]/useCanvasGeneration';
import type { CanvasItem, SurfaceState } from '@/app/editor/layout/[name]/types';
import { isLayoutTemplate, surfaceGeometry, type LayoutTemplate, type TemplateDecoration } from '@/app/editor/layout/[name]/layout-template';
import {
  authoredOnFor, blankCard, dataUrlToPngFile, decorationFromCards, isEmptyDecoration, isTemplateId, localImageOverlays,
  nearMissLayouts, sameBoxLayouts, sizeLabel, slugFromName, withoutPhotos, type TemplateCandidate,
} from '@/app/editor/layout/[name]/template-authoring';

const API = '/api/internal/proxy';

export default function TemplateEditorPage() {
  const router = useRouter();
  const params = useParams<{ layout: string; id: string }>();
  const layoutName = String(params?.layout ?? '');
  const routeId = String(params?.id ?? 'new');
  const isNew = routeId === 'new';
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();

  const [normalized, setNormalized] = useState<NormalizedLayout | null>(null);
  const [surfaces, setSurfaces] = useState<SurfaceState[]>([]);
  const [activeKey, setActiveKey] = useState<string>('default');
  const [editingCanvas, setEditingCanvas] = useState<CanvasItem | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  const [sample, setSample] = useState<File | null>(null);
  const [selectedFonts, setSelectedFonts] = useState<string[]>([DEFAULT_OVERLAY_FONT]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Sharing: every generic layout with its window box, the other layouts
  // this template is ticked for, and the one being previewed ('' = home).
  const [candidates, setCandidates] = useState<TemplateCandidate[]>([]);
  const [alsoOn, setAlsoOn] = useState<string[]>([]);
  const [previewOn, setPreviewOn] = useState('');
  const [previewSides, setPreviewSides] = useState<Array<{ key: string; label: string; dataUrl: string | null }> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const { fontsLoaded, loadGoogleFont } = useGoogleFonts();
  const { getFileUrl } = useObjectUrls();
  const { expandPdfPages, pdfPickerElement } = usePdfPageImport();
  const skipNextGenerateRef = useRef(false);
  const sampleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTitle('Template Editor');
    setDescription(isNew ? `New template for ${layoutName}` : `Editing ${routeId} on ${layoutName}`);
    setCenterActions(null);
    setRightActions(
      <Link
        href={`/editor/layouts/templates/${encodeURIComponent(layoutName)}`}
        aria-label="Back to Templates"
        className="flex items-center gap-1.5 p-2.5 md:px-3 md:py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-full md:rounded border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span className="hidden md:inline">Templates</span>
      </Link>,
    );
    return () => { setTitle(''); setDescription(''); setCenterActions(null); setRightActions(null); };
  }, [isNew, layoutName, routeId, setTitle, setDescription, setCenterActions, setRightActions]);

  useEffect(() => {
    new Set([DEFAULT_OVERLAY_FONT, ...selectedFonts]).forEach(f => loadGoogleFont(f));
  }, [selectedFonts, loadGoogleFont]);

  // Arriving from a scrolled Layouts page, the router keeps the scroll and the
  // fixed top bar covers the form; start at the top (window API in an effect).
  useEffect(() => { window.scrollTo(0, 0); }, []);

  // Load the layout, the fonts list and (when editing) the template.
  useEffect(() => {
    if (!layoutName) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [layoutRes, fontsRes, templateRes, candidatesRes] = await Promise.all([
          fetch(`${API}/layouts/${encodeURIComponent(layoutName)}`),
          fetch(`${API}/fonts`),
          isNew ? Promise.resolve(null) : fetch(`${API}/ops/templates/${encodeURIComponent(routeId)}`, { cache: 'no-store' }),
          fetch(`${API}/ops/templates/candidates`, { cache: 'no-store' }),
        ]);
        if (!layoutRes.ok) throw new Error(await readError(layoutRes, `Layout '${layoutName}' not found (HTTP ${layoutRes.status}).`));
        const item = await layoutRes.json();
        if (item.productType === 'calendar' || item.productType === 'book') {
          throw new Error('Templates are not available for calendars and books yet.');
        }
        let template: LayoutTemplate | null = null;
        if (templateRes) {
          if (!templateRes.ok) throw new Error(await readError(templateRes, `Template '${routeId}' not found (HTTP ${templateRes.status}).`));
          const data = await templateRes.json();
          if (!isLayoutTemplate(data)) throw new Error('The template could not be read.');
          if (data.layoutName !== layoutName) throw new Error(`Template '${routeId}' belongs to layout '${data.layoutName}'.`);
          template = data;
        }
        if (fontsRes.ok) {
          const fonts = await fontsRes.json().catch(() => null);
          const list = Array.isArray(fonts?.fonts) ? fonts.fonts : Array.isArray(fonts) ? fonts : [];
          if (list.length) setSelectedFonts(pickerFonts(list));
        }
        if (candidatesRes.ok) {
          const cands = await candidatesRes.json().catch(() => null);
          if (!cancelled) setCandidates(Array.isArray(cands?.layouts) ? cands.layouts : []);
        }
        if (cancelled) return;
        const norm = normalizeLayout(item);
        setNormalized(norm);
        const decoration: TemplateDecoration | null = template?.decoration ?? null;
        // Each side's card, drawn so the page shows the decoration at once.
        const sides = await Promise.all(norm.surfaces.map(async def => {
          const card = blankCard(def, decoration);
          const sideDef = { ...norm._raw, ...def, canvas: def.canvas, frames: def.frames };
          const dataUrl = decoration ? await renderCanvas(card, sideDef, getFileUrl, { thumbnail: true }).catch(() => null) : null;
          return { key: def.key, label: def.label, def, files: [], canvases: [{ ...card, dataUrl }], globalFitMode: 'cover' as const };
        }));
        if (cancelled) return;
        setSurfaces(sides);
        setActiveKey(norm.surfaces[0]?.key || 'default');
        if (template) {
          setDisplayName(template.displayName);
          setTemplateId(template.id);
          setIdTouched(true);
          setStatus(template.status === 'published' ? 'published' : 'draft');
          setAlsoOn(Array.isArray(template.alsoOn) ? template.alsoOn : []);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [layoutName, routeId, isNew, getFileUrl]);

  const activeSurface = surfaces.find(s => s.key === activeKey) ?? surfaces[0];
  const editorLayout = useMemo(() => activeSurface && normalized
    ? { ...normalized._raw, ...activeSurface.def, name: normalized.name, canvas: activeSurface.def.canvas, frames: activeSurface.def.frames }
    : null, [activeSurface, normalized]);

  const home = useMemo(() => candidates.find(c => c.name === layoutName) ?? null, [candidates, layoutName]);
  const sameBox = useMemo(() => sameBoxLayouts(candidates, layoutName), [candidates, layoutName]);
  const nearMisses = useMemo(() => nearMissLayouts(candidates, layoutName), [candidates, layoutName]);
  const previewName = candidates.find(c => c.name === previewOn)?.displayName ?? previewOn;
  const toggleAlsoOn = (name: string) => setAlsoOn(prev => (prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]));

  // "Preview on": the current, possibly unsaved, decoration drawn on another
  // layout with the same window box, placed the way the customer editor
  // will place it (centred on that layout's box; blankCard → placeSideOverlays).
  useEffect(() => {
    if (!previewOn || !normalized) { setPreviewSides(null); return; }
    let cancelled = false;
    (async () => {
      setPreviewLoading(true);
      try {
        const res = await fetch(`${API}/layouts/${encodeURIComponent(previewOn)}`);
        if (!res.ok) throw new Error(await readError(res, `Layout '${previewOn}' could not be loaded (HTTP ${res.status}).`));
        const other = normalizeLayout(await res.json());
        const decoration: TemplateDecoration = {
          surfaces: Object.fromEntries(surfaces.map(s => [s.key, {
            overlays: s.canvases[0].overlays, bgColor: s.canvases[0].bgColor, paperColor: s.canvases[0].paperColor,
          }])),
          authoredOn: authoredOnFor(layoutName, surfaces.map(s => ({ key: s.key, def: s.def }))),
        };
        const sides = await Promise.all(other.surfaces.map(async def => {
          const card = blankCard(def, decoration, sample, surfaceGeometry(def));
          const sideDef = { ...other._raw, ...def, canvas: def.canvas, frames: def.frames };
          const dataUrl = await renderCanvas(card, sideDef, getFileUrl, { thumbnail: true }).catch(() => null);
          return { key: def.key, label: def.label, dataUrl };
        }));
        if (!cancelled) setPreviewSides(sides);
      } catch (e) {
        if (!cancelled) {
          setPreviewSides(null);
          setError(e instanceof Error ? e.message : 'The preview could not be drawn.');
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [previewOn, normalized, surfaces, sample, layoutName, getFileUrl]);

  const openEditor = (key: string = activeKey) => {
    const s = surfaces.find(x => x.key === key);
    if (!s) return;
    setActiveKey(key);
    setEditingCanvas(s.canvases[0]);
  };

  // The modal writes the edited card back through this setter.
  const setActiveCanvases = (update: CanvasItem[] | ((prev: CanvasItem[]) => CanvasItem[])) => {
    setSurfaces(prev => prev.map(s => s.key !== activeKey ? s : {
      ...s, canvases: typeof update === 'function' ? update(s.canvases) : update,
    }));
  };

  // The side previews are redrawn with the sample in the frames (or without
  // it), so the page shows the decoration around a real photo at once.
  const pickSample = async (file: File | null) => {
    setSample(file);
    if (!normalized) return;
    const raw = normalized._raw;
    const next = await Promise.all(surfaces.map(async s => {
      const card: CanvasItem = {
        ...s.canvases[0],
        frames: s.canvases[0].frames.map(f => ({ ...f, originalFile: file, fillStyle: file ? 'blur' : undefined })),
        dataUrl: null,
      };
      const def = { ...raw, ...s.def, canvas: s.def.canvas, frames: s.def.frames };
      const dataUrl = await renderCanvas(card, def, getFileUrl, { thumbnail: true }).catch(() => null);
      return { ...s, canvases: [{ ...card, dataUrl }] };
    }));
    setSurfaces(next);
  };

  const save = async () => {
    if (!normalized) return;
    const id = (isNew ? templateId : routeId).trim();
    const name = displayName.trim();
    if (!name) { setError('Give the template a name.'); return; }
    if (!isTemplateId(id)) { setError('The id must be lowercase letters, digits and hyphens, e.g. retro-birthday.'); return; }
    setSaving(true);
    setError(null);
    try {
      // Images from the Uploads tab become stickers first.
      const stickerUrls = new Map<string, Map<number, string>>();
      for (const s of surfaces) {
        const urls = new Map<number, string>();
        for (const { index, file } of localImageOverlays(s.canvases[0])) {
          const form = new FormData();
          form.append('file', file, file.name.toLowerCase().endsWith('.png') ? file.name : `${file.name}.png`);
          const res = await fetch(`${API}/ops/templates/assets`, { method: 'POST', body: form });
          if (!res.ok) throw new Error(await readError(res, 'A sticker could not be uploaded. Stickers must be PNG files.'));
          urls.set(index, (await res.json()).url);
        }
        stickerUrls.set(s.key, urls);
      }
      const decoration = decorationFromCards(surfaces.map(s => ({ key: s.key, card: s.canvases[0] })), stickerUrls);
      if (isEmptyDecoration(decoration)) throw new Error('Add a background, text or a sticker before saving.');

      const form = new FormData();
      form.append('template_data', JSON.stringify({ id, layout: layoutName, display_name: name, status, decoration, also_on: alsoOn }));
      const first = surfaces[0];
      if (first) {
        const firstDef = { ...normalized._raw, ...first.def, canvas: first.def.canvas, frames: first.def.frames };
        const thumb = dataUrlToPngFile(await renderCanvas(withoutPhotos(first.canvases[0]), firstDef, getFileUrl, { thumbnail: true }));
        if (thumb) form.append('thumbnail', thumb);
      }
      const res = await fetch(`${API}/ops/templates/${encodeURIComponent(id)}`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await readError(res, `Save failed (HTTP ${res.status}).`));
      setSavedAt(Date.now());
      if (isNew) router.replace(`/editor/layouts/templates/${encodeURIComponent(layoutName)}/${encodeURIComponent(id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-8 text-zinc-500 text-sm">Loading template editor…</div>;
  if (loadError || !normalized || !editorLayout) {
    return (
      <div className="p-8">
        <div role="alert" className="rounded-md bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{loadError || 'Failed to load.'}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent">
      <GoogleFontLinks fonts={fontsLoaded} />
      <main className="max-w-[1100px] mx-auto px-4 sm:px-8 pt-3 pb-12 flex flex-col gap-6">
        {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl">{error}</div>}

        <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-4 items-end">
          <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500">
            Name
            <input
              id="template-display-name"
              value={displayName}
              onChange={e => { setDisplayName(e.target.value); if (isNew && !idTouched) setTemplateId(slugFromName(e.target.value)); }}
              placeholder="Retro Birthday"
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-900 normal-case tracking-normal focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500">
            Id {isNew ? '(printo.in sends this as template_id)' : '(fixed)'}
            <input
              id="template-id"
              value={isNew ? templateId : routeId}
              disabled={!isNew}
              onChange={e => { setIdTouched(true); setTemplateId(e.target.value.toLowerCase()); }}
              placeholder="retro-birthday"
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono text-slate-900 normal-case tracking-normal focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500">
            Status
            <select
              id="template-status"
              value={status}
              onChange={e => setStatus(e.target.value === 'published' ? 'published' : 'draft')}
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-900 normal-case tracking-normal focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="draft">Draft (hidden)</option>
              <option value="published">Published</option>
            </select>
          </label>
        </section>

        <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-slate-500 flex-1 min-w-[200px]">
              Open a side in the canvas editor and add a background, text, icons or your own PNG stickers. Photo frames stay empty for the customer.
            </p>
            <input
              ref={sampleInputRef} type="file" accept="image/*" className="hidden"
              onChange={e => { pickSample(e.target.files?.[0] ?? null); e.target.value = ''; }}
            />
            <button
              type="button"
              onClick={() => (sample ? pickSample(null) : sampleInputRef.current?.click())}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-[10px] font-bold uppercase tracking-tight text-slate-600 hover:bg-slate-50"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              {sample ? 'Remove sample photo' : 'Preview with a sample photo'}
            </button>
          </div>
          <p className="text-[10px] text-slate-400">The sample photo is for previewing only; it is never saved with the template.</p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-label="Sides">
            {surfaces.map(s => (
              <li key={s.key} className="rounded-xl border border-slate-200 overflow-hidden flex flex-col">
                <div className="aspect-[4/3] bg-slate-50 flex items-center justify-center">
                  {s.canvases[0]?.dataUrl ? (
                    <img src={s.canvases[0].dataUrl} alt="" className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Not drawn yet</span>
                  )}
                </div>
                <div className="p-3 flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-800 truncate">{s.label || s.key}</span>
                  <button
                    type="button"
                    onClick={() => openEditor(s.key)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[10px] font-bold uppercase tracking-tight hover:bg-indigo-700"
                  >
                    <PencilRuler className="w-3.5 h-3.5" /> Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 flex flex-col gap-4" aria-labelledby="also-show-on">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex-1 min-w-[240px]">
              <h2 id="also-show-on" className="text-xs font-bold uppercase tracking-tight text-slate-700 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" /> Also show on
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                This template is keyed on this layout&rsquo;s window box{home ? `, ${sizeLabel(home)}` : ''}. Any other layout whose photo
                windows make the same box can offer it. Preview it there before ticking: the artwork keeps its distance from the centre of
                the windows, so check nothing lands over a photo.
              </p>
            </div>
            <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500">
              Preview on
              <select
                id="template-preview-on"
                value={previewOn}
                onChange={e => setPreviewOn(e.target.value)}
                className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-900 normal-case tracking-normal focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">{home?.displayName ?? layoutName} (this layout)</option>
                {sameBox.map(c => <option key={c.name} value={c.name}>{c.displayName}</option>)}
              </select>
            </label>
          </div>
          {sameBox.length === 0 ? (
            <p className="text-xs text-slate-400">No other layout has this window box yet.</p>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2" aria-label="Layouts with the same window box">
              {sameBox.map(c => (
                <li key={c.name} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50">
                  <label className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={alsoOn.includes(c.name)}
                      onChange={() => toggleAlsoOn(c.name)}
                      className="w-4 h-4 accent-indigo-600 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-800 truncate">{c.displayName}</span>
                      <span className="block text-[10px] text-slate-400 font-mono truncate">{c.name}</span>
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setPreviewOn(c.name)}
                    className="text-[10px] font-bold uppercase text-indigo-600 hover:underline shrink-0"
                  >
                    Preview
                  </button>
                </li>
              ))}
            </ul>
          )}
          {nearMisses.length > 0 && (
            <div className="text-xs text-slate-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              <p className="font-bold uppercase tracking-tight text-amber-700 text-[10px] mb-1">Same print area, different bleed</p>
              <p className="mb-1">
                These layouts have the same photo window but a different bleed, so their box is another size. Give them the same bleed
                on the Layouts page and they will appear above.
              </p>
              <ul className="list-disc pl-4">
                {nearMisses.map(c => <li key={c.name}>{c.displayName} <span className="text-slate-400">({sizeLabel(c)})</span></li>)}
              </ul>
            </div>
          )}
          {previewOn && (
            <div className="flex flex-col gap-2" aria-live="polite">
              <p className="text-[11px] font-bold uppercase tracking-tight text-slate-500">
                Preview on {previewName}{previewLoading ? ' …' : ''}
              </p>
              <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-label="Preview sides">
                {(previewSides ?? []).map(s => (
                  <li key={s.key} className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="aspect-[4/3] bg-slate-50 flex items-center justify-center">
                      {s.dataUrl ? (
                        <img src={s.dataUrl} alt="" className="w-full h-full object-contain" />
                      ) : (
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{previewLoading ? 'Drawing…' : 'Not drawn'}</span>
                      )}
                    </div>
                    <div className="p-3 text-xs font-bold text-slate-800 truncate">{s.label || s.key}</div>
                  </li>
                ))}
              </ul>
              <p className="text-[10px] text-slate-400">Edits happen on this layout&rsquo;s sides above; the preview follows them.</p>
            </div>
          )}
        </section>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white text-[11px] font-bold uppercase tracking-tight rounded-lg hover:bg-indigo-700 shadow-sm transition-all disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {isNew ? 'Create template' : 'Save template'}
          </button>
          {savedAt && !saving && (
            <span className="flex items-center gap-1 text-xs font-bold text-emerald-700"><Check className="w-3.5 h-3.5" /> Saved</span>
          )}
        </div>
      </main>

      {editingCanvas && activeSurface && (
        <CanvasEditorModal
          key={`template-modal-${activeKey}`}
          activeCanvasIdx={0}
          editingCanvas={editingCanvas}
          canvases={activeSurface.canvases}
          surfaceStates={surfaces}
          activeSurfaceKey={activeKey}
          layout={editorLayout}
          globalFitMode="cover"
          selectedFonts={selectedFonts}
          apiBase={API}
          getAuthHeaders={() => ({})}
          setEditingCanvas={setEditingCanvas}
          setCanvases={setActiveCanvases}
          setFiles={() => undefined}
          setError={setError}
          onClose={() => setEditingCanvas(null)}
          onOpenCanvas={(_idx, key) => openEditor(key ?? activeKey)}
          getFileUrl={getFileUrl}
          loadGoogleFont={loadGoogleFont}
          skipNextGenerateRef={skipNextGenerateRef}
          expandPdfPages={expandPdfPages}
        />
      )}
      {pdfPickerElement}
    </div>
  );
}

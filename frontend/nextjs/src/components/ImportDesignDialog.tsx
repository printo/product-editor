'use client';

/**
 * Ops: import a design made in the older online-canvas design tool. Choose
 * the size it is for, paste its export and see it: every picture becomes one
 * artwork, centred on that size, with a slider to grow it from the centre and
 * holes cut for the chosen layout's print areas. Confirm opens the template
 * editor on it, and nothing but the artwork file is stored until that editor's
 * own Create template button.
 *
 * When no layout has as many print areas as the design has photo spaces, ops
 * can make a layout for it instead: that creates the layout and opens the
 * layout editor with the design's pictures behind the print areas, and saving
 * there comes back here (`resume`) to cut the artwork to them.
 *
 * The reading is lib/online-canvas-import.ts. The artwork is fetched through
 * POST ops/import/artwork, because the old tool's file host cannot be read
 * from a browser; what is built from it is stored through the ordinary
 * sticker upload, which checks every file.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ClipboardPaste, Info, Loader2, TriangleAlert } from 'lucide-react';
import { clsx } from 'clsx';
import { rasterizeSvgUrl } from '@/lib/icon-raster';
import { readError } from '@/lib/read-error';
import { useModalA11y } from '@/lib/use-modal-a11y';
import {
  DesignImportError, LOW_DPI, MAX_STICKER_BYTES, buildPageArtwork, fontsUsed, frameOverlaySvg, layoutDefinitionFor, mmToImportPx,
  parseOnlineCanvasExport, placedDpi, placedOnLayout, printAreasDifferFromSpaces, rasterSize, sniffArtwork, suggestNames, textOverlayFor, withLayoutGeometry, withoutWindows,
  type ArtworkSource, type ImportNote, type ImportedDesign, type ImportedPiece, type LayoutGeometry, type LayoutTarget, type TextOverlaySpec,
} from '@/lib/online-canvas-import';
import { clearImportSession, readImportSession, writeImportSession } from '@/lib/import-session';
import { TemplateSizePicker, useTemplateSizePick } from '@/components/TemplateSizePicker';
import {
  importedDecoration, isEmptyDecoration, slugFromName, writeImportDraft, type ImportedOverlay, type SizeGroup,
} from '@/app/editor/layout/[name]/template-authoring';

const API = '/api/internal/proxy';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const LAYOUT_NAME_RE = /^[a-z0-9_-]{1,80}$/i;

type Step = 'paste' | 'reading' | 'review' | 'applying' | 'finishing' | 'layoutOnly';

interface FontCheck { family: string; listed: boolean; available: boolean }

interface Fetched {
  sources: Map<number, ArtworkSource>;
  /** Why a piece's file could not be fetched, by piece. */
  failed: Map<number, string>;
  overlay: ArtworkSource | null;
  fonts: FontCheck[];
}

interface Built {
  pageSvg: string | null;
  texts: Array<{ piece: ImportedPiece; spec: TextOverlaySpec }>;
  frameSvg: string | null;
  notes: ImportNote[];
  blocked: string[];
}

/** The server would not fetch a file at all: the host is not allowed, or fetching is off for this key. */
class FetchRefused extends Error {}

async function fetchArtwork(url: string): Promise<ArtworkSource> {
  const res = await fetch(`${API}/ops/import/artwork`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ url }) });
  if (res.status === 403) throw new FetchRefused(await readError(res, 'The server may not fetch this artwork.'));
  if (!res.ok) throw new Error(await readError(res, `the server answered ${res.status}`));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const kind = sniffArtwork(bytes);
  if (kind === 'svg') return { kind, text: new TextDecoder().decode(bytes) };
  if (kind === 'png' || kind === 'jpeg') return { kind, bytes };
  throw new Error('it is not a PNG, JPEG or SVG');
}

async function checkFont(family: string): Promise<FontCheck> {
  try {
    const res = await fetch(`${API}/ops/import/font`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ family }) });
    if (res.ok) {
      const v = await res.json();
      return { family, listed: v?.listed === true, available: v?.available === true };
    }
  } catch {
    // Treated as unknown below.
  }
  return { family, listed: false, available: false };
}

async function listFont(family: string): Promise<void> {
  const res = await fetch(`${API}/fonts`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await readError(res, 'The font list could not be read.'));
  const body = await res.json();
  const current: string[] = Array.isArray(body?.fonts) ? body.fonts : [];
  if (current.some(f => f.toLowerCase() === family.toLowerCase())) return;
  const put = await fetch(`${API}/fonts`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ fonts: [...current, family] }) });
  if (!put.ok) throw new Error(await readError(put, `'${family}' could not be added to the font list.`));
}

async function storeSticker(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`${API}/ops/templates/assets`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(await readError(res, `Artwork could not be stored (HTTP ${res.status}).`));
  const { url } = await res.json();
  if (typeof url !== 'string') throw new Error('Artwork could not be stored.');
  return url;
}

/** The frame overlay drawn to a PNG the size of the canvas: a mask the layout can still be turned with. */
async function framePng(svg: string, width: number, height: number): Promise<File> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    return await rasterizeSvgUrl(url, width, height, 'frame.png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Names no layout and no template already has. Designs for one product with
 * the same number of photos all suggest the same names, so the second one
 * becomes `name_2` / "Name (2)", and so on; the template's id is made from
 * its name in the editor, so the name is what has to be free.
 */
function freeNames(
  suggested: { name: string; displayName: string },
  layouts: readonly string[],
  templateIds: readonly string[],
): { name: string; displayName: string } {
  const names = new Set(layouts.map(t => t.toLowerCase()));
  const ids = new Set(templateIds);
  for (let i = 1; ; i += 1) {
    const name = i === 1 ? suggested.name : `${suggested.name}_${i}`;
    const displayName = i === 1 ? suggested.displayName : `${suggested.displayName} (${i})`;
    if (!names.has(name.toLowerCase()) && !ids.has(slugFromName(displayName))) return { name, displayName };
  }
}

const inches = (mm: number): string => String(Math.round((mm / 25.4) * 100) / 100);
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function build(design: ImportedDesign, fetched: Fetched): Built {
  const notes: ImportNote[] = [];
  const blocked: string[] = [];
  const why = (piece: ImportedPiece) => (fetched.failed.has(piece.index) ? `fetched (${fetched.failed.get(piece.index)})` : 'read');
  const page = buildPageArtwork(design, fetched.sources);
  for (const piece of page.missing) notes.push({ level: 'warning', text: `${piece.label} could not be ${why(piece)} and is left out of the page artwork.` });
  if (page.svg && byteLength(page.svg) > MAX_STICKER_BYTES) blocked.push('The artwork is larger than 5 MB once merged into one sheet.');

  const texts: Built['texts'] = [];
  for (const piece of design.pieces) {
    if (piece.kind !== 'text') continue;
    const spec = textOverlayFor(design, piece);
    if (spec) texts.push({ piece, spec });
  }
  for (const piece of design.pieces) {
    const source = fetched.sources.get(piece.index);
    if (!source || source.kind === 'svg') continue;
    const size = rasterSize(source.bytes);
    const dpi = size ? placedDpi(size.width, piece.box.w) : 0;
    if (dpi > 0 && dpi < LOW_DPI) {
      notes.push({ level: 'warning', text: `${piece.label} is only ${dpi} dpi at this size (print wants 300), so it will look soft. Replace it with a sharper file when you can.` });
    }
  }
  for (const font of fetched.fonts) {
    if (!font.listed && !font.available) {
      notes.push({ level: 'warning', text: `The font “${font.family}” is not on the font list and Google Fonts does not have it, so its text prints in Inter. Pick another font in the editor.` });
    }
  }
  return { pageSvg: page.svg, texts, frameSvg: fetched.overlay ? frameOverlaySvg(design, fetched.overlay) : null, notes, blocked };
}

function Preview({ design, built, urls, withFrame }: {
  design: ImportedDesign;
  built: Built;
  urls: { page: string | null; frame: string | null };
  withFrame: boolean;
}) {
  const { width: W, height: H } = design.canvasPx;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Preview of the design as it will be imported" className="w-full h-auto rounded-lg border border-slate-200 bg-white">
      <rect width={W} height={H} fill={design.paperColor ?? '#ffffff'} />
      {design.windows.map((w, i) => (
        <g key={w.index}>
          <rect x={mmToImportPx(w.box.x)} y={mmToImportPx(w.box.y)} width={mmToImportPx(w.box.w)} height={mmToImportPx(w.box.h)} fill="#eceff3" />
          <text
            x={mmToImportPx(w.box.x + w.box.w / 2)} y={mmToImportPx(w.box.y + w.box.h / 2)}
            textAnchor="middle" dominantBaseline="central" fontFamily="sans-serif" fill="#7a8594"
            fontSize={Math.min(mmToImportPx(Math.min(w.box.w, w.box.h)) * 0.22, 110)}
          >
            Photo {i + 1}
          </text>
        </g>
      ))}
      {urls.page && <image href={urls.page} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />}
      {built.texts.map(({ piece, spec }) => {
        return (
          <text
            key={piece.index} x={(spec.x / 100) * W} y={(spec.y / 100) * H} fontSize={spec.fontSize} fill={spec.color}
            fontFamily={`'${spec.fontFamily}', cursive`} dominantBaseline="central"
            textAnchor={spec.textAlign === 'center' ? 'middle' : spec.textAlign === 'right' ? 'end' : 'start'}
          >
            {spec.text}
          </text>
        );
      })}
      {withFrame && urls.frame && <image href={urls.frame} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />}
    </svg>
  );
}

const NO_URLS = { page: null, frame: null };

/** The artwork files, the frame and the font answers a design needs. `refused`
 *  is set when the server would fetch none of them (a switch, not a broken file). */
async function gather(d: ImportedDesign, say: (text: string) => void): Promise<Fetched & { refused: string | null }> {
  const wanted = d.pieces.filter(p => p.src);
  const inFlight = new Map<string, Promise<ArtworkSource>>();
  const get = (url: string) => {
    let job = inFlight.get(url);
    if (!job) { job = fetchArtwork(url); inFlight.set(url, job); }
    return job;
  };
  const sources = new Map<number, ArtworkSource>();
  const failed = new Map<number, string>();
  const refused: string[] = [];
  let done = 0;
  say(wanted.length ? `Fetching the artwork (0 of ${wanted.length})…` : 'Reading the design…');
  await Promise.all(wanted.map(async piece => {
    try {
      sources.set(piece.index, await get(piece.src as string));
    } catch (e) {
      failed.set(piece.index, e instanceof Error ? e.message : 'it could not be fetched');
      if (e instanceof FetchRefused) refused.push(e.message);
    }
    done += 1;
    say(`Fetching the artwork (${done} of ${wanted.length})…`);
  }));
  if (wanted.length > 0 && refused.length === wanted.length) return { sources, failed, overlay: null, fonts: [], refused: refused[0] };
  const overlay = d.overlayUrl ? await get(d.overlayUrl).catch(() => null) : null;
  const fonts = await Promise.all(fontsUsed(d).map(checkFont));
  return { sources, failed, overlay, fonts, refused: null };
}

/** The saved layout's canvas and print areas; throws with a message for the ops user. */
async function savedGeometry(name: string): Promise<LayoutGeometry> {
  const res = await fetch(`${API}/ops/layouts/${encodeURIComponent(name)}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(await readError(res, `The layout '${name}' could not be read (HTTP ${res.status}).`));
  const data = await res.json();
  if (Array.isArray(data?.surfaces)) throw new Error('The layout now has more than one side. An imported design has one, so its artwork cannot be placed.');
  const widthMm = Number(data?.canvas?.widthMm), heightMm = Number(data?.canvas?.heightMm);
  if (!(widthMm > 0 && heightMm > 0)) throw new Error('The saved layout does not give its size in millimetres.');
  const frames = (Array.isArray(data?.frames) ? data.frames : []).map((f: Record<string, unknown>) => ({
    x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height),
  })).filter((f: { x: number; y: number; width: number; height: number }) => [f.x, f.y, f.width, f.height].every(Number.isFinite));
  return { canvas: { widthMm, heightMm }, frames };
}

/** A layout of the chosen size as customers ordering that way see it. */
async function targetLayout(name: string, facing: string): Promise<LayoutTarget> {
  const query = facing === 'portrait' || facing === 'landscape' ? `?orientation=${facing}` : '';
  const res = await fetch(`${API}/layouts/${encodeURIComponent(name)}${query}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(await readError(res, `The layout '${name}' could not be read (HTTP ${res.status}).`));
  const data = await res.json();
  const widthMm = Number(data?.canvas?.widthMm), heightMm = Number(data?.canvas?.heightMm);
  if (!(widthMm > 0 && heightMm > 0)) throw new Error(`The layout '${name}' does not give its size in millimetres.`);
  const frames = (Array.isArray(data?.frames) ? data.frames : []).map((f: Record<string, unknown>) => ({
    x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height),
  })).filter((f: { x: number; y: number; width: number; height: number }) => [f.x, f.y, f.width, f.height].every(Number.isFinite));
  return {
    canvas: { widthMm, heightMm },
    frames,
    canvasWidthPx: Number(data?.canvas?.width) || undefined,
    printsBleedArea: data?.printSheet?.mode === 'bleed',
  };
}

const inputClass = 'px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-900 normal-case tracking-normal focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-500';
const labelClass = 'flex flex-col gap-1 text-[11px] font-bold uppercase tracking-tight text-slate-500';

export function ImportDesignDialog({ sizeGroups = [], takenNames, takenTemplateIds, resume = false, onClose }: {
  /** The sizes on offer, as Create a template offers them. Without any, the design makes its own layout. */
  sizeGroups?: SizeGroup[];
  /** Names of the layouts that exist, so a suggested name never lands on one. */
  takenNames: readonly string[];
  /** Ids of the templates that exist, for the same reason. */
  takenTemplateIds: readonly string[];
  /** Carry on an import whose layout was just saved in the layout editor. */
  resume?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(resume ? 'finishing' : 'paste');
  const [raw, setRaw] = useState('');
  // An imported design has one side, so only one-sided layouts can take it.
  const oneSided = useMemo(() => sizeGroups
    .map(g => ({ ...g, layouts: g.layouts.filter(l => l.surfaceKeys.length === 1 && l.surfaceKeys[0] === 'default') }))
    .filter(g => g.layouts.length > 0), [sizeGroups]);
  const pick = useTemplateSizePick(oneSided);
  const [target, setTarget] = useState<LayoutTarget | null>(null);
  const [targetName, setTargetName] = useState('');
  const [orientationParam, setOrientationParam] = useState('');
  const [targetFacing, setTargetFacing] = useState('');
  const [makeNewLayout, setMakeNewLayout] = useState(false);
  const [scalePct, setScalePct] = useState(100);
  const deferredScale = useDeferredValue(scalePct);
  const [readDesign, setDesign] = useState<ImportedDesign | null>(null);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [layoutName, setLayoutName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [withFrame, setWithFrame] = useState(true);
  const [addFonts, setAddFonts] = useState<string[]>([]);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Set once the layout exists, so a retry after a later failure does not make a second one.
  const [createdLayout, setCreatedLayout] = useState<string | null>(null);
  const [urls, setUrls] = useState<{ page: string | null; frame: string | null }>(NO_URLS);

  const ref = useRef<HTMLDivElement | null>(null);
  const [finishFailed, setFinishFailed] = useState(false);
  const busy = step === 'reading' || step === 'applying' || (step === 'finishing' && !finishFailed);
  useModalA11y(ref, busy ? null : onClose);

  const onLayout = target !== null && !makeNewLayout;
  const design = useMemo(
    () => (readDesign && onLayout ? placedOnLayout(readDesign, target, deferredScale / 100) : readDesign),
    [readDesign, onLayout, target, deferredScale],
  );
  const built = useMemo(() => (design && fetched ? build(design, fetched) : null), [design, fetched]);

  // What the preview draws: addresses of the documents just built, released when they change.
  useEffect(() => {
    if (!built) { setUrls(NO_URLS); return; }
    const made: string[] = [];
    const address = (part: BlobPart, type: string) => {
      const url = URL.createObjectURL(new Blob([part], { type }));
      made.push(url);
      return url;
    };
    setUrls({
      page: built.pageSvg ? address(built.pageSvg, 'image/svg+xml') : null,
      frame: built.frameSvg ? address(built.frameSvg, 'image/svg+xml') : null,
    });
    return () => made.forEach(url => URL.revokeObjectURL(url));
  }, [built]);

  const read = async () => {
    setError(null);
    let d: ImportedDesign;
    try {
      d = parseOnlineCanvasExport(raw);
    } catch (e) {
      setError(e instanceof DesignImportError ? e.message : 'The export could not be read.');
      return;
    }
    setStep('reading');
    const got = await gather(d, setProgress);
    // Every file refused is a switch, not a broken file: say so once, before any review.
    if (got.refused) {
      setError(got.refused);
      setStep('paste');
      return;
    }
    const { sources, failed, overlay, fonts } = got;
    let layoutTarget: LayoutTarget | null = null;
    // Asked for only when the layout has to turn to face that way: the server
    // turns by the canvas, and print areas can face otherwise than their canvas.
    const turned = pick.layouts.find(l => l.layout.name === pick.layoutName)?.turned ?? false;
    if (pick.layoutName) {
      try {
        setProgress('Reading the layout…');
        layoutTarget = await targetLayout(pick.layoutName, turned ? pick.facing ?? '' : '');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The layout could not be read.');
        setStep('paste');
        return;
      }
    }
    setTarget(layoutTarget);
    setTargetName(pick.layoutName);
    setOrientationParam(turned ? pick.orientationParam : '');
    setTargetFacing(pick.facing ?? '');
    setMakeNewLayout(false);
    setScalePct(100);
    const names = freeNames(suggestNames(d), takenNames, takenTemplateIds);
    setDesign(d);
    setFetched({ sources, failed, overlay, fonts });
    setLayoutName(names.name);
    setDisplayName(names.displayName);
    setTemplateName(names.displayName);
    setWithFrame(overlay !== null);
    setAddFonts(fonts.filter(f => !f.listed && f.available).map(f => f.family));
    setCreatedLayout(null);
    setStep('review');
  };

  const nameTaken = createdLayout === null && takenNames.some(t => t.toLowerCase() === layoutName.trim().toLowerCase());
  const nameProblem = onLayout ? null : !LAYOUT_NAME_RE.test(layoutName.trim())
    ? 'Use letters, digits, hyphens and underscores only, with no spaces.'
    : nameTaken ? 'A layout already has this name.' : null;
  const blocked = [...(design?.blocked ?? []), ...(built?.blocked ?? [])];
  const notes = [...(design?.notes ?? []), ...(built?.notes ?? [])];
  const fontsToOffer = fetched?.fonts.filter(f => !f.listed && f.available) ?? [];

  const photoSpaces = readDesign?.windows.length ?? 0;
  const countMismatch = onLayout && target.frames.length !== photoSpaces;
  const areasDiffer = onLayout && !countMismatch && !!readDesign && printAreasDifferFromSpaces(readDesign, target);
  const chosenGroup = oneSided.find(g => g.layouts.some(l => l.name === targetName)) ?? null;
  const chosen = chosenGroup?.layouts.find(l => l.name === targetName) ?? null;
  const sameSize = (() => {
    const box = chosen?.printAreaBox;
    if (!box || !readDesign) return true;
    const a = [box.widthMm, box.heightMm].sort((x, y) => x - y);
    const b = [readDesign.printMm.width, readDesign.printMm.height].sort((x, y) => x - y);
    return Math.abs(a[0] - b[0]) < 1.5 && Math.abs(a[1] - b[1]) < 1.5;
  })();

  // Onto the layout chosen: store the one artwork and open the template editor on it.
  const applyOnLayout = async () => {
    if (!design || !built || !target || countMismatch || blocked.length > 0) return;
    setError(null);
    setStep('applying');
    try {
      for (const family of addFonts) {
        setProgress(`Adding “${family}” to the font list…`);
        await listFont(family);
      }
      setProgress('Storing the artwork…');
      const artworkSrc = built.pageSvg ? await storeSticker(new File([built.pageSvg], 'artwork.svg', { type: 'image/svg+xml' })) : null;
      const overlays: ImportedOverlay[] = built.texts.map(({ piece, spec }) => ({ kind: 'text', id: `import-text-${piece.index}`, ...spec }));
      // The sheet is the whole canvas whatever the layout prints, so it is placed as one.
      const def = { canvas: { ...design.canvasPx, ...target.canvas }, frames: [], printSheet: { mode: 'canvas' as const } };
      const decoration = importedDecoration({ def, paperColor: design.paperColor, artworkSrc, overlays });
      if (isEmptyDecoration(decoration)) throw new Error('This design has no artwork, text or page colour, so there is nothing to put in a template.');
      writeImportDraft({ layout: targetName, displayName: templateName.trim() || displayName.trim() || targetName, decoration });
      router.push(`/editor/layouts/templates/${encodeURIComponent(targetName)}/new?import=1&tick=size${orientationParam}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import failed.');
      setStep('review');
    }
  };

  const apply = async () => {
    if (onLayout) { await applyOnLayout(); return; }
    if (!design || !built || nameProblem || blocked.length > 0) return;
    const name = layoutName.trim();
    setError(null);
    setStep('applying');
    try {
      for (const family of addFonts) {
        setProgress(`Adding “${family}” to the font list…`);
        await listFont(family);
      }
      const definition = layoutDefinitionFor(design, name);
      if (createdLayout !== name) {
        setProgress('Creating the layout…');
        const form = new FormData();
        form.append('name', name);
        form.append('display_name', displayName.trim() || name);
        form.append('create_only', '1');
        form.append('layout_data', JSON.stringify(definition));
        if (withFrame && built.frameSvg) {
          const frame = await framePng(built.frameSvg, design.canvasPx.width, design.canvasPx.height).catch(() => null);
          if (frame) form.append('frame_mask', frame, 'frame.png');
        }
        const res = await fetch(`${API}/ops/layouts/${encodeURIComponent(name)}`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(await readError(res, `The layout could not be created (HTTP ${res.status}).`));
        setCreatedLayout(name);
      }

      // The pictures whole, with no holes: what the layout editor shows behind the print areas.
      const guideSvg = fetched ? buildPageArtwork(withoutWindows(design), fetched.sources).svg : null;
      writeImportSession({ layout: name, raw, templateName: templateName.trim() || displayName.trim() || name, guideSvg, guideMm: design.printMm });
      router.push(`/editor/layouts?edit=${encodeURIComponent(name)}&import=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import failed.');
      setStep('review');
    }
  };

  // The second half: the layout is saved, so cut the artwork to it and open the template editor.
  const finish = useCallback(async () => {
    const session = readImportSession();
    setError(null);
    setFinishFailed(false);
    setStep('finishing');
    try {
      if (!session) throw new Error('There is no import under way in this tab. Start again from Import a design.');
      const name = session.layout;
      setLayoutName(name);
      setProgress('Reading the saved layout…');
      const geometry = await savedGeometry(name);
      const read = parseOnlineCanvasExport(session.raw);
      const got = await gather(read, setProgress);
      if (got.refused) throw new Error(got.refused);
      const d = withLayoutGeometry(read, geometry);
      const made = build(d, got);
      const stops = [...d.blocked, ...made.blocked];
      if (stops.length > 0) throw new Error(stops.join(' '));
      setDesign(d);
      setProgress('Storing the artwork…');
      const artworkSrc = made.pageSvg ? await storeSticker(new File([made.pageSvg], 'artwork.svg', { type: 'image/svg+xml' })) : null;
      const overlays: ImportedOverlay[] = made.texts.map(({ piece, spec }) => ({ kind: 'text', id: `import-text-${piece.index}`, ...spec }));
      // The sheet is the whole canvas whatever the layout prints, so it is placed as one.
      const def = { canvas: { ...d.canvasPx, ...geometry.canvas }, frames: [], printSheet: { mode: 'canvas' as const } };
      const decoration = importedDecoration({ def, paperColor: d.paperColor, artworkSrc, overlays });
      clearImportSession();
      if (isEmptyDecoration(decoration)) {
        setStep('layoutOnly');
        return;
      }
      writeImportDraft({ layout: name, displayName: session.templateName || name, decoration });
      router.push(`/editor/layouts/templates/${encodeURIComponent(name)}/new?import=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import failed.');
      setFinishFailed(true);
    }
  }, [router]);

  const resumed = useRef(false);
  useEffect(() => {
    if (!resume || resumed.current) return;
    resumed.current = true;
    void finish();
  }, [resume, finish]);

  const pictures = design?.pieces.filter(p => p.layer === 'artwork').length ?? 0;

  return (
    <div className="fixed inset-0 z-[200003] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Import a design"
        className="bg-white rounded-xl shadow-xl ring-1 ring-slate-900/5 w-full max-w-4xl max-h-[92vh] overflow-y-auto p-7 outline-none"
      >
        <p className="text-sm font-black text-slate-900 uppercase tracking-tight mb-1">Import a design</p>

        {(step === 'paste' || step === 'reading') && (
          <>
            <p className="text-xs text-slate-500 leading-relaxed mb-4">
              {oneSided.length > 0
                ? 'Choose the size this design is for, then paste its JSON from the old design tool. Every picture becomes one artwork on a template of that size. You see the result before anything is stored.'
                : 'Paste the JSON of a design made in the old design tool. Its photo windows become a new layout and everything else becomes a template on it. You see the result and confirm before anything is created, then adjust the layout’s size and print areas before the artwork is cut to them.'}
            </p>
            {oneSided.length > 0 && <TemplateSizePicker idPrefix="import-template" sizeGroups={oneSided} pick={pick} disabled={step === 'reading'} />}
            <label className={clsx(labelClass, 'mb-4')}>
              Design JSON
              <textarea
                id="import-design-json"
                value={raw}
                onChange={e => setRaw(e.target.value)}
                disabled={step === 'reading'}
                rows={10}
                spellCheck={false}
                placeholder='[{"design_mode":"online_canvas", …'
                className={clsx(inputClass, 'font-mono text-xs leading-relaxed')}
              />
            </label>
            {error && <div role="alert" className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-lg">{error}</div>}
            <div className="flex items-center gap-3">
              <button
                type="button" onClick={read} disabled={step === 'reading' || !raw.trim()}
                className="flex-1 flex items-center justify-center gap-2 py-3 text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50"
              >
                {step === 'reading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardPaste className="w-4 h-4" />}
                {step === 'reading' ? progress : 'Read the design'}
              </button>
              <button type="button" onClick={onClose} disabled={step === 'reading'} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all active:scale-95 disabled:opacity-50">Cancel</button>
            </div>
          </>
        )}

        {(step === 'review' || step === 'applying') && design && built && (
          <>
            <p className="text-xs text-slate-500 leading-relaxed mb-4">
              {readDesign?.productName || 'This design'}: a {inches(readDesign?.printMm.width ?? 0)} × {inches(readDesign?.printMm.height ?? 0)} in print
              with {plural(photoSpaces, 'photo space', 'photo spaces')}. Check it against the old preview before confirming.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,300px)_1fr] gap-6">
              <div className="w-full max-w-[300px] mx-auto md:mx-0">
                <Preview design={design} built={built} urls={urls} withFrame={withFrame && !onLayout} />
                <p className="text-[10px] text-slate-400 mt-2">
                  A sketch of the result. Photos fill the windows in the order numbered; text is drawn in its real font in the editor.
                </p>
              </div>
              <div className="flex flex-col gap-4 min-w-0">
                {onLayout && (
                  <div className="text-xs text-slate-700 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <p><span className="font-bold">Mapped to size:</span> {chosenGroup?.label ?? '—'}{targetFacing ? `, ${targetFacing}` : ''}</p>
                    <p><span className="font-bold">Designed on:</span> {chosen?.displayName ?? targetName}, {plural(target.frames.length, 'print area', 'print areas')}</p>
                    <p className="text-slate-500 mt-1">The other layouts of this size are ticked under Also show on in the next step; untick any you don&rsquo;t want.</p>
                  </div>
                )}
                {countMismatch && (
                  <div role="alert" className="bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium px-4 py-3 rounded-lg flex flex-col gap-2 items-start">
                    <p>This design has {plural(photoSpaces, 'photo space', 'photo spaces')}, but this layout has {plural(target?.frames.length ?? 0, 'print area', 'print areas')}. Go back and choose another layout, or make a layout for this design.</p>
                    <button type="button" onClick={() => setMakeNewLayout(true)} disabled={step === 'applying'} className="px-3 py-1.5 rounded-lg bg-white border border-amber-300 font-bold hover:bg-amber-100">Make a new layout for this design</button>
                  </div>
                )}
                {areasDiffer && (
                  <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium px-4 py-3 rounded-lg flex flex-col gap-2 items-start">
                    <p>This layout&rsquo;s print {target?.frames.length === 1 ? 'area is' : 'areas are'} a different size from the photo {photoSpaces === 1 ? 'space' : 'spaces'} in the old design. The photo takes the print area, so pictures under it are cut away and the result can look quite different from the old preview. Choose a layout that matches, or make a layout for this design.</p>
                    <button type="button" onClick={() => setMakeNewLayout(true)} disabled={step === 'applying'} className="px-3 py-1.5 rounded-lg bg-white border border-amber-300 font-bold hover:bg-amber-100">Make a new layout for this design</button>
                  </div>
                )}
                {onLayout && !countMismatch && (
                  <label className={labelClass}>
                    Artwork size: {scalePct}%
                    <input
                      id="import-artwork-size" type="range" min={50} max={200} step={1} value={scalePct} disabled={step === 'applying'}
                      onChange={e => setScalePct(Number(e.target.value))} className="w-full accent-indigo-600"
                    />
                    <span className="text-[10px] font-medium normal-case tracking-normal text-slate-400">
                      {sameSize ? 'It grows from the centre; anything past the edge is cropped.' : 'The old design is another size, so it starts at its real size in the centre. It grows from the centre; anything past the edge is cropped.'}
                    </span>
                  </label>
                )}
                {!onLayout && (<>
                <label className={labelClass}>
                  Layout id (cannot be changed later)
                  <input
                    id="import-layout-name" value={layoutName} disabled={step === 'applying' || createdLayout !== null}
                    onChange={e => setLayoutName(e.target.value)} className={clsx(inputClass, 'font-mono')}
                  />
                  {nameProblem && <span className="text-[10px] font-medium normal-case tracking-normal text-red-600">{nameProblem}</span>}
                </label>
                <label className={labelClass}>
                  Layout name
                  <input id="import-layout-display-name" value={displayName} disabled={step === 'applying' || createdLayout !== null} onChange={e => setDisplayName(e.target.value)} className={inputClass} />
                </label>
                </>)}
                <label className={labelClass}>
                  Template name
                  <input id="import-template-name" value={templateName} disabled={step === 'applying'} onChange={e => setTemplateName(e.target.value)} className={inputClass} />
                </label>

                <ul className="text-xs text-slate-600 leading-relaxed list-disc pl-4 flex flex-col gap-1">
                  {!onLayout && <li>{plural(design.windows.length, 'photo window becomes a print area', 'photo windows become print areas')} of the new layout.</li>}
                  {pictures > 0 && (
                    <li>
                      {plural(pictures, 'picture becomes', 'pictures become')} the page artwork: one sheet, with a hole wherever a photo
                      was above a picture. A click on a see-through part reaches the photo. Vector artwork stays vector.
                    </li>
                  )}
                  {built.texts.length > 0 && <li>{built.texts.map(t => `${t.piece.label} in ${t.spec.fontFamily || 'the default font'}`).join('; ')}.</li>}
                  {design.paperColor && <li>Page colour {design.paperColor}.</li>}
                </ul>

                {((fetched?.overlay && !onLayout) || fontsToOffer.length > 0) && (
                  <div className="flex flex-col gap-2">
                    {fetched?.overlay && !onLayout && (
                      <label className="flex items-start gap-2 text-xs text-slate-700">
                        <input type="checkbox" checked={withFrame} disabled={step === 'applying' || createdLayout !== null} onChange={e => setWithFrame(e.target.checked)} className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                        <span>Use the old tool&rsquo;s frame as this layout&rsquo;s frame picture. It shows in previews what the frame covers and is never printed.</span>
                      </label>
                    )}
                    {fontsToOffer.map(font => (
                      <label key={font.family} className="flex items-start gap-2 text-xs text-slate-700">
                        <input
                          type="checkbox" checked={addFonts.includes(font.family)} disabled={step === 'applying'}
                          onChange={e => setAddFonts(prev => (e.target.checked ? [...prev, font.family] : prev.filter(f => f !== font.family)))}
                          className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span>Add the font “{font.family}” to the font list. Without it, text in this font prints in Inter.</span>
                      </label>
                    ))}
                  </div>
                )}

                {blocked.length > 0 && (
                  <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium px-4 py-3 rounded-lg">
                    <p className="font-bold uppercase tracking-tight mb-1">This design cannot be imported</p>
                    <ul className="list-disc pl-4 flex flex-col gap-0.5">{blocked.map(b => <li key={b}>{b}</li>)}</ul>
                  </div>
                )}
                {notes.length > 0 && (
                  <ul className="flex flex-col gap-1.5" aria-label="Things to check">
                    {notes.map(note => (
                      <li key={note.text} className={clsx('flex items-start gap-2 text-xs rounded-lg px-3 py-2 border', note.level === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-slate-50 border-slate-200 text-slate-600')}>
                        {note.level === 'warning' ? <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" /> : <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />}
                        <span>{note.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-lg">{error}</div>}
              </div>
            </div>
            <p className="text-[11px] text-slate-500 mt-5 mb-3">
              {onLayout
                ? 'Continuing stores the artwork file and opens the template editor. No layout is created, and the template is saved only when you press Create template there.'
                : 'Confirming creates the layout and opens it in the layout editor, with the pictures shown behind the print areas. Adjust the size and the print areas there and press Update Layout: the artwork is then cut to them and the template editor opens. The template itself is saved only when you press Create template there.'}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button" onClick={apply} disabled={step === 'applying' || nameProblem !== null || blocked.length > 0 || countMismatch}
                className="flex-[2] flex items-center justify-center gap-2 py-3 text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50"
              >
                {step === 'applying' && <Loader2 className="w-4 h-4 animate-spin" />}
                {step === 'applying' ? progress : onLayout ? 'Continue to the template editor' : createdLayout ? 'Try again' : 'Create the layout and adjust it'}
              </button>
              <button type="button" onClick={() => { setError(null); setStep('paste'); }} disabled={step === 'applying' || createdLayout !== null} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all active:scale-95 disabled:opacity-50">Back</button>
              <button type="button" onClick={onClose} disabled={step === 'applying'} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all active:scale-95 disabled:opacity-50">Cancel</button>
            </div>
          </>
        )}

        {step === 'finishing' && (
          <>
            {!finishFailed && (
              <p role="status" className="flex items-center gap-2 text-sm text-slate-700 my-5">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                {progress || 'Cutting the artwork to the saved print areas…'}
              </p>
            )}
            {finishFailed && (
              <>
                <div role="alert" className="my-4 bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-lg">{error}</div>
                <p className="text-xs text-slate-500 leading-relaxed mb-4">
                  The layout{layoutName ? <> <span className="font-mono">{layoutName}</span></> : ''} is saved. Nothing else was created.
                </p>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => void finish()} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all active:scale-95">Try again</button>
                  <button type="button" onClick={onClose} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all active:scale-95">Close</button>
                </div>
              </>
            )}
          </>
        )}

        {step === 'layoutOnly' && design && (
          <>
            <p role="status" className="text-sm text-slate-700 leading-relaxed mb-5">
              The layout <span className="font-mono">{layoutName.trim()}</span> is created with {plural(design.windows.length, 'print area', 'print areas')}.
              The old design had no artwork, text or page colour, so there is nothing to put in a template.
            </p>
            <div className="flex items-center gap-3">
              <Link href="/editor/layouts" className="flex-1 py-3 text-center text-xs font-black uppercase tracking-widest bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all">Go to Layouts</Link>
              <button type="button" onClick={onClose} className="flex-1 py-3 text-xs font-black uppercase tracking-widest bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all active:scale-95">Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

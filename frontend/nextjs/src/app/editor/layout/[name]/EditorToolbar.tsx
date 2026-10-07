'use client';

import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { clsx } from 'clsx';
import { ArrowLeft, Check, Download, Droplets, Loader2, Plus, SendHorizonal } from 'lucide-react';
import { useHeader } from '@/context/HeaderContext';
import { formatLayoutDisplayName } from './editor-utils';
import type { FitMode, SurfaceState } from './types';

/** Dashboard only: the page title and the Back to Templates button in the app's top bar. */
export function useDashboardHeader(embedToken: string | null, router: { push(href: string): void }) {
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();
  useEffect(() => {
    if (embedToken) return;
    // Dashboard flow only — the embed iframe returns above, so a customer
    // inside printo.in's page never sees internal page naming.
    setTitle('Preview Canvas');
    setDescription('');
    setCenterActions(null);
    setRightActions(
      <button
        onClick={() => router.push('/dashboard')}
        aria-label="Back to templates"
        title="Back to Templates"
        className="text-[11px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-700 p-2.5 md:px-4 md:py-2 rounded-full md:rounded-2xl border-2 border-indigo-100/50 bg-indigo-50/30 hover:bg-indigo-50/60 transition-all flex items-center gap-2 group shadow-sm shadow-indigo-100/50"
      >
        <ArrowLeft className="w-4 h-4 md:w-3.5 md:h-3.5 group-hover:-translate-x-1 transition-transform" />
        <span className="hidden md:inline">Back to Templates</span>
      </button>
    );
  }, [embedToken, router, setTitle, setDescription, setCenterActions, setRightActions]);
}

type Props = {
  setToolbarSentinel: (el: HTMLDivElement | null) => void;
  isToolbarStuck: boolean;
  toolbarHeight: number;
  setToolbarEl: (el: HTMLDivElement | null) => void;
  headerHeight: number;
  embedToken: string | null;
  orderId: string;
  parentOrigin: string;
  layout: { name?: string; displayName?: string } | null;
  layoutName: string;
  files: File[];
  surfaceStates: SurfaceState[];
  qtyUnder: { uploaded: number; needed: number } | null;
  qtyNeeded: number;
  totalUploadedCount: number;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  globalFitMode: FitMode;
  setGlobalFitMode: Dispatch<SetStateAction<FitMode>>;
  fitModeUserToggledRef: MutableRefObject<boolean>;
  globalBlurFill: boolean;
  setGlobalBlurFill: Dispatch<SetStateAction<boolean>>;
  blurFillUserToggledRef: MutableRefObject<boolean>;
  isDownloading: boolean;
  setDisclaimerChecked: Dispatch<SetStateAction<boolean>>;
  setShowEmbedDisclaimer: Dispatch<SetStateAction<boolean>>;
  setShowDownloadModal: Dispatch<SetStateAction<boolean>>;
};

/** The editor toolbar: logo and product name, the Add Photos box, Fit/Cover,
 *  Blur Effect, and Download (dashboard) or Save & Continue (embed). Pinned
 *  under the top bar by useStickyToolbar. */
export function EditorToolbar({
  setToolbarSentinel, isToolbarStuck, toolbarHeight, setToolbarEl, headerHeight,
  embedToken, orderId, parentOrigin, layout, layoutName, files, surfaceStates, qtyUnder, qtyNeeded,
  totalUploadedCount, uploadInputRef, globalFitMode, setGlobalFitMode, fitModeUserToggledRef,
  globalBlurFill, setGlobalBlurFill, blurFillUserToggledRef, isDownloading, setDisclaimerChecked,
  setShowEmbedDisclaimer, setShowDownloadModal,
}: Props) {
  return (
    <>
      {/* Wrapper keeps the sentinel from becoming a real space-y sibling of the
          toolbar below (which would add an unwanted margin-top to it and throw
          off its natural resting position). The sentinel marks that resting
          spot; see the comment in useStickyToolbar.ts for why the toolbar goes
          `fixed` instead of `sticky` once scrolled past it, and the spacer
          directly below for how the vacated flow space is replaced. */}
      <div className="relative">
        <div ref={setToolbarSentinel} className="absolute top-0 inset-x-0 h-px" aria-hidden />
        {isToolbarStuck && <div style={{ height: toolbarHeight }} aria-hidden />}
        <div
          ref={setToolbarEl}
          style={isToolbarStuck ? {
            position: 'fixed', top: headerHeight, left: 0, right: 0,
            maxWidth: 1440, marginLeft: 'auto', marginRight: 'auto',
          } : undefined}
          className={clsx(
            'z-40 px-4 md:px-8 py-3 bg-white/60 backdrop-blur-3xl border-b border-slate-200/50 flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4 shadow-sm',
            !isToolbarStuck && '-mx-4 md:-mx-8',
          )}
        >
        {/* Heading + Add Files share one row on mobile so the upload box doesn't
            push the toolbar down a whole extra row; `md:contents` removes this
            wrapper from the desktop layout so heading/box/toolbar go back to
            being three independent flex-row siblings, unchanged from before. */}
        <div className="flex items-center justify-between gap-3 md:contents">
        <div className="flex items-center gap-3 min-w-0 md:flex-none">
          {/* Embed only — the iframe has no "Back to Templates" destination to
              push to (that's dashboard-only, see the HeaderContext effect
              above). Deliberately NOT router.back()/history.back(): a nested
              iframe shares its ONE browser-tab history with the parent page
              (there is no separate per-iframe back stack), so calling it here
              could navigate the PARENT printo.in page backward — or, if the
              tab's history has nothing printo.in-related immediately prior,
              take the customer off printo.in's site entirely mid-checkout.
              Instead this mirrors the existing pe:render_job pattern: tell the
              parent the customer wants to go back and let THEIR app decide
              what that means. No-op until printo.in adds a listener — see
              docs/INTEGRATION.md. */}
          {embedToken && (
            <button
              onClick={() => window.parent.postMessage({ type: 'pe:back', orderID: orderId }, parentOrigin)}
              aria-label="Back"
              title="Back"
              className="p-2 md:p-2.5 rounded-full hover:bg-slate-100 transition-all text-slate-600 hover:text-slate-900 shrink-0"
            >
              <ArrowLeft className="w-4 h-4 md:w-5 md:h-5" />
            </button>
          )}
          <img src="/printo-logo.webp" alt="Printo" className="h-10 md:h-12 w-auto shrink-0" />
          <div className="w-px h-8 md:h-10 bg-slate-200 shrink-0" />
          {/* Layout name display — hidden per CEO request (2026-09-09), restored per
              management feedback (2026-09-15): the original ask was to drop the raw
              technical identifier (e.g. "retro_polaroid_-_4.2x3.5_in"), not the name
              entirely. Prefer the ops-curated displayName (2026-09-16) — a real field
              ops can write a clean product name into — over formatLayoutDisplayName(),
              which is only a mechanical fallback for a layout that predates the field. */}
          <h1 className="text-xl md:text-2xl font-black text-slate-900 tracking-tighter truncate">
            {layout?.displayName || formatLayoutDisplayName(layout?.name || layoutName)}
          </h1>
        </div>
        {/* Top upload section — hidden when empty (empty state shows primary upload
            area only); revealed once user uploads at least one photo (secondary "Add more" action).
            Also hidden while the qty-shortfall banner is up (EditorBanners) — its own "Upload More"
            button already does the exact same thing, so showing both at once read as two
            competing ways to add photos rather than one clear one. */}
        {(files.length > 0 || surfaceStates.some(s => s.files.length > 0)) && !qtyUnder && (
          <div className="shrink-0 max-w-[55%] md:w-full md:max-w-md md:flex-1 md:shrink relative group">
            {qtyNeeded > 0 && totalUploadedCount >= qtyNeeded ? (
              // Order quantity fully met — show plain info, not a clickable
              // "add more" pill: clicking it would immediately hit the
              // over-qty hard-cap modal (there's nowhere left to add to),
              // so an actionable-looking control here is a dead end.
              <div className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 rounded-2xl border border-emerald-200/60 bg-emerald-50/30">
                <div className="w-7 h-7 md:w-8 md:h-8 rounded-xl flex items-center justify-center shrink-0 bg-emerald-500 text-white">
                  <Check className="w-3.5 h-3.5 md:w-4 md:h-4" />
                </div>
                <p className="flex-1 min-w-0 truncate text-[10px] md:text-[11px] font-black text-emerald-700/80 uppercase tracking-tight">
                  {`${totalUploadedCount} of ${qtyNeeded} images uploaded`}
                </p>
              </div>
            ) : (
              <div
                className={clsx("relative flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 rounded-2xl border-2 border-dashed transition-all cursor-pointer", 'border-emerald-200 bg-emerald-50/30')}
                role="button"
                tabIndex={0}
                onClick={() => uploadInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    uploadInputRef.current?.click();
                  }
                }}
              >
                <div className="w-7 h-7 md:w-8 md:h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm bg-emerald-500 text-white">
                  <Plus className="w-3.5 h-3.5 md:w-4 md:h-4" />
                </div>
                <p className="flex-1 min-w-0 truncate text-[10px] md:text-[11px] font-black text-slate-800/70 uppercase tracking-tight">
                  <span className="md:hidden">
                    {`Add Files (${totalUploadedCount}${qtyNeeded ? `/${qtyNeeded}` : ''})`}
                  </span>
                  <span className="hidden md:inline">
                    {`Add Photos | Currently uploaded (${totalUploadedCount}${qtyNeeded ? ` of ${qtyNeeded}` : ''})`}
                  </span>
                </p>
              </div>
            )}
          </div>
        )}
        </div>
        <div className="flex items-center justify-center flex-nowrap gap-1 md:gap-3 w-full md:w-auto">
          <div className="flex items-center bg-slate-100/80 p-1 rounded-xl border border-slate-200/50 shrink-0">
            {(['contain', 'cover'] as FitMode[]).map(mode => (
              <button key={mode} onClick={() => { if (mode !== globalFitMode) { fitModeUserToggledRef.current = true; setGlobalFitMode(mode); } }} className={clsx('px-2 md:px-3 py-1.5 text-[9px] md:text-[10px] font-black rounded-lg transition-all uppercase', globalFitMode === mode ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500')}>{mode === 'contain' ? 'Fit' : 'Cover'}</button>
            ))}
          </div>
          <button
            onClick={() => { blurFillUserToggledRef.current = true; setGlobalBlurFill(v => !v); }}
            title={globalBlurFill
              ? 'Blur Effect is ON — empty space is filled with a blurred copy of the photo. Click to turn off.'
              : 'Blur Effect — fill the empty space around a photo with a blurred copy of it.'}
            aria-label="Toggle blur effect"
            className={clsx(
              'flex items-center justify-center gap-1 md:gap-1.5 px-2 md:px-3 py-2.5 md:py-2 text-[9px] md:text-[10px] font-black rounded-xl border transition-all uppercase tracking-tight md:tracking-wide shrink-0',
              globalBlurFill
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-slate-100/80 text-slate-500 border-slate-200/50 hover:text-slate-700',
            )}>
            <Droplets className="w-3.5 h-3.5 md:w-3.5 md:h-3.5 shrink-0" />
            <span className="whitespace-nowrap">Blur Effect</span>
          </button>
          {/* Reposition-lock toggle — hidden from the UI on request, kept
              in source in case it needs to come back. repositionMode
              itself is untouched (still gates drag-to-pan in page.tsx) and
              stays at its default (locked) with no way to flip it now.
          <button
            onClick={() => setRepositionMode(v => !v)}
            title={repositionMode
              ? 'Reposition on — drag a photo inside its card. Click to lock.'
              : 'Photos are locked. Click to drag-reposition them.'}
            aria-label={repositionMode ? 'Lock photos' : 'Unlock photos to reposition'}
            className={clsx(
              'hidden md:flex items-center justify-center gap-1.5 p-2.5 md:px-3 md:py-2 text-[10px] font-black rounded-xl border transition-all uppercase tracking-wide',
              repositionMode
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-slate-100/80 text-slate-500 border-slate-200/50 hover:text-slate-700',
            )}>
            {repositionMode ? <Move className="w-4 h-4 md:w-3.5 md:h-3.5" /> : <Lock className="w-4 h-4 md:w-3.5 md:h-3.5" />}
            <span className="hidden md:inline">{repositionMode ? 'Reposition' : 'Locked'}</span>
          </button>
          */}
          {embedToken ? (
            <button onClick={() => { setDisclaimerChecked(false); setShowEmbedDisclaimer(true); }} disabled={isDownloading || (files.length === 0 && !surfaceStates.some(s => s.files.length > 0))} aria-label="Save and continue" className="flex items-center justify-center gap-2 text-[11px] font-black text-white bg-indigo-600 p-2.5 md:px-5 md:py-2.5 rounded-xl hover:bg-indigo-700 transition-all uppercase tracking-widest">
              {isDownloading ? <Loader2 className="w-4 h-4 md:w-3.5 md:h-3.5 animate-spin" /> : <SendHorizonal className="w-4 h-4 md:w-3.5 md:h-3.5" />} <span className="hidden md:inline">Save &amp; Continue</span>
            </button>
          ) : (
            <button onClick={() => { setDisclaimerChecked(false); setShowDownloadModal(true); }} disabled={files.length === 0 && !surfaceStates.some(s => s.files.length > 0)} aria-label="Download" className="flex items-center justify-center gap-1 md:gap-2 text-[9px] md:text-[11px] font-black text-white bg-slate-900 px-2.5 md:px-5 py-2.5 rounded-xl hover:bg-slate-800 transition-all uppercase tracking-tight md:tracking-widest shrink-0">
              <Download className="w-3.5 h-3.5 md:w-3.5 md:h-3.5 shrink-0" /> <span className="whitespace-nowrap">Download</span>
            </button>
          )}
        </div>
      </div>
      </div>
    </>
  );
}

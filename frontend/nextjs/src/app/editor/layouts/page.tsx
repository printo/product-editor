'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import {
  Layout,
  Plus,
  Trash2,
  Save,
  AlertCircle,
  Loader2,
  X,
  Copy,
  Type,
  ZoomIn,
  ZoomOut,
  Maximize2,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  CalendarDays,
  LayoutTemplate as TemplateIcon,
  Tag as TagIcon,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { GoogleFontLinks } from '@/components/GoogleFontLinks';
import { SearchInput } from '@/components/ui/SearchInput';
import { TagFilter } from '@/components/ui/TagFilter';
import { Toast, ToastStack } from '@/components/ui/Toast';
import { useHeader } from '@/context/HeaderContext';
import { canManageTemplates } from '@/lib/roles';
import { useLayoutTags } from '@/lib/layout-tags';
import { mmToUnit, unitToMm } from '@/lib/units';
import { TagPicker } from '@/components/ui/TagPicker';
import { MaskSlotRow } from './MaskSlotRow';
import { DeleteLayoutDialog } from './dialogs/DeleteLayoutDialog';
import { FontPickerModal } from './dialogs/FontPickerModal';
import { useOpsFonts } from './useOpsFonts';
import { useModalScrollRestore } from './useModalScrollRestore';
import { useEditFromAddress } from './useEditFromAddress';
import { useLayoutList } from './useLayoutList';
import { useLayoutForm } from './useLayoutForm';
import { LayoutCard } from './LayoutCard';
import { CreateLayoutCards } from './CreateLayoutCards';
import { LayoutSpecModal } from './dialogs/LayoutSpecModal';
import { RemoveMaskDialog } from './dialogs/RemoveMaskDialog';
import {
  buildLayoutFormData, EMPTY_SLOT, framesOutOfBounds, mmToPx, round2, WHOLE_CANVAS,
  type LayoutConfig, type SurfaceEditorState,
} from './layout-form-utils';

// LayoutFabricPreview pulls in Fabric.js (~400 KB gz). Defer its load until
// the layouts list itself has rendered so the chooser UI paints fast and
// fabric streams in alongside the row-by-row mounts. ssr:false because Fabric
// references `window`. The placeholder matches the preview's aspect-ratio
// container so the grid doesn't reflow when previews finish loading.
const LayoutFabricPreview = dynamic(
  () => import('./LayoutFabricPreview').then(m => ({ default: m.LayoutFabricPreview })),
  {
    ssr: false,
    loading: () => <div className="absolute inset-0 bg-slate-100 animate-pulse rounded-md" />,
  },
);

export default function LayoutCreatorPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { setTitle, setDescription, setCenterActions, setRightActions, headerHeight } = useHeader();

  // All API calls go through the server-side internal proxy at
  // /api/internal/proxy/*.  The proxy is gated by the NextAuth session cookie
  // and injects the server-only INTERNAL_API_KEY.  ops/* paths used to be
  // further gated to session.is_ops_team there; that gate was removed so any
  // authenticated user can manage templates, same as this page.

  const {
    layouts, isLoading, fetchLayouts, visibleLayouts,
    searchQuery, setSearchQuery, activeTagFilter, setActiveTagFilter, showDeleted, setShowDeleted,
  } = useLayoutList(status);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Feedback surfaces as a fixed bottom-right toast that auto-dismisses after
  // 5s (see <ToastStack> below). It replaced a top-of-page inline banner, which
  // sat off-screen whenever the action was triggered from a scrolled-down row.

  // JSON Specification modal — "Copied" confirmation on the copy button.
  const [specCopied, setSpecCopied] = useState(false);
  const handleCopySpec = useCallback(async (json: string) => {
    try {
      await navigator.clipboard.writeText(json);
      setSpecCopied(true);
      setTimeout(() => setSpecCopied(false), 2000);
    } catch {
      // Clipboard API needs a secure context (https or localhost) and can be
      // blocked by permissions policy inside an iframe — surface it rather
      // than leaving the button looking inert.
      setError('Could not copy to clipboard. Select the JSON and copy manually.');
    }
  }, []);

  const {
    isEditMode,
    layoutName,
    setLayoutName,
    layoutId,
    setLayoutId,
    tagKeys,
    setTagKeys,
    dpi,
    setDpi,
    widthMm,
    setWidthMm,
    heightMm,
    setHeightMm,
    frameCaptionsEnabled,
    setFrameCaptionsEnabled,
    orientationRotatable,
    setOrientationRotatable,
    frames,
    setFrames,
    frameMask,
    setFrameMask,
    printSheet,
    setPrintSheet,
    frameMaskInputRef,
    maskWarning,
    layoutType,
    setLayoutType,
    surfaces,
    setSurfaces,
    activeSurfaceIdx,
    setActiveSurfaceIdx,
    snapGrid,
    setSnapGrid,
    zoom,
    setZoom,
    unit,
    setUnit,
    lengthStep,
    showLength,
    readLength,
    rows,
    setRows,
    cols,
    setCols,
    padding,
    setPadding,
    showGridGen,
    setShowGridGen,
    validationError,
    activeFrames,
    activeWidthMm,
    activeHeightMm,
    activeDpi,
    activeFrameMask,
    activePrintSheet,
    activePrintSheetJson,
    setActiveFrameMask,
    setActivePrintSheet,
    removeActiveMask,
    setActiveFrames,
    handleGenerateGrid,
    loadForEdit,
    loadForCopy,
    resetForCreate,
    checkMaskTransparency,
    updateFrame,
    centerFrame,
  } = useLayoutForm();
  const [selectedLayout, setSelectedLayout] = useState<LayoutConfig | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [confirmMaskRemove, setConfirmMaskRemove] = useState(false);
  const [isModalOpen, setIsModalOpen] = useModalScrollRestore();
  // An import of an old design that is adjusting this layout before its
  // artwork is cut to it (components/ImportDesignDialog.tsx): the layout's
  // name, and the design's pictures to show behind the print areas.
  const [importFor, setImportFor] = useState<string | null>(null);
  const [importGuide, setImportGuide] = useState<{ url: string; widthMm: number; heightMm: number } | null>(null);

  // Derived in render, not inside the effect: depending on `session` itself
  // would re-run this on every identity change from useSession's polling, and
  // the effect only ever needs the yes/no.
  const canManageHolidays = canManageTemplates({
    is_staff: session?.is_staff,
    is_ops_team: session?.is_ops_team,
  });
  const { tags: tagList, error: tagListError } = useLayoutTags(status === 'authenticated');

  const { selectedFonts, setSelectedFonts, fontsLoaded, loadGoogleFont, isSavingFonts, saveFontsToBackend } = useOpsFonts(session?.accessToken);
  const [showFontModal, setShowFontModal] = useState(false);
  const [fontSearch, setFontSearch] = useState('');

  // Selected frame in Fabric preview
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);

  useEffect(() => {
    if (isModalOpen) {
      setTitle(isEditMode ? 'Edit Layout' : 'Create Layout');
      setDescription('Define canvas dimensions and print areas');
      setCenterActions(null);
      setRightActions(
        <button
          onClick={() => setIsModalOpen(false)}
          aria-label="Close Editor"
          className="flex items-center gap-1.5 p-2.5 md:px-3 md:py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-full md:rounded border border-slate-200 hover:border-slate-300 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Close Editor</span>
        </button>
      );
    } else {
      setTitle('');
      setDescription('');
      setCenterActions(
        <div className="flex items-center gap-2 flex-1 min-w-0 md:flex-none md:w-full md:max-w-[900px]">
          {/* !w-auto + min-w-0 override SearchInput's mobile w-[175px] shrink-0 so
              this row (search + filter + Fonts + nav) can fit a 375px viewport. */}
          <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={`Filter across ${layouts.length} layouts`} className="flex-1 min-w-0 !w-auto" />
          <TagFilter value={activeTagFilter} onChange={setActiveTagFilter} tags={tagList} className="hidden xl:flex" />
          <button
            onClick={() => setShowFontModal(true)}
            aria-label="Fonts"
            title={`Fonts (${selectedFonts.length})`}
            className="flex items-center gap-1.5 px-2.5 py-2.5 md:px-3 md:py-2 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
          >
            <Type className="w-4 h-4 md:w-3.5 md:h-3.5" />
            <span className="hidden xl:inline">Fonts ({selectedFonts.length})</span>
          </button>
          {/* On phones the top row has no room for it; it sits beside the tag filter in the page instead. */}
          {canManageHolidays && (
            <Link
              href="/editor/layouts/holidays"
              aria-label="Holidays"
              title="Holidays printed on calendars"
              className="hidden md:flex items-center gap-1.5 px-2.5 py-2.5 md:px-3 md:py-2 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
            >
              <CalendarDays className="w-4 h-4 md:w-3.5 md:h-3.5" />
              <span className="hidden 2xl:inline">Holidays</span>
            </Link>
          )}
          {canManageHolidays && (
            <Link
              href="/editor/layouts/tags"
              aria-label="Tags"
              title="Layout tags"
              className="hidden md:flex items-center gap-1.5 px-2.5 py-2.5 md:px-3 md:py-2 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
            >
              <TagIcon className="w-4 h-4 md:w-3.5 md:h-3.5" />
              <span className="hidden 2xl:inline">Tags</span>
            </Link>
          )}
          {canManageHolidays && (
            <Link
              href="/editor/layouts/templates"
              aria-label="Templates"
              title="Every template, by size and layout"
              className="hidden md:flex items-center gap-1.5 px-2.5 py-2.5 md:px-3 md:py-2 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
            >
              <TemplateIcon className="w-4 h-4 md:w-3.5 md:h-3.5" />
              <span className="hidden 2xl:inline">Templates</span>
            </Link>
          )}
        </div>
      );
      // The Django admin link lives on the header's role badge (HeaderUserMenu),
      // so this page adds no action of its own: a button here collided with
      // the Fonts button once the search row got narrow.
      setRightActions(null);
    }
    // activeTagFilter is a dep because centerActions is a captured JSX snapshot —
    // without it the dropdown would keep rendering the tag selected at mount.
    // The access flag likewise: the Holidays link is in that snapshot, so it
    // would stay hidden for an ops user whose session resolved after mount.
  }, [isModalOpen, setIsModalOpen, isEditMode, setTitle, setDescription, setCenterActions, setRightActions, searchQuery, setSearchQuery, activeTagFilter, setActiveTagFilter, tagList, selectedFonts.length, layouts.length, canManageHolidays]);


  useEffect(() => {
    // Template management (including the Fonts list) is open to any
    // authenticated user — not just is_ops_team — per product decision.
    if (status === 'unauthenticated' || session?.error === 'RefreshAccessTokenError') {
      router.push('/login');
    }
  }, [status, session, router]);




  const handleCreateLayout = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    // Layout name (identifier) becomes part of the embed iframe URL and the
    // API path, so it can't carry spaces or characters that need escaping —
    // same rule Calendar/Book editors already enforce on their own identifier
    // field. Checked before setIsSaving so a bad id never shows a spinner.
    if (!/^[a-z0-9_-]+$/i.test(layoutId)) {
      setError('Layout name (identifier) may contain letters, digits, hyphen, underscore only — no spaces or special characters.');
      return;
    }

    setIsSaving(true);

    // Validate bounds for active frame set
    const framesToCheck = layoutType === 'product' ? surfaces.flatMap(s => s.frames.map(f => ({ f, w: s.widthMm, h: s.heightMm }))) : frames.map(f => ({ f, w: widthMm, h: heightMm }));
    const outOfBounds = framesOutOfBounds(framesToCheck);

    if (outOfBounds && !window.confirm("Some Print Areas are out of the canvas bounds. Save anyway?")) {
      setIsSaving(false);
      return;
    }

    const formData = buildLayoutFormData({
      layoutId, layoutName, layoutType, tagKeys, frameCaptionsEnabled, orientationRotatable,
      surfaces, widthMm, heightMm, dpi, frames, frameMask, printSheet,
    });

    try {
      const res = await fetch('/api/internal/proxy/ops/layouts', {
        method: 'POST',
        headers: {
          'Accept': 'application/json'
          // NOTE: Do NOT set Content-Type here – the browser sets it automatically
          // with the correct multipart boundary for FormData
        },
        body: formData
      });

      const result = await res.json();
      if (res.ok) {
        if (importFor && importFor === layoutId) {
          router.push('/editor/layouts/templates?import=continue');
          return;
        }
        setSuccess(`Layout "${layoutName}" saved successfully!`);
        fetchLayouts();
        setIsModalOpen(false);
      } else {
        setError(result.detail || 'Failed to save layout');
      }
    } catch {
      setError('An error occurred while saving.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteLayout = async (layoutName: string) => {
    try {
      const res = await fetch(`/api/internal/proxy/ops/layouts/${layoutName}`, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' }
      });

      if (res.ok) {
        setSuccess(`Layout ${layoutName} deleted.`);
        fetchLayouts();
      } else {
        const text = await res.text();
        let detail = 'Failed to delete layout';
        try {
          const result = JSON.parse(text);
          detail = result.detail || detail;
        } catch { }
        setError(detail);
      }
    } catch {
      setError('An error occurred while deleting.');
    }
  };

  const fetchLayoutDetail = async (targetLayout: string) => {
    if (!targetLayout) return null;
    try {
      const res = await fetch(`/api/internal/proxy/ops/layouts/${targetLayout}`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return null;
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        console.error('Invalid JSON in layout detail', e);
        return null;
      }
    } catch (err) {
      console.error('Failed to fetch layout detail', err);
      return null;
    }
  };

  const openViewModal = async (layoutName: string) => {
    const data = await fetchLayoutDetail(layoutName);
    if (data) setSelectedLayout(data);
  };


  const openEditModal = async (name: string) => {
    const data = await fetchLayoutDetail(name);
    if (data) {
      loadForEdit(name, data);
      setIsModalOpen(true);
    }
  };

  useEditFromAddress(status, openEditModal, setImportFor, setImportGuide);
  useEffect(() => () => { if (importGuide) URL.revokeObjectURL(importGuide.url); }, [importGuide]);
  const importing = isModalOpen && importFor !== null && importFor === layoutId;

  const openCopyModal = async (name: string) => {
    const data = await fetchLayoutDetail(name);
    if (data) {
      loadForCopy(name, data);
      setIsModalOpen(true);
    }
  };

  const openCreateModal = () => {
    resetForCreate();
    setIsModalOpen(true);
  };


  if (status === 'loading' || isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  return (
    // While the full-screen editor is open the page behind it must not scroll.
    // That used to be a write to document.body.style in an effect (which also put
    // back 'auto' rather than whatever was there). Now the page is simply as tall
    // as the space under the header and clips what overflows it, so the document
    // has nothing to scroll; the modal itself is overscroll-contain.
    <div
      style={isModalOpen ? { height: `calc(100dvh - ${headerHeight}px)` } : undefined}
      className={isModalOpen ? 'overflow-hidden bg-transparent flex flex-col' : 'min-h-screen bg-transparent flex flex-col'}
    >
      <GoogleFontLinks fonts={fontsLoaded} />
      <main className="max-w-[1440px] mx-auto px-8 pt-3 pb-8 w-full">

        <ToastStack>
          <Toast message={error} tone="error" onDismiss={() => setError(null)} />
          <Toast message={success} tone="success" onDismiss={() => setSuccess(null)} />
        </ToastStack>

        {/* Below xl the header has no room for the tag filter (the search box shrank to its
            icon), and on phones none for Holidays either, so they sit here instead. */}
        <div className="flex xl:hidden items-center gap-2 mb-4">
          <TagFilter value={activeTagFilter} onChange={setActiveTagFilter} tags={tagList} className="flex flex-1 min-w-0 md:flex-none" />
          {canManageHolidays && (
            <Link
              href="/editor/layouts/holidays"
              className="md:hidden flex items-center gap-1.5 px-3 py-2.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 shrink-0"
            >
              <CalendarDays className="w-4 h-4" />
              Holidays
            </Link>
          )}
          {canManageHolidays && (
            <Link
              href="/editor/layouts/tags"
              className="md:hidden flex items-center gap-1.5 px-3 py-2.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 shrink-0"
            >
              <TagIcon className="w-4 h-4" />
              Tags
            </Link>
          )}
          {canManageHolidays && (
            <Link
              href="/editor/layouts/templates"
              className="md:hidden flex items-center gap-1.5 px-3 py-2.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 shrink-0"
            >
              <TemplateIcon className="w-4 h-4" />
              Templates
            </Link>
          )}
        </div>

        {layouts.some((l: any) => typeof l === 'object' && l.isDeprecated) && (
          <div className="flex justify-end mb-4">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(e) => setShowDeleted(e.target.checked)}
                className="rounded border-slate-300 text-[#64318E] focus:ring-[#64318E]"
              />
              Show deleted ({layouts.filter((l: any) => typeof l === 'object' && l.isDeprecated).length})
            </label>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <CreateLayoutCards openCreateModal={openCreateModal} />

          {visibleLayouts
            .map((layoutObj: any) => (
              <LayoutCard
                key={typeof layoutObj === 'string' ? layoutObj : layoutObj.name}
                layoutObj={layoutObj}
                openCopyModal={openCopyModal}
                openEditModal={openEditModal}
                openViewModal={openViewModal}
                setDeleteConfirm={setDeleteConfirm}
              />
            ))}

          {layouts.length === 0 && (
            <div className="col-span-full py-20 bg-white border border-dashed border-slate-300 rounded-xl flex flex-col items-center justify-center text-slate-400">
              <div className="p-4 bg-slate-50 rounded-full mb-4">
                <Layout className="w-8 h-8 opacity-20" />
              </div>
              <p className="font-medium">No layouts found in backend storage.</p>
              <button
                onClick={openCreateModal}
                className="mt-4 text-indigo-600 font-bold hover:underline"
              >
                Create your first layout
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Create / Edit Modal (Full Screen mode - sits under the persistent Header) */}
      {isModalOpen && (
        <div style={{ top: headerHeight }} className="fixed inset-x-0 bottom-0 z-[1000] flex flex-col bg-white overflow-hidden overscroll-contain">
          <div className="flex-1 flex flex-col min-h-0">
            {/* Redundant local header removed — Titles now in global header */}

            <div className="flex-1 min-h-0 bg-slate-50/50">
              {/* Below lg this collapses to one column, i.e. two stacked rows in a
                  fixed-height grid. Without explicit row sizing the tall form row
                  eats the height and the preview row shrinks to nothing — its
                  header/footer are shrink-0 so they stayed visible while the
                  canvas between them collapsed to 0px. */}
              <form id="layout-form" onSubmit={handleCreateLayout} className="grid grid-cols-1 grid-rows-[minmax(0,1fr)_auto] lg:grid-rows-1 lg:grid-cols-12 h-full overflow-hidden">

                {/* Left Column: Form Controls (Scrollable) */}
                <div className="lg:col-span-7 min-h-0 lg:h-full overflow-y-auto px-6 py-6 space-y-6 custom-scrollbar">

                  {importing && (
                    <div role="status" className="bg-indigo-50 border border-indigo-200 text-indigo-900 text-sm px-4 py-3 rounded-lg leading-relaxed">
                      <span className="font-bold">Imported design.</span> The print areas were made from the old design&rsquo;s photo
                      spaces, with no bleed{importGuide ? ', and its pictures are shown behind them' : ''}. Set the size and the print
                      areas, then press Update Layout: the artwork is cut to them and the template editor opens next.
                    </div>
                  )}

                  {/* Basic Info & Canvas */}
                  <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Display Name</label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. Classic Print 4x6"
                          value={layoutName}
                          onChange={(e) => setLayoutName(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-slate-900"
                        />
                      </div>
                      <div>
                        <TagPicker tags={tagList} value={tagKeys} onChange={setTagKeys} error={tagListError} />
                      </div>
                    </div>

                    {/* Layout name (identifier) — its own field, independently
                        typed, matching the Calendar/Book editors exactly
                        (2026-09-16). Becomes part of the embed iframe URL and
                        the API path, so letters/digits/hyphen/underscore only
                        — validated on submit in handleCreateLayout. Immutable
                        once created, so it's frozen (disabled) in edit mode;
                        edit Display Name instead. */}
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                        Layout Name (Identifier)
                      </label>
                      <input
                        type="text"
                        required
                        disabled={isEditMode}
                        value={layoutId}
                        onChange={(e) => setLayoutId(e.target.value)}
                        placeholder="e.g. classic_print_4x6"
                        className="w-full px-3 py-2.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-mono text-sm text-slate-900 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
                      />
                      <p className="text-[11px] text-slate-400 mt-1.5">
                        {isEditMode
                          ? 'Cannot be changed once created — edit Display Name instead.'
                          : 'Letters, digits, hyphen, underscore only — no spaces or special characters (used in URLs).'}
                      </p>
                    </div>

                    {/* Layout Type Toggle */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Layout Type</label>
                        <div className="flex items-center gap-2" title="Unit for every size on this page. Layouts are always saved in millimetres.">
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Units</span>
                          <div role="radiogroup" aria-label="Measurement unit" className="flex rounded-lg border border-slate-200 overflow-hidden">
                            {(['mm', 'in'] as const).map(u => (
                              <button
                                key={u}
                                type="button"
                                role="radio"
                                aria-checked={unit === u}
                                onClick={() => setUnit(u)}
                                className={`px-3 py-1 text-[10px] font-black uppercase transition-all ${unit === u ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                              >
                                {u}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => {
                            if (layoutType === 'product' && surfaces.length > 0) {
                              // Copy first surface to flat state
                              const s = surfaces[0];
                              setWidthMm(s.widthMm); setHeightMm(s.heightMm); setDpi(s.dpi);
                              setFrames(s.frames); setFrameMask(s.frameMask); setPrintSheet(s.printSheet);
                            }
                            setLayoutType('single');
                          }}
                          className={`flex-1 px-4 py-2 text-xs font-bold transition-all ${layoutType === 'single' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                        >
                          Single Canvas
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (layoutType === 'single') {
                              // Init surfaces from current flat state
                              setSurfaces([{
                                key: 'front', label: 'Front',
                                widthMm, heightMm, dpi, frames,
                                frameMask, printSheet,
                              }]);
                              setActiveSurfaceIdx(0);
                            }
                            setLayoutType('product');
                          }}
                          className={`flex-1 px-4 py-2 text-xs font-bold transition-all ${layoutType === 'product' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                        >
                          Multi-Surface Product
                        </button>
                      </div>
                    </div>

                    {/* Surface Tab Bar (multi-surface only) */}
                    {layoutType === 'product' && (
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Surfaces</label>
                        <div className="flex flex-wrap items-center gap-2">
                          {surfaces.map((s, i) => (
                            <div key={i} className="flex items-center">
                              <button
                                type="button"
                                onClick={() => setActiveSurfaceIdx(i)}
                                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${activeSurfaceIdx === i ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                              >
                                {s.label || s.key}
                              </button>
                              <button
                                type="button"
                                title="Duplicate this surface (dimensions + print areas)"
                                onClick={() => {
                                  setSurfaces(prev => {
                                    const src = prev[i];
                                    const existing = new Set(prev.map(s2 => s2.key));
                                    const base = `${src.key}-copy`;
                                    let key = base, n = 2;
                                    while (existing.has(key)) key = `${base}-${n++}`;
                                    const clone: SurfaceEditorState = {
                                      ...src,
                                      key,
                                      label: `${src.label} copy`,
                                      // Fresh frame ids so edits/selection don't bleed across surfaces.
                                      frames: src.frames.map(f => ({ ...f, id: Math.random().toString(36).slice(2, 11) })),
                                    };
                                    return [...prev.slice(0, i + 1), clone, ...prev.slice(i + 1)];
                                  });
                                  setActiveSurfaceIdx(i + 1);
                                }}
                                className="ml-0.5 p-0.5 text-slate-300 hover:text-indigo-500 transition-colors"
                              >
                                <Copy className="w-3 h-3" />
                              </button>
                              {surfaces.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSurfaces(prev => prev.filter((_, j) => j !== i));
                                    setActiveSurfaceIdx(prev => Math.min(prev, surfaces.length - 2));
                                  }}
                                  className="ml-0.5 p-0.5 text-slate-300 hover:text-rose-500 transition-colors"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              const n = surfaces.length + 1;
                              setSurfaces(prev => [...prev, {
                                key: `surface-${n}`, label: `Surface ${n}`,
                                widthMm: 101.6, heightMm: 152.4, dpi: 300,
                                frames: [], frameMask: EMPTY_SLOT, printSheet: WHOLE_CANVAS,
                              }]);
                              setActiveSurfaceIdx(surfaces.length);
                            }}
                            className="px-3 py-1.5 text-xs font-bold bg-slate-50 border border-dashed border-slate-300 text-slate-500 rounded-lg hover:border-indigo-400 hover:text-indigo-600 transition-all flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Surface Label & auto-derived Key (multi-surface only) */}
                    {layoutType === 'product' && surfaces[activeSurfaceIdx] && (
                      <div className="grid grid-cols-2 gap-3 p-3 bg-indigo-50/50 rounded-lg border border-indigo-100">
                        <div>
                          <label className="block text-[10px] font-bold text-indigo-600 uppercase mb-1">Display Label</label>
                          <input
                            type="text"
                            value={surfaces[activeSurfaceIdx].label}
                            onChange={(e) => {
                              const label = e.target.value;
                              const key = label.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                              setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, label, key: key || s.key } : s));
                            }}
                            className="w-full px-2 py-1.5 text-xs rounded border border-indigo-200"
                            placeholder="e.g. Front"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Surface Key</label>
                          <input
                            type="text"
                            value={surfaces[activeSurfaceIdx].key}
                            readOnly
                            className="w-full px-2 py-1.5 text-xs rounded border border-slate-200 font-mono bg-slate-100 text-slate-500 cursor-not-allowed"
                          />
                        </div>
                      </div>
                    )}

                  <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">Canvas Dimensions</h4>
                      <div className="text-[10px] text-indigo-600 bg-indigo-50/50 px-2 py-1 rounded-md font-black uppercase tracking-tight inline-block border border-indigo-100/50">
                        Final Pixels: {Math.round(mmToPx(activeWidthMm, activeDpi))} x {Math.round(mmToPx(activeHeightMm, activeDpi))} px
                      </div>
                      <label className="flex items-center text-xs font-medium text-slate-600 gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={snapGrid} onChange={(e) => setSnapGrid(e.target.checked)} className="rounded text-indigo-600 focus:ring-indigo-500" />
                        Snap to Grid
                      </label>
                    </div>
                    
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Width ({unit})</label>
                        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100 focus-within:border-indigo-300 transition-colors">
                          <input
                            type="number" step={lengthStep} min="0" required
                            value={mmToUnit(activeWidthMm, unit)}
                            onChange={(e) => {
                              const v = unitToMm(Number(e.target.value), unit);
                              if (layoutType === 'product') {
                                setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, widthMm: v } : s));
                              } else {
                                setWidthMm(v);
                              }
                            }}
                            className="bg-transparent text-[11px] font-black text-slate-800 outline-none w-full"
                          />
                          <span className="text-[9px] font-black text-slate-300 uppercase">{unit}</span>
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Height ({unit})</label>
                        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100 focus-within:border-indigo-300 transition-colors">
                          <input
                            type="number" step={lengthStep} min="0" required
                            value={mmToUnit(activeHeightMm, unit)}
                            onChange={(e) => {
                              const v = unitToMm(Number(e.target.value), unit);
                              if (layoutType === 'product') {
                                setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, heightMm: v } : s));
                              } else {
                                setHeightMm(v);
                              }
                            }}
                            className="bg-transparent text-[11px] font-black text-slate-800 outline-none w-full"
                          />
                          <span className="text-[9px] font-black text-slate-300 uppercase">{unit}</span>
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">DPI</label>
                        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100 focus-within:border-indigo-300 transition-colors">
                          <input 
                            type="number" min="300" required
                            value={layoutType === 'product' && surfaces[activeSurfaceIdx] ? surfaces[activeSurfaceIdx].dpi : dpi}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              if (layoutType === 'product') {
                                setSurfaces(prev => prev.map((s, i) => i === activeSurfaceIdx ? { ...s, dpi: v } : s));
                              } else {
                                setDpi(v);
                              }
                            }}
                            className="bg-transparent text-[11px] font-black text-slate-800 outline-none w-full"
                          />
                          <span className="text-[9px] font-black text-slate-300 uppercase">dpi</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  </div>

                  {/* Masks and the print sheet */}
                  <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-5">
                    <div>
                      <label className="block text-xs font-bold text-indigo-600 uppercase tracking-wider">Masks (Optional)</label>
                      <p className="text-[10px] text-slate-500 mt-1">
                        PNG or SVG with transparent holes where the photos show. A mask shows in every preview and never prints. Artwork that prints belongs on a template, on the Templates page.
                      </p>
                    </div>
                    <MaskSlotRow
                      title="Frame picture"
                      hint="Outside the print areas — shown in every preview and the mock, never printed"
                      slot={activeFrameMask}
                      inputRef={frameMaskInputRef}
                      warning={maskWarning}
                      onPick={(file) => { setActiveFrameMask({ url: activeFrameMask.url, file }); checkMaskTransparency(file); }}
                      onRemove={() => setConfirmMaskRemove(true)}
                    />

                  </div>

                  {/* Print Areas Management */}
                  <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-bold text-indigo-600 uppercase tracking-wider focus:outline-none">Print Areas Management ({unit})</label>
                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 font-semibold cursor-pointer transition-colors" title="Let customers add a caption to each print area in the editor">
                          <input type="checkbox" checked={frameCaptionsEnabled} onChange={(e) => setFrameCaptionsEnabled(e.target.checked)} className="rounded text-indigo-600 focus:ring-indigo-500" />
                          Captions
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 font-semibold cursor-pointer transition-colors" title="Allow the embedding site to ask for the other orientation (portrait or landscape). The layout is turned a quarter turn; photos are re-fitted into the turned areas. Off keeps it as authored.">
                          <input type="checkbox" checked={orientationRotatable} onChange={(e) => setOrientationRotatable(e.target.checked)} className="rounded text-indigo-600 focus:ring-indigo-500" />
                          Can rotate
                        </label>
                        <button type="button" onClick={() => setShowGridGen(!showGridGen)} className="text-xs text-slate-500 hover:text-indigo-600 font-semibold transition-colors">Grid Gen</button>
                        <button type="button" onClick={() => setActiveFrames(prev => [...prev, { id: Math.random().toString(36).slice(2, 11), xMm: 0, yMm: 0, widthMm: 50, heightMm: 50, bleedMm: 0, x: 0, y: 0, width: 0, height: 0 }])} className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1"><Plus className="w-3 h-3" /> Add Area</button>
                      </div>
                    </div>

                    {validationError && (
                      <div className="px-3 py-2 bg-amber-50 border border-amber-200 text-amber-700 text-[10px] font-bold rounded-lg flex items-center gap-2">
                        <AlertCircle className="w-3.5 h-3.5" />
                        {validationError}
                      </div>
                    )}

                    {showGridGen && (
                      <div className="p-4 bg-slate-50 rounded-lg border border-slate-100 flex items-end gap-3">
                        <div><label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Rows</label><input type="number" min="1" value={rows} onChange={e => setRows(Number(e.target.value))} className="w-16 px-2 py-1.5 text-sm rounded border border-slate-200" /></div>
                        <div><label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Cols</label><input type="number" min="1" value={cols} onChange={e => setCols(Number(e.target.value))} className="w-16 px-2 py-1.5 text-sm rounded border border-slate-200" /></div>
                        <div><label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Pad ({unit})</label><input type="number" min="0" step={lengthStep} value={mmToUnit(padding, unit)} onChange={e => setPadding(round2(unitToMm(Number(e.target.value), unit)))} className="w-20 px-2 py-1.5 text-sm rounded border border-slate-200" /></div>
                        <button type="button" onClick={handleGenerateGrid} className="px-4 py-1.5 bg-slate-800 text-white rounded text-xs font-bold hover:bg-slate-700">Replace & Generate</button>
                      </div>
                    )}

                    <div className="flex items-center gap-2 px-2 pb-1 border-b border-slate-100 pr-24">
                      <span className="w-6 shrink-0"></span>
                      <div className="flex-1 min-w-0"><label className="text-[10px] font-bold text-slate-400 uppercase">X</label></div>
                      <div className="flex-1 min-w-0"><label className="text-[10px] font-bold text-slate-400 uppercase">Y</label></div>
                      <div className="flex-1 min-w-0"><label className="text-[10px] font-bold text-slate-400 uppercase">W</label></div>
                      <div className="flex-1 min-w-0"><label className="text-[10px] font-bold text-slate-400 uppercase">H</label></div>
                      <div className="w-16 shrink-0"><label className="text-[10px] font-bold text-slate-500 uppercase text-center block" title="The strip beyond the print area that is hidden under the frame or trimmed after printing. A 'Bleed area' print file includes it.">Bleed</label></div>
                      <div className="w-16 shrink-0"><label className="text-[10px] font-bold text-teal-500 uppercase text-center block">Corner</label></div>
                    </div>

                    <div className="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                      {activeFrames.length === 0 ? (
                        <div className="text-center py-6 text-sm text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">No print areas added yet. Use Grid Gen or Add Area.</div>
                      ) : activeFrames.map((f, i) => (
                        <div key={f.id} className="bg-slate-50 p-2 rounded-lg border border-slate-100 group space-y-2">
                          <div className="flex items-center gap-2">
                            <span className="w-6 shrink-0 text-center text-xs font-bold text-slate-400">#{i + 1}</span>
                            <input type="number" min="0" step={lengthStep} value={showLength(f.xMm)} onChange={e => updateFrame(f.id!, 'xMm', readLength(e.target.value))} className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" title={`X (${unit})`} />
                            <input type="number" min="0" step={lengthStep} value={showLength(f.yMm)} onChange={e => updateFrame(f.id!, 'yMm', readLength(e.target.value))} className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" title={`Y (${unit})`} />
                            <input type="number" min="0" step={lengthStep} value={showLength(f.widthMm)} onChange={e => updateFrame(f.id!, 'widthMm', readLength(e.target.value))} className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" title={`W (${unit})`} />
                            <input type="number" min="0" step={lengthStep} value={showLength(f.heightMm)} onChange={e => updateFrame(f.id!, 'heightMm', readLength(e.target.value))} className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" title={`H (${unit})`} />
                            <input type="number" min="0" step={lengthStep} value={showLength(f.bleedMm)} onChange={e => updateFrame(f.id!, 'bleedMm', readLength(e.target.value))} className="w-16 shrink-0 px-2 py-1.5 text-xs rounded border border-slate-200 bg-slate-100 text-slate-600 font-bold" title={`Bleed (${unit}) — the strip beyond the print area, hidden under the frame or trimmed; a 'Bleed area' print file includes it`} />
                            <input type="number" min="0" step={lengthStep} value={showLength(f.borderRadiusMm)} onChange={e => updateFrame(f.id!, 'borderRadiusMm', readLength(e.target.value))} className="w-16 shrink-0 px-2 py-1.5 text-xs rounded border border-teal-100 bg-teal-50 text-teal-600 font-bold" title={`Corner Radius (${unit})`} />
                            <div className="flex items-center gap-1 shrink-0 md:opacity-0 group-hover:opacity-100 transition-all">
                              <button type="button" onClick={() => centerFrame(f.id!, 'h')} className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Center Horizontally"><AlignCenter className="w-3.5 h-3.5" /></button>
                              <button type="button" onClick={() => centerFrame(f.id!, 'v')} className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Center Vertically"><AlignJustify className="w-3.5 h-3.5" /></button>
                              <button type="button" onClick={() => setActiveFrames(prev => prev.filter(fr => fr.id !== f.id))} className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded" title="Delete Area"><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                          </div>
                          {frameCaptionsEnabled && (
                            <div className="pl-8 pr-2 space-y-2">
                              <div className="flex items-center gap-2">
                                <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase shrink-0 cursor-pointer" title="Show this area's caption in the printed output">
                                  <input type="checkbox" checked={Boolean(f.captionEnabled)} onChange={e => setActiveFrames(prev => prev.map(fr => fr.id === f.id ? { ...fr, captionEnabled: e.target.checked } : fr))} className="rounded text-indigo-600 focus:ring-indigo-500" />
                                  Caption
                                </label>
                                <input type="text" value={f.caption ?? ''} onChange={e => setActiveFrames(prev => prev.map(fr => fr.id === f.id ? { ...fr, caption: e.target.value } : fr))} placeholder="Default caption text (optional)" className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded border border-slate-200" />
                              </div>
                              {f.captionEnabled && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <div className="flex items-center gap-1" title={`Caption font size (${unit})`}>
                                    <span className="text-[9px] font-bold text-slate-400 uppercase">Font</span>
                                    <input type="number" min={unit === 'in' ? '0.04' : '1'} step={unit === 'in' ? '0.01' : '0.1'}
                                      value={showLength(f.captionFontMm ?? round2(Number(f.heightMm || 0) * 0.04))}
                                      onChange={e => setActiveFrames(prev => prev.map(fr => fr.id === f.id ? { ...fr, captionFontMm: readLength(e.target.value) } : fr))}
                                      className="w-14 px-2 py-1 text-xs rounded border border-slate-200" />
                                    <span className="text-[9px] text-slate-300">{unit}</span>
                                  </div>
                                  <div className="flex items-center gap-0.5 border border-slate-200 rounded-lg p-0.5">
                                    {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([a, Icon]) => {
                                      const active = (f.captionAlign ?? 'center') === a;
                                      return (
                                        <button key={a} type="button" title={`Align ${a}`}
                                          onClick={() => setActiveFrames(prev => prev.map(fr => fr.id === f.id ? { ...fr, captionAlign: a } : fr))}
                                          className={`p-1 rounded ${active ? 'bg-indigo-100 text-indigo-600' : 'text-slate-400 hover:text-indigo-600'}`}>
                                          <Icon className="w-3.5 h-3.5" />
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <input type="color" value={typeof f.captionColor === 'string' ? f.captionColor : '#2a2a2a'}
                                    onChange={e => setActiveFrames(prev => prev.map(fr => fr.id === f.id ? { ...fr, captionColor: e.target.value } : fr))}
                                    className="w-7 h-7 rounded border border-slate-200 cursor-pointer bg-white" title="Caption colour" />
                                  <span className="text-[9px] text-slate-400 italic">drag the box in the preview to place</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Print file: what the print file is. A per-layout output setting,
                      separate from the print areas, which only place the photos. */}
                  <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-3">
                    <label className="block text-xs font-bold text-indigo-600 uppercase tracking-wider">Print file</label>
                    <div className="flex rounded-lg border border-slate-200 overflow-hidden" role="radiogroup" aria-label="Print file">
                      {([['canvas', 'Whole canvas'], ['bleed', 'Bleed area']] as const).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={activePrintSheet.mode === mode}
                          onClick={() => setActivePrintSheet(p => ({ ...p, mode }))}
                          className={`flex-1 px-4 py-2 text-xs font-bold transition-all ${activePrintSheet.mode === mode ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-slate-500">
                      {activePrintSheet.mode === 'bleed'
                        ? 'The file is cut to the bleed area: the box around the print areas plus their Bleed, the rose dashed line in the preview. It moves with them.'
                        : 'The file is the whole canvas, edge to edge: the rose dashed line around the preview.'}
                    </p>
                  </div>

                </div>

                {/* Right Column: Live Preview (Fixed Viewport) */}
                <div className="lg:col-span-5 h-[50vh] lg:h-full bg-slate-50 border-t lg:border-t-0 lg:border-l border-slate-200">
                  <div className="h-full flex flex-col overflow-hidden">
                    <div className="p-3 border-b border-slate-100 bg-white shrink-0 flex items-center justify-between">
                      <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">Live Preview (To Scale)</label>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => setZoom(z => Math.max(0.1, z - 0.1))} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><ZoomOut className="w-3.5 h-3.5" /></button>
                        <span className="text-[10px] font-bold text-slate-500 w-10 text-center">{Math.round(zoom * 100)}%</span>
                        <button type="button" onClick={() => setZoom(z => Math.min(3, z + 0.1))} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><ZoomIn className="w-3.5 h-3.5" /></button>
                        <button type="button" onClick={() => setZoom(1)} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><Maximize2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                    <div className="flex-1 relative flex items-center justify-center overflow-hidden">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <LayoutFabricPreview
                          widthMm={activeWidthMm}
                          heightMm={activeHeightMm}
                          dpi={activeDpi}
                          frames={activeFrames}
                          frameMask={activeFrameMask}
                          printSheet={activePrintSheetJson}
                          guide={importing ? importGuide : null}
                          snapGrid={snapGrid}
                          onFramesChange={setActiveFrames}
                          onFrameSelect={setSelectedFrameId}
                          selectedFrameId={selectedFrameId}
                          zoom={zoom}
                          captionsEnabled={frameCaptionsEnabled}
                        />
                      </div>
                    </div>
                    <div className="p-3 border-t border-slate-100 bg-white shrink-0 text-center">
                      <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">Areas: {activeFrames.length} &middot; {activeDpi} DPI</p>
                      <div className="flex justify-center gap-4 mt-1.5 font-bold uppercase tracking-[0.05em]">
                        <span className="flex items-center text-[8px] text-emerald-600 gap-1"><div className="w-1.5 h-1.5 rounded-sm border border-emerald-400 border-dashed"></div> Print area</span>
                        <span className="flex items-center text-[8px] text-rose-400 gap-1"><div className="w-1.5 h-1.5 rounded-sm border border-rose-300 border-dotted"></div> Bleed</span>
                        <span className="flex items-center text-[8px] text-rose-600 gap-1"><div className="w-1.5 h-1.5 rounded-sm border-2 border-rose-500 border-dashed"></div> Print file</span>
                      </div>
                    </div>
                  </div>
                </div>

              </form>
            </div>

            <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/30 flex justify-end gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-tight text-slate-500 hover:bg-slate-100 hover:text-slate-700 rounded-lg transition-all"
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                type="submit"
                form="layout-form"
                disabled={isSaving || !layoutName}
                className="px-5 py-1.5 bg-indigo-600 text-white text-[11px] font-bold uppercase tracking-tight rounded-lg hover:bg-indigo-700 shadow-sm transition-all flex items-center gap-2 disabled:opacity-50 active:scale-95"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {isEditMode ? 'Update Layout' : 'Create Layout'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmMaskRemove && (
        <RemoveMaskDialog
          onCancel={() => setConfirmMaskRemove(false)}
          onConfirm={() => { removeActiveMask(); setConfirmMaskRemove(false); }}
        />
      )}

      {/* Compact Delete Confirmation Modal */}
      {deleteConfirm && (
        <DeleteLayoutDialog
          name={deleteConfirm}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => {
            handleDeleteLayout(deleteConfirm);
            setDeleteConfirm(null);
          }}
        />
      )}

          {/* View Specification Modal */}
          {selectedLayout && (
            <LayoutSpecModal
              layout={selectedLayout}
              copied={specCopied}
              onCopy={handleCopySpec}
              onClose={() => setSelectedLayout(null)}
            />
          )}

          {/* Google Fonts Picker Modal */}
          {showFontModal && (
            <FontPickerModal
              search={fontSearch}
              onSearch={setFontSearch}
              selectedFonts={selectedFonts}
              fontsLoaded={fontsLoaded}
              loadGoogleFont={loadGoogleFont}
              isSaving={isSavingFonts}
              onChange={(next) => {
                setSelectedFonts(next);
                saveFontsToBackend(next);
              }}
              onClose={() => setShowFontModal(false)}
            />
          )}
        </div>
      );
}

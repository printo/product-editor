'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import {
  Layout,
  Loader2,
  CalendarDays,
  LayoutTemplate as TemplateIcon,
  Tag as TagIcon,
} from 'lucide-react';
import Link from 'next/link';
import { GoogleFontLinks } from '@/components/GoogleFontLinks';
import { TagFilter } from '@/components/ui/TagFilter';
import { Toast, ToastStack } from '@/components/ui/Toast';
import { useHeader } from '@/context/HeaderContext';
import { canManageTemplates } from '@/lib/roles';
import { useLayoutTags } from '@/lib/layout-tags';
import { DeleteLayoutDialog } from './dialogs/DeleteLayoutDialog';
import { FontPickerModal } from './dialogs/FontPickerModal';
import { useOpsFonts } from './useOpsFonts';
import { useModalScrollRestore } from './useModalScrollRestore';
import { useEditFromAddress } from './useEditFromAddress';
import { useLayoutList } from './useLayoutList';
import { useLayoutForm } from './useLayoutForm';
import { useLayoutsHeader } from './useLayoutsHeader';
import { LayoutEditorModal } from './LayoutEditorModal';
import { LayoutCard } from './LayoutCard';
import { CreateLayoutCards } from './CreateLayoutCards';
import { LayoutSpecModal } from './dialogs/LayoutSpecModal';
import { RemoveMaskDialog } from './dialogs/RemoveMaskDialog';
import {
  buildLayoutFormData, framesOutOfBounds,
  type LayoutConfig,
} from './layout-form-utils';

export default function LayoutCreatorPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { headerHeight } = useHeader();

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

  const form = useLayoutForm();
  const {
    isEditMode,
    layoutName,
    layoutId,
    tagKeys,
    dpi,
    widthMm,
    heightMm,
    frameCaptionsEnabled,
    orientationRotatable,
    frames,
    frameMask,
    printSheet,
    layoutType,
    surfaces,
    removeActiveMask,
    loadForEdit,
    loadForCopy,
    resetForCreate,
  } = form;
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

  useLayoutsHeader({
    isModalOpen, setIsModalOpen, isEditMode, searchQuery, setSearchQuery, activeTagFilter, setActiveTagFilter,
    tagList, selectedFonts, layouts, canManageHolidays, setShowFontModal,
  });


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
        <LayoutEditorModal
          form={form}
          headerHeight={headerHeight}
          isSaving={isSaving}
          handleCreateLayout={handleCreateLayout}
          setIsModalOpen={setIsModalOpen}
          setConfirmMaskRemove={setConfirmMaskRemove}
          selectedFrameId={selectedFrameId}
          setSelectedFrameId={setSelectedFrameId}
          importing={importing}
          importGuide={importGuide}
          tagList={tagList}
          tagListError={tagListError}
        />
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

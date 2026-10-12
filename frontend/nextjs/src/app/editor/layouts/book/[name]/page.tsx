'use client';

/**
 * Ops-only wrapper page that hosts BookLayoutEditor with real load + save
 * plumbing. Mirrors /editor/layouts/calendar/[name]/page.tsx's shape
 * exactly (BOOK_LAYOUT_PRD.md §6 Phase 5) — no palette/holiday fetches, since
 * books need neither.
 *
 * Routes:
 *   /editor/layouts/book/new         → blank editor
 *   /editor/layouts/book/<existing>  → fetch + populate editor
 *
 * All API calls go through `/api/internal/proxy/*` — the server-side proxy
 * gated by the NextAuth session cookie + ops-team check.
 *
 * `name` is immutable once a layout exists (2026-09-16) — the editor locks
 * that field for an existing layout (isExistingLayout prop) and there is no
 * rename path any more; edit displayName for anything customer-facing.
 */

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useHeader } from '@/context/HeaderContext';
import {
  BookLayoutEditor,
  type BookLayoutDraft,
  type BookMaskFiles,
  type BookRoleDraft,
} from '@/components/BookLayoutEditor';

interface ExistingRoleJson {
  canvas?: { width?: number; height?: number; widthMm?: number; heightMm?: number; dpi?: number };
  frames?: Array<{ x: number; y: number; width: number; height: number }>;
  maskUrl?: string | null;
  maskOnExport?: boolean;
}

interface ExistingLayoutJson {
  name: string;
  displayName?: string;
  productType?: string;
  book?: {
    bleedMm?: number;
    gutterMm?: number;
    paperThicknessMm?: number;
    coverThicknessMm?: number;
    pageCount?: { min?: number; max?: number; step?: number; default?: number };
    cover?: ExistingRoleJson;
    innerPage?: ExistingRoleJson;
    backCover?: ExistingRoleJson;
  };
}

function roleFromJson(role: ExistingRoleJson | undefined, fallback: BookRoleDraft): BookRoleDraft {
  if (!role) return fallback;
  const dpi = role.canvas?.dpi ?? fallback.dpi;
  // A pixels-only canvas (hand-authored JSON) converts back to mm rather than
  // resetting to the fallback size.
  const mm = (px: number | undefined) => (px ? Math.round((px * 25.4 / dpi) * 10) / 10 : undefined);
  return {
    canvasWidthMm: role.canvas?.widthMm ?? mm(role.canvas?.width) ?? fallback.canvasWidthMm,
    canvasHeightMm: role.canvas?.heightMm ?? mm(role.canvas?.height) ?? fallback.canvasHeightMm,
    dpi,
    frames: role.frames ?? fallback.frames,
    maskUrl: role.maskUrl ?? null,
    maskOnExport: role.maskOnExport ?? false,
  };
}

function existingToInitial(layout: ExistingLayoutJson): Partial<BookLayoutDraft> {
  const book = layout.book ?? {};
  const fallbackRole: BookRoleDraft = {
    canvasWidthMm: 210, canvasHeightMm: 297, dpi: 300,
    frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }],
  };
  return {
    name: layout.name,
    displayName: layout.displayName ?? '',
    bleedMm: book.bleedMm ?? 3,
    gutterMm: book.gutterMm ?? 10,
    paperThicknessMm: book.paperThicknessMm ?? 0.12,
    coverThicknessMm: book.coverThicknessMm ?? 0,
    pageCountMin: book.pageCount?.min ?? 20,
    pageCountMax: book.pageCount?.max ?? 60,
    pageCountStep: book.pageCount?.step ?? 4,
    pageCountDefault: book.pageCount?.default ?? 24,
    cover: roleFromJson(book.cover, fallbackRole),
    innerPage: roleFromJson(book.innerPage, fallbackRole),
    hasBackCover: Boolean(book.backCover),
    backCover: roleFromJson(book.backCover, fallbackRole),
  };
}

export default function BookLayoutEditorPage() {
  const router = useRouter();
  const params = useParams<{ name: string }>();
  const routeName = String(params?.name ?? 'new');
  const isNew = routeName === 'new';

  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();
  useEffect(() => {
    setTitle('Book Editor');
    setDescription(isNew ? 'New book layout' : `Editing ${routeName}`);
    setCenterActions(null);
    setRightActions(null);
    return () => {
      setTitle('');
      setDescription('');
      setCenterActions(null);
      setRightActions(null);
    };
  }, [isNew, routeName, setTitle, setDescription, setCenterActions, setRightActions]);

  const [initial, setInitial] = useState<Partial<BookLayoutDraft> | null>(null);
  const [baseLayout, setBaseLayout] = useState<Record<string, unknown> | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setLoading(true);
      setLoadError(null);
      try {
        if (!isNew) {
          const res = await fetch(`/api/internal/proxy/layouts/${encodeURIComponent(routeName)}`);
          if (!res.ok) {
            throw new Error(`Layout '${routeName}' not found (HTTP ${res.status}).`);
          }
          const existing = (await res.json()) as ExistingLayoutJson;
          if (cancelled) return;
          if (existing.productType !== 'book') {
            setLoadError(
              `Layout '${routeName}' is productType=${existing.productType ?? 'undefined'}, ` +
              `not 'book'. Use the regular layout editor.`,
            );
          } else {
            setInitial(existingToInitial(existing));
            setBaseLayout(existing as unknown as Record<string, unknown>);
          }
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    bootstrap();
    return () => { cancelled = true; };
  }, [isNew, routeName]);

  async function handleSave(
    layoutJson: Record<string, unknown>,
    displayName: string,
    maskFiles: BookMaskFiles,
  ): Promise<Record<string, unknown> | undefined> {
    const name = String(layoutJson.name ?? routeName);
    if (!name) throw new Error('Layout name missing from serialised JSON.');

    // `name` is immutable once created (2026-09-16) — the editor locks the
    // identifier input once isExistingLayout is true, so this is always a
    // create (isNew) or an update to the SAME name, never a rename.
    // New mask PNGs go up as multipart (`mask_<role>`): the server stores
    // each one and sets that role's maskUrl. JSON otherwise, as before.
    const masks = Object.entries(maskFiles).filter((e): e is [string, File] => Boolean(e[1]));
    let init: RequestInit;
    if (masks.length) {
      const form = new FormData();
      form.append('name', name);
      form.append('display_name', displayName);
      form.append('layout_data', JSON.stringify(layoutJson));
      for (const [role, file] of masks) form.append(`mask_${role}`, file);
      init = { method: 'POST', body: form };
    } else {
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, display_name: displayName, layout_data: layoutJson }),
      };
    }

    const res = await fetch(`/api/internal/proxy/ops/layouts/${encodeURIComponent(name)}`, init);
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error((detail as { detail?: string }).detail || `Save failed (HTTP ${res.status}).`);
    }
    const saved = (await res.json().catch(() => ({}))) as { layout?: Record<string, unknown> };
    // The next save merges into what is now stored, not the layout as loaded.
    if (saved.layout) setBaseLayout(saved.layout);

    if (isNew) {
      router.replace(`/editor/layouts/book/${encodeURIComponent(name)}`);
    }
    return saved.layout;
  }

  if (loading) {
    return <div className="p-8 text-zinc-500 text-sm">Loading book layout editor…</div>;
  }

  if (loadError) {
    return (
      <div className="p-8">
        <div className="rounded-md bg-red-50 border border-red-200 text-red-700 p-4 text-sm">
          {loadError}
        </div>
        <button
          type="button"
          onClick={() => router.push('/editor/layouts')}
          className="mt-3 text-sm text-zinc-600 hover:text-zinc-900 underline"
        >
          ← back to layouts
        </button>
      </div>
    );
  }

  return (
    <BookLayoutEditor
      initial={initial ?? undefined}
      newLayoutName={isNew ? 'untitled_book' : routeName}
      isExistingLayout={!isNew}
      baseLayout={baseLayout}
      onSave={handleSave}
      onCancel={() => router.push('/editor/layouts')}
    />
  );
}

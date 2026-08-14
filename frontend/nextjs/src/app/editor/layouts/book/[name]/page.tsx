'use client';

/**
 * Ops-only wrapper page that hosts BookLayoutEditor with real load + save +
 * rename plumbing. Mirrors /editor/layouts/calendar/[name]/page.tsx's shape
 * exactly (BOOK_LAYOUT_PRD.md §6 Phase 5) — no palette/holiday fetches, since
 * books need neither.
 *
 * Routes:
 *   /editor/layouts/book/new         → blank editor
 *   /editor/layouts/book/<existing>  → fetch + populate editor
 *
 * All API calls go through `/api/internal/proxy/*` — the server-side proxy
 * gated by the NextAuth session cookie + ops-team check.
 */

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useHeader } from '@/context/HeaderContext';
import {
  BookLayoutEditor,
  type BookLayoutDraft,
  type BookRoleDraft,
} from '@/components/BookLayoutEditor';

interface ExistingRoleJson {
  canvas?: { width?: number; height?: number; widthMm?: number; heightMm?: number; dpi?: number };
  frames?: Array<{ x: number; y: number; width: number; height: number }>;
}

interface ExistingLayoutJson {
  name: string;
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
  return {
    canvasWidthMm: role.canvas?.widthMm ?? fallback.canvasWidthMm,
    canvasHeightMm: role.canvas?.heightMm ?? fallback.canvasHeightMm,
    dpi: role.canvas?.dpi ?? fallback.dpi,
    frames: role.frames ?? fallback.frames,
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
  const [originalName, setOriginalName] = useState<string | null>(null);
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
            setOriginalName(existing.name);
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

  async function handleSave(layoutJson: Record<string, unknown>) {
    const name = String(layoutJson.name ?? routeName);
    if (!name) throw new Error('Layout name missing from serialised JSON.');

    const body: Record<string, unknown> = { name, layout_data: layoutJson };
    if (originalName && originalName !== name) {
      body.old_name = originalName;
    }

    const res = await fetch(`/api/internal/proxy/ops/layouts/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error((detail as { detail?: string }).detail || `Save failed (HTTP ${res.status}).`);
    }

    if ((originalName && originalName !== name) || isNew) {
      router.replace(`/editor/layouts/book/${encodeURIComponent(name)}`);
    } else {
      setOriginalName(name);
    }
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
      onSave={handleSave}
      onCancel={() => router.push('/editor/layouts')}
    />
  );
}

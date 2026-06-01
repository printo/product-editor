'use client';

/**
 * Ops-only wrapper page that hosts CalendarLayoutEditor with real
 * load + save + rename plumbing.
 *
 * Routes:
 *   /editor/layouts/calendar/new            → blank editor
 *   /editor/layouts/calendar/<existing>     → fetch + populate editor
 *
 * All API calls go through `/api/internal/proxy/*` — the server-side
 * proxy gated by the NextAuth session cookie + ops-team check. No
 * customer-facing exposure. Mirrors the existing /editor/layouts page's
 * proxy convention.
 *
 * Phase 6 review fixes #7 (rename) + #8 (load existing).
 */

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useHeader } from '@/context/HeaderContext';
import { CalendarLayoutEditor, type CalendarLayoutDraft } from '@/components/CalendarLayoutEditor';
import type {
  LayoutCalendarStyle,
  GenzPalette,
  HolidayEntry,
  LayoutCalendar,
} from '@/types/calendar';

interface ExistingLayoutJson {
  name: string;
  productType?: string;
  canvas?: {
    width?: number;
    height?: number;
    widthMm?: number;
    heightMm?: number;
    dpi?: number;
  };
  frames?: Array<{ x: number; y: number; width: number; height: number }>;
  calendars?: LayoutCalendar[];
  calendar?: LayoutCalendarStyle;
  monthRange?: { count?: number; defaultYear?: number | 'current' };
  maskUrl?: string | null;
  maskOnExport?: boolean;
  // Per-month overrides (PRD §10.2.1) — must round-trip through the editor
  // or re-saving an existing layout would wipe all customisations. Holistic-
  // audit fix.
  surfaceOverrides?: import('@/types/calendar').SurfaceOverrideMap;
}

function existingToInitial(layout: ExistingLayoutJson): Partial<CalendarLayoutDraft> {
  const count = layout.monthRange?.count ?? 12;
  const calCount = layout.calendars?.length ?? 1;
  return {
    name: layout.name,
    mode: count === 1 && calCount === 12 ? 'poster' : 'multi-surface',
    canvasWidthMm: layout.canvas?.widthMm ?? 127,
    canvasHeightMm: layout.canvas?.heightMm ?? 177.8,
    dpi: layout.canvas?.dpi ?? 300,
    frames: layout.frames ?? [],
    calendars: layout.calendars ?? [],
    style: layout.calendar,
    defaultYear: layout.monthRange?.defaultYear ?? 'current',
    maskUrl: layout.maskUrl ?? null,
    maskOnExport: layout.maskOnExport ?? false,
    surfaceOverrides: layout.surfaceOverrides,
  };
}

export default function CalendarLayoutEditorPage() {
  const router = useRouter();
  const params = useParams<{ name: string }>();
  const routeName = String(params?.name ?? 'new');
  const isNew = routeName === 'new';

  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();
  useEffect(() => {
    setTitle('Calendar Editor');
    setDescription(isNew ? 'New calendar layout' : `Editing ${routeName}`);
    setCenterActions(null);
    setRightActions(null);
    return () => {
      setTitle('');
      setDescription('');
      setCenterActions(null);
      setRightActions(null);
    };
  }, [isNew, routeName, setTitle, setDescription, setCenterActions, setRightActions]);

  const [initial, setInitial] = useState<Partial<CalendarLayoutDraft> | null>(null);
  const [originalName, setOriginalName] = useState<string | null>(null);
  const [genzPalettes, setGenzPalettes] = useState<GenzPalette[]>([]);
  const [previewHolidays, setPreviewHolidays] = useState<HolidayEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch the existing layout JSON (if any) + Gen-Z palettes + sample holidays
  // for the live preview thumb.
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setLoading(true);
      setLoadError(null);
      try {
        const tasks: Promise<unknown>[] = [
          fetch('/api/internal/proxy/calendar-styles/modern-genz').then((r) =>
            r.ok ? r.json() : null,
          ),
          fetch(`/api/internal/proxy/holidays/en-IN/${new Date().getFullYear()}`).then(
            (r) => (r.ok ? r.json() : { events: [] }),
          ),
        ];
        if (!isNew) {
          tasks.push(
            fetch(`/api/internal/proxy/layouts/${encodeURIComponent(routeName)}`).then(
              async (r) => {
                if (!r.ok) {
                  throw new Error(`Layout '${routeName}' not found (HTTP ${r.status}).`);
                }
                return r.json();
              },
            ),
          );
        }
        const [styleRes, holRes, existing] = await Promise.all(tasks);
        if (cancelled) return;

        const palettes = (styleRes as { palettes?: GenzPalette[] } | null)?.palettes ?? [];
        setGenzPalettes(palettes);
        const events = (holRes as { events?: HolidayEntry[] })?.events ?? [];
        setPreviewHolidays(events);

        if (existing) {
          const layout = existing as ExistingLayoutJson;
          if (layout.productType !== 'calendar') {
            setLoadError(
              `Layout '${routeName}' is productType=${layout.productType ?? 'undefined'}, ` +
              `not 'calendar'. Use the regular layout editor.`,
            );
          } else {
            setInitial(existingToInitial(layout));
            setOriginalName(layout.name);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'Failed to load.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [isNew, routeName]);

  async function handleSave(layoutJson: Record<string, unknown>) {
    const name = String(layoutJson.name ?? routeName);
    if (!name) throw new Error('Layout name missing from serialised JSON.');

    // Rename detection (review fix #7): if the user changed the name on an
    // existing layout, tell the backend to clean up the old file by passing
    // old_name in the POST body. The backend handles both upsert + rename
    // semantics in api/views.py::LayoutManagementView.post.
    const body: Record<string, unknown> = {
      name,
      layout_data: layoutJson,
    };
    if (originalName && originalName !== name) {
      body.old_name = originalName;
    }

    const res = await fetch(
      `/api/internal/proxy/ops/layouts/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(
        (detail as { detail?: string }).detail || `Save failed (HTTP ${res.status}).`,
      );
    }

    // After a successful save: if we renamed, jump to the new URL.
    if (originalName && originalName !== name) {
      router.replace(`/editor/layouts/calendar/${encodeURIComponent(name)}`);
    } else if (isNew) {
      router.replace(`/editor/layouts/calendar/${encodeURIComponent(name)}`);
    } else {
      setOriginalName(name);
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-zinc-500 text-sm">
        Loading calendar layout editor…
      </div>
    );
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
    <CalendarLayoutEditor
      initial={initial ?? undefined}
      newLayoutName={isNew ? 'untitled_calendar' : routeName}
      genzPalettes={genzPalettes}
      previewHolidays={previewHolidays}
      onSave={handleSave}
      onCancel={() => router.push('/editor/layouts')}
    />
  );
}

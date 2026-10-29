'use client';

/**
 * /dashboard  —  Layout picker
 *
 * Clicking a layout card navigates to /editor/layout/[name] where the full
 * canvas editor lives. The tag filter and search ride the address
 * (lib/dashboard-filter.ts), read through useSearchParams, hence the Suspense.
 */

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SearchInput } from '@/components/ui/SearchInput';
import { useHeader } from '@/context/HeaderContext';
import { LayoutSVG } from '@/components/LayoutSVG';
import { ubuntu } from '@/lib/site-fonts';
import { TagFilter } from '@/components/ui/TagFilter';
import { layoutTagKeys, useLayoutTags } from '@/lib/layout-tags';
import { resolveMaskSlots } from '@/lib/mask-slots';
import { loginHref } from '@/lib/callback-url';
import { dashboardFilterQuery, readDashboardFilter, rememberDashboardFilter } from '@/lib/dashboard-filter';
import { layoutEditorHref, orientationLockedReason, type OrientationChoice, type OrientationInfo } from '@/lib/layout-orientation';

const LayoutPreview = ({ layout }: { layout: any }) => {
  const isMulti = layout.surfaceCount > 1;
  const raw = layout._raw;

  if (isMulti && raw?.surfaces) {
    return (
      <div className="w-full aspect-square relative flex items-center justify-center p-4 bg-slate-100 border-b border-slate-200 group-hover:bg-slate-200/50 group-active:bg-slate-200/50 transition-colors overflow-hidden">
        {/* Render up to 2 surfaces in a stacked/offset view */}
        <div className="relative w-full h-full flex items-center justify-center">
          {raw.surfaces.slice(0, 2).map((s: any, idx: number) => (
            <div
              key={s.key}
              className={clsx(
                "absolute transition-all duration-500 shadow-sm border border-slate-200/50 bg-white rounded-sm overflow-hidden",
                idx === 0
                  ? "w-[75%] h-[75%] z-10 -translate-x-3 -translate-y-3 group-hover:-translate-x-5 group-hover:-translate-y-5 group-active:-translate-x-5 group-active:-translate-y-5"
                  : "w-[75%] h-[75%] z-20 translate-x-3 translate-y-3 group-hover:translate-x-5 group-hover:translate-y-5 group-active:translate-x-5 group-active:translate-y-5"
              )}
            >
              <LayoutSVG layout={raw} surfaceKey={s.key} className="w-full h-full object-contain" />
              <div className="absolute bottom-0 left-0 right-0 bg-black/5 py-0.5 px-1">
                <p className="text-[6px] font-black uppercase text-slate-500 tracking-tighter text-center">{s.label}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Surface count indicator */}
        <div className="absolute top-3 right-3 z-30 flex items-center gap-1.5 px-2 py-1 bg-white/90 backdrop-blur-md border border-indigo-100 rounded-full shadow-sm">
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
          <span className="text-[9px] font-black text-indigo-600 uppercase tracking-tighter">
            {layout.surfaceCount} Surfaces
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full aspect-square flex items-center justify-center p-4 bg-slate-100 border-b border-slate-200 group-hover:bg-slate-200/50 group-active:bg-slate-200/50 transition-colors">
      <LayoutSVG layout={layout} />
    </div>
  );
};

/** Portrait / Landscape for one card. Fixed here, before the editor opens, so a
 *  design is never half one orientation and half the other. A layout that
 *  cannot be turned shows both locked, with the reason as the tooltip. */
const OrientationChoiceControl = ({ info, value, onChange }: {
  info: OrientationInfo | null;
  value: OrientationChoice | null;
  onChange: (choice: OrientationChoice) => void;
}) => {
  const locked = orientationLockedReason(info);
  const shown = locked ? null : value ?? (info?.orientation === 'portrait' || info?.orientation === 'landscape' ? info.orientation : null);
  return (
    <div
      role="group"
      aria-label="Print orientation"
      title={locked ?? 'Open this layout in portrait or landscape'}
      className={clsx('mt-3 flex items-center rounded-full border border-indigo-100 bg-slate-50 p-0.5', locked && 'opacity-50')}
    >
      {(['portrait', 'landscape'] as const).map(choice => (
        <button
          key={choice}
          type="button"
          disabled={Boolean(locked)}
          aria-pressed={shown === choice}
          onClick={() => onChange(choice)}
          className={clsx(
            'flex-1 px-2 py-1 rounded-full text-[10px] font-black uppercase tracking-widest transition-colors disabled:cursor-not-allowed',
            shown === choice ? 'bg-indigo-600 text-white' : 'text-indigo-600 hover:bg-indigo-50',
          )}
        >
          {choice}
        </button>
      ))}
    </div>
  );
};

export default function Dashboard() {
  return (
    <Suspense fallback={null}>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const [layouts, setLayouts] = useState<any[]>([]);
  const [isFetchingLayouts, setIsFetchingLayouts] = useState(false);
  const [searchQuery, setSearchQuery] = useState(() => readDashboardFilter(searchParams).q);
  // Tag filter: clicking a chip sets this; '' means "All". Independent of
  // the text search, same convention as the ops layout list.
  const [activeTagFilter, setActiveTagFilter] = useState(() => readDashboardFilter(searchParams).tag);
  const [error, setError] = useState<string | null>(null);
  // The orientation picked on each card; a card left alone opens as drawn.
  const [orientationChoice, setOrientationChoice] = useState<Record<string, OrientationChoice>>({});

  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();
  const { data: session, status } = useSession();
  const router = useRouter();
  const { tags: tagList } = useLayoutTags(status === 'authenticated');

  // Auth gate — without this, /dashboard renders for unauthenticated visitors
  // and only fails (silently) when the layouts fetch comes back empty/401.
  useEffect(() => {
    if (status === 'unauthenticated' || session?.error === 'RefreshAccessTokenError') {
      router.push('/login');
    }
  }, [status, session, router]);

  const normalizeLayoutItem = useCallback((item: any) => {
    if (typeof item === 'string') return { id: item, name: item, displayName: item, frames: [], tags: [], tagKeys: [], canvas: {}, surfaceCount: 0, templateCount: 0 };
    const isProduct = item.type === 'product' && Array.isArray(item.surfaces);
    const first = isProduct ? item.surfaces[0] : item;
    const canvas = first?.canvas;
    const frames = first?.frames || [];
    return {
      id: item.name,
      name: item.name,
      // Ops-curated customer-facing name (2026-09-16) — falls back to the raw
      // identifier only for a response that predates the field.
      displayName: item.displayName || item.name,
      dimensions: canvas?.widthMm && canvas?.heightMm
        ? `${canvas.widthMm.toFixed(2)}x${canvas.heightMm.toFixed(2)}mm`
        : null,
      canvas: canvas || {},
      frames,
      tags: item.tags || [],
      tagKeys: layoutTagKeys(item),
      // Both mask slots and the print sheet of the surface the card draws.
      ...resolveMaskSlots(first),
      printSheet: first?.printSheet ?? null,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      createdBy: item.createdBy || 'System',
      surfaceCount: isProduct ? item.surfaces.length : 0,
      templateCount: typeof item.templateCount === 'number' ? item.templateCount : 0,
      orientationInfo: (item.orientationInfo ?? null) as OrientationInfo | null,
      _raw: item,
    };
  }, []);

  const fetchLayouts = useCallback(async () => {
    setIsFetchingLayouts(true);
    try {
      // Use the server-side internal proxy — the API key never leaves the
      // Next.js server.  The proxy gates this on the NextAuth session cookie
      // which we've already validated above.
      let res = await fetch('/api/internal/proxy/layouts', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      // Defense-in-depth against a JWT refresh that just settled in another
      // request after we sent ours. If the proxy returns 401, force NextAuth
      // to re-resolve the cookie (which picks up the freshly-rotated tokens)
      // and retry once. The singleflight guard in `pia-auth.ts` means the
      // re-resolve is cheap — no second PIA call.
      if (res.status === 401) {
        await fetch('/api/auth/session', { cache: 'no-store' }).catch(() => {});
        res = await fetch('/api/internal/proxy/layouts', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
      }

      if (res.ok) {
        const data = await res.json();
        setLayouts((data.layouts || []).map(normalizeLayoutItem));
        setError(null);
      } else if (res.status === 401) {
        // Both attempts came back 401 — the refresh genuinely failed.
        // Send the user to /login so they can re-authenticate cleanly
        // instead of staring at "no layouts found".
        window.location.href = loginHref(window.location.pathname, window.location.search);
        return;
      } else {
        setError(`Failed to load layouts (${res.status}). The server may be unavailable.`);
      }
    } catch (err) {
      console.error('Failed to load layouts:', err);
      setError('Failed to load layouts. The server may be unavailable.');
    } finally {
      setIsFetchingLayouts(false);
    }
  }, [normalizeLayoutItem]);

  // Only fetch once the session is confirmed — avoids a 401 race on first paint.


  // UseEffects (Must be before any conditional return)
  useEffect(() => {
    setTitle('');
    setDescription('');
    setCenterActions(
      <div className="flex items-center gap-2 flex-1 min-w-0 md:flex-none md:w-full md:max-w-[900px]">
        {/* !w-auto + min-w-0 override SearchInput's mobile w-[175px] shrink-0 so
            search + filter + nav fit a 375px viewport without overlapping. */}
        <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={`Filter across ${layouts.length} layouts`} className="flex-1 min-w-0 !w-auto" />
        <TagFilter value={activeTagFilter} onChange={setActiveTagFilter} tags={tagList} className="hidden md:flex" />
      </div>
    );
    setRightActions(null);
    // activeTagFilter is a dep because centerActions is a captured JSX snapshot —
    // without it the dropdown would keep rendering the tag selected at mount.
  }, [searchQuery, activeTagFilter, tagList, setTitle, setDescription, setCenterActions, setRightActions, layouts.length]);

  // Replace, not push: each keystroke is not a history entry, and Back from
  // the editor lands on this one address with the filter in it.
  useEffect(() => {
    const filter = { tag: activeTagFilter, q: searchQuery };
    window.history.replaceState(null, '', `${window.location.pathname}${dashboardFilterQuery(filter)}`);
    rememberDashboardFilter(filter);
  }, [activeTagFilter, searchQuery]);

  useEffect(() => {
    if (status === 'authenticated') fetchLayouts();
  }, [status, fetchLayouts]);

  const filtered = layouts.filter(l => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = l.name.toLowerCase().includes(q) ||
      (l.tags && l.tags.some((t: string) => t.toLowerCase().includes(q)));
    const matchesTag = !activeTagFilter || l.tagKeys.includes(activeTagFilter);
    return matchesSearch && matchesTag;
  });

  return (
    <div className="min-h-screen bg-transparent flex flex-col">
      <main className="w-full px-8 pt-3 pb-8 flex-1">
        <div className="max-w-[1440px] mx-auto">

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl">
              {error}
            </div>
          )}

          {/* Mobile slot — the header row has no space for a fourth control. */}
          <TagFilter value={activeTagFilter} onChange={setActiveTagFilter} tags={tagList} className="flex md:hidden mb-4" />

          {isFetchingLayouts ? (
            <div className="flex justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 text-slate-500 bg-white rounded-2xl border shadow-sm">
              {layouts.length === 0
                ? 'No layouts found. Create one in the Layout Editor.'
                : 'No layouts match your search.'}
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3 sm:gap-6">
              {filtered.map((layout) => (
                <div
                  key={layout.id}
                  className="group bg-white rounded-2xl border border-slate-100/60 overflow-hidden hover:shadow-xl hover:shadow-indigo-500/10 active:shadow-xl active:shadow-indigo-500/10 transition-all duration-300 hover:-translate-y-1 active:-translate-y-1"
                >
                  {/* A plain link, not next/link: the editor reads its address
                      (?orientation= among it) while it first renders, and a
                      client-side transition renders it before the address bar
                      has changed, so the choice was silently dropped. */}
                  <a href={layoutEditorHref(layout.id, orientationChoice[layout.id] ?? null, layout.orientationInfo)} className="block">
                  <LayoutPreview layout={layout} />
                  <div className="p-3 sm:p-5 pb-0 sm:pb-0">
                    <h3 className={`${ubuntu.className} text-base font-bold text-slate-900/90 uppercase tracking-tight truncate group-hover:text-indigo-600 group-active:text-indigo-600 transition-colors`}>
                      {layout.displayName}
                    </h3>
                    {layout.dimensions && (
                      <p className={`${ubuntu.className} text-[11px] sm:text-[10px] text-slate-600/80 sm:text-slate-500/90 font-medium uppercase tracking-widest mt-1 flex items-center gap-1.5 sm:gap-2 flex-wrap`}>
                        <span>{layout.dimensions}</span>
                        <span>•</span>
                        <span>{layout.frames?.length || 0} Frames</span>
                        {layout.surfaceCount > 1 && (
                          <>
                            <span>•</span>
                            <span className="text-indigo-500 font-medium">Multi-Surface</span>
                          </>
                        )}
                        {layout.templateCount > 0 && (
                          <>
                            <span>•</span>
                            <span className="text-indigo-500 font-medium">{layout.templateCount} {layout.templateCount === 1 ? 'Template' : 'Templates'}</span>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  </a>
                  <div className="px-3 sm:px-5 pb-3 sm:pb-5">
                    <OrientationChoiceControl
                      info={layout.orientationInfo}
                      value={orientationChoice[layout.id] ?? null}
                      onChange={(choice) => setOrientationChoice(prev => ({ ...prev, [layout.id]: choice }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

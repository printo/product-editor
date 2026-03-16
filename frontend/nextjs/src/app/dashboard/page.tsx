'use client';

/**
 * /dashboard  —  Layout picker
 *
 * Internal users only (PIA session required).
 * Clicking a layout card navigates to /layout/[name] where the full
 * canvas editor lives.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { Loader2, Search } from 'lucide-react';
import { LayoutSVG } from '@/components/LayoutSVG';

const LayoutPreview = ({ layout }: { layout: any }) => (
  <div className="w-full aspect-square flex items-center justify-center p-4 bg-slate-50 border-b border-slate-100">
    <LayoutSVG layout={layout} />
  </div>
);

export default function Dashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [layouts, setLayouts] = useState<any[]>([]);
  const [isFetchingLayouts, setIsFetchingLayouts] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Redirect to login if unauthenticated
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
    }
  }, [status, router]);

  const normalizeLayoutItem = useCallback((item: any) => {
    if (typeof item === 'string') return { id: item, name: item, frames: [], tags: [], canvas: {}, surfaceCount: 0 };
    const isProduct = item.type === 'product' && Array.isArray(item.surfaces);
    const canvas = isProduct ? item.surfaces[0]?.canvas : item.canvas;
    const frames = isProduct ? item.surfaces[0]?.frames || [] : item.frames || [];
    return {
      id: item.name,
      name: item.name,
      dimensions: canvas?.widthMm && canvas?.heightMm
        ? `${canvas.widthMm.toFixed(2)}x${canvas.heightMm.toFixed(2)}mm`
        : null,
      canvas: canvas || {},
      frames,
      tags: item.tags || [],
      maskUrl: item.maskUrl || null,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      createdBy: item.createdBy || 'System',
      surfaceCount: isProduct ? item.surfaces.length : 0,
    };
  }, []);

  const fetchLayouts = useCallback(async () => {
    setIsFetchingLayouts(true);
    try {
      const res = await fetch('/api/layouts', {
        headers: {
          Authorization: `Bearer ${session?.accessToken}`,
          Accept: 'application/json',
        },
      });
      if (res.ok) {
        const data = await res.json();
        setLayouts((data.layouts || []).map(normalizeLayoutItem));
      } else {
        setError(`Failed to load layouts (${res.status}). The server may be unavailable.`);
      }
    } catch (err) {
      console.error('Failed to load layouts:', err);
      setError('Failed to load layouts. The server may be unavailable.');
    } finally {
      setIsFetchingLayouts(false);
    }
  }, [session?.accessToken, normalizeLayoutItem]);

  useEffect(() => {
    if (session?.accessToken) fetchLayouts();
  }, [session?.accessToken, fetchLayouts]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  const filtered = layouts.filter(l => {
    const q = searchQuery.toLowerCase();
    return l.name.toLowerCase().includes(q) ||
      (l.tags && l.tags.some((t: string) => t.toLowerCase().includes(q)));
  });

  return (
    <div className="min-h-screen bg-slate-50/50 flex flex-col">
      <Header />

      <main className="w-full px-8 py-8 flex-1">
        <div className="max-w-6xl mx-auto space-y-8">

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl">
              {error}
            </div>
          )}

          <div className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Select a Product Template</h1>
              <p className="text-slate-500 mt-1">Choose a layout to upload images and generate print canvases.</p>
            </div>
            <div className="relative w-full md:w-80 group">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
              <input
                type="text"
                placeholder="Search layouts or tags..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all text-sm"
              />
            </div>
          </div>

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
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {filtered.map(layout => (
                <div
                  key={layout.id}
                  onClick={() => router.push(`/layout/${layout.id}`)}
                  className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all cursor-pointer overflow-hidden group"
                >
                  <LayoutPreview layout={layout} />
                  <div className="p-4 flex flex-col items-center">
                    <h3 className="font-bold text-slate-800 text-sm truncate w-full text-center capitalize">
                      {(layout.name || '').replace(/_/g, ' ')}
                    </h3>
                    <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500 font-medium">
                      {layout.dimensions && (
                        <span className="text-slate-400 font-mono text-[10px]">{layout.dimensions}</span>
                      )}
                      {layout.dimensions && <span>&middot;</span>}
                      <span>{layout.frames.length} Frame{layout.frames.length !== 1 && 's'}</span>
                      {layout.surfaceCount > 1 && (
                        <>
                          <span>&middot;</span>
                          <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded-full text-[10px] font-semibold">
                            {layout.surfaceCount} Surfaces
                          </span>
                        </>
                      )}
                      {layout.createdAt && (
                        <>
                          <span>&middot;</span>
                          <span className="text-[10px] text-slate-400">
                            {new Date(layout.createdAt).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </div>
                    {layout.tags?.length > 0 && (
                      <div className="flex flex-wrap justify-center gap-1 mt-2.5">
                        {layout.tags.slice(0, 3).map((t: string) => (
                          <span key={t} className="px-2 py-0.5 bg-slate-100 text-slate-500 text-[9px] rounded-full font-bold uppercase tracking-wide">{t}</span>
                        ))}
                        {layout.tags.length > 3 && (
                          <span className="px-1.5 py-0.5 text-slate-400 text-[9px] font-bold">+{layout.tags.length - 3}</span>
                        )}
                      </div>
                    )}
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

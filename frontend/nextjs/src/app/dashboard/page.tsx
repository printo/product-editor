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
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { SearchInput } from '@/components/ui/SearchInput';
import { useHeader } from '@/context/HeaderContext';
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

  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();

  // Redirect logic
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
    if (!session?.accessToken) return;
    setIsFetchingLayouts(true);
    try {
      const res = await fetch('/api/layouts', {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
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

  // UseEffects (Must be before any conditional return)
  useEffect(() => {
    setTitle('Select Template');
    setDescription('Choose a design');
    setCenterActions(<SearchInput value={searchQuery} onChange={setSearchQuery} />);
    setRightActions(null);
  }, [searchQuery, setTitle, setDescription, setCenterActions, setRightActions]);

  useEffect(() => {
    if (session?.accessToken) {
      fetchLayouts();
    }
  }, [session?.accessToken, fetchLayouts]);

  // Loading state (AFTER all hooks)
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
    <div className="min-h-screen bg-transparent flex flex-col">
      <main className="w-full px-8 py-8 flex-1">
        <div className="max-w-[1440px] mx-auto">

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm font-medium px-4 py-3 rounded-xl">
              {error}
            </div>
          )}

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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-6">
              {filtered.map((layout) => (
                <Link
                  key={layout.id}
                  href={`/layout/${layout.id}`}
                  className="group bg-white rounded-2xl border border-slate-100/60 overflow-hidden hover:shadow-xl hover:shadow-indigo-500/10 transition-all duration-300 hover:-translate-y-1"
                >
                  <LayoutPreview layout={layout} />
                  <div className="p-5">
                    <h3 className="font-black text-slate-900 uppercase tracking-tight truncate group-hover:text-indigo-600 transition-colors">
                      {layout.name.replace(/_/g, ' ')}
                    </h3>
                    {layout.dimensions && (
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                        {layout.dimensions} • {layout.frames?.length || 0} Frames
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

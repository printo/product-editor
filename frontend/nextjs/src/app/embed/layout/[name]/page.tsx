'use client';

import React, { useEffect, useState, use } from 'react';
import { useSearchParams } from 'next/navigation';
import { LayoutSVG } from '@/components/LayoutSVG';
import { Loader2, ShieldAlert, Layers } from 'lucide-react';

export default function EmbedLayoutPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const searchParams = useSearchParams();
  const apiKey = searchParams.get('apiKey');
  const surfacesParam = searchParams.get('surfaces');
  const [layout, setLayout] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!apiKey) {
      setError('API Key is required for secure access.');
      setLoading(false);
      return;
    }

    const fetchLayout = async () => {
      try {
        const url = surfacesParam
          ? `/api/external/layouts/${name}?surfaces=${surfacesParam}`
          : `/api/external/layouts/${name}`;
        const res = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json'
          }
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail || 'Access Denied');
        }

        const data = await res.json();
        setLayout(data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchLayout();
  }, [name, apiKey, surfacesParam]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-8 bg-transparent">
        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-2" />
        <p className="text-xs text-slate-400 font-medium tracking-wide animate-pulse">SECURING CONNECTION...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-8 bg-transparent text-center">
        <div className="w-12 h-12 bg-rose-50 rounded-full flex items-center justify-center mb-4">
          <ShieldAlert className="w-6 h-6 text-rose-500" />
        </div>
        <h1 className="text-sm font-bold text-slate-900 mb-1">Authorization Failed</h1>
        <p className="text-xs text-slate-500 max-w-[200px] leading-relaxed">{error}</p>
      </div>
    );
  }

  const isMultiSurface = Array.isArray(layout?.surfaces) && layout.surfaces.length > 0;

  if (isMultiSurface) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-transparent overflow-hidden">
        <div className="flex flex-row gap-6">
          {layout.surfaces.map((surface: any) => (
            <div key={surface.key} className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                <Layers className="w-3.5 h-3.5" />
                <span className="capitalize">{surface.key}</span>
              </div>
              <LayoutSVG
                layout={layout}
                surfaceKey={surface.key}
                className="max-w-full max-h-screen drop-shadow-2xl bg-white rounded-lg"
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-transparent overflow-hidden">
      <LayoutSVG
        layout={layout}
        className="max-w-full max-h-screen drop-shadow-2xl bg-white rounded-lg"
      />
    </div>
  );
}

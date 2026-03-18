'use client';

import React, { useState, useRef, useCallback } from 'react';
import { Search, Loader2, Sparkles, X } from 'lucide-react';
import type { ImageOverlay } from './types';

interface IconBrowserProps {
  onAddImage: (overlay: ImageOverlay) => void;
}

interface IconResult {
  prefix: string; // "local" or icon set prefix
  name: string;   
  svgUrl: string; 
  isLocal?: boolean;
}

const LOCAL_ICONS = [
  'star', 'heart', 'circle', 'square', 'triangle', 
  'arrow-right', 'check', 'close'
];

async function searchIcons(query: string): Promise<IconResult[]> {
  const q = query.toLowerCase().trim();
  
  // Local search
  const localMatches: IconResult[] = LOCAL_ICONS
    .filter(name => name.includes(q))
    .map(name => ({
      prefix: 'local',
      name,
      svgUrl: `/icons/${name}.svg`,
      isLocal: true,
    }));

  if (q.length < 2) return localMatches;

  try {
    const res = await fetch(
      `https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=40`,
    );
    if (!res.ok) return localMatches;
    const data = await res.json();
    const icons: string[] = data.icons || [];
    const externalMatches = icons.map(fullName => {
      const [prefix, ...nameParts] = fullName.split(':');
      const name = nameParts.join(':');
      return {
        prefix,
        name,
        svgUrl: `https://api.iconify.design/${prefix}/${name}.svg`,
      };
    });
    // Deduplicate and merge
    return [...localMatches, ...externalMatches];
  } catch {
    return localMatches;
  }
}

export function IconBrowser({ onAddImage }: IconBrowserProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IconResult[]>(
    LOCAL_ICONS.map(name => ({ prefix: 'local', name, svgUrl: `/icons/${name}.svg`, isLocal: true }))
  );
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { 
      setResults(LOCAL_ICONS.map(name => ({ prefix: 'local', name, svgUrl: `/icons/${name}.svg`, isLocal: true }))); 
      setSearched(false); 
      return; 
    }
    setLoading(true);
    setSearched(true);
    const items = await searchIcons(q);
    setResults(items);
    setLoading(false);
  }, []);

  const handleInput = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 300);
  };

  const handleAdd = (item: IconResult) => {
    const overlay: ImageOverlay = {
      id: Date.now(),
      src: item.svgUrl,
      source: 'icon',
      label: item.isLocal ? item.name : `${item.prefix}:${item.name}`,
      x: 35, y: 35,
      width: 12, height: 12,
      rotation: 0, opacity: 1,
    };
    onAddImage(overlay);
  };

  if (!expanded) {
    return (
      <button onClick={() => setExpanded(true)}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-violet-50 text-violet-600 rounded-xl text-xs font-bold hover:bg-violet-100 transition-all">
        <Sparkles className="w-3.5 h-3.5" /> Add Icon
      </button>
    );
  }

  return (
    <div className="space-y-2 bg-white border border-slate-200 rounded-xl p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold text-violet-600 uppercase tracking-wider">
          {searched ? 'Search Results' : 'Storage Icons'}
        </p>
        <button onClick={() => setExpanded(false)} className="p-0.5 text-slate-400 hover:text-slate-600 rounded">
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
        <input type="text" value={query} onChange={e => handleInput(e.target.value)}
          placeholder="Search icons..." autoFocus
          className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500" />
      </div>

      {loading && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="w-4 h-4 animate-spin text-violet-500" />
        </div>
      )}

      {!loading && results.length === 0 && (
        <p className="text-[10px] text-slate-400 text-center py-3">No icons found.</p>
      )}

      {!loading && results.length > 0 && (
        <div className="grid grid-cols-5 gap-1 max-h-48 overflow-y-auto">
          {results.map(item => (
            <button key={`${item.prefix}:${item.name}`} onClick={() => handleAdd(item)} title={item.name}
              className="aspect-square bg-slate-50 border border-slate-100 rounded-lg hover:border-violet-400 hover:bg-violet-50/50 transition-all p-2 group relative">
              {item.isLocal && <div className="absolute top-0 right-0 w-1.5 h-1.5 bg-emerald-400 rounded-full border border-white" title="Storage" />}
              <img src={item.svgUrl} alt={item.name} className="w-full h-full object-contain group-hover:scale-110 transition-transform" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

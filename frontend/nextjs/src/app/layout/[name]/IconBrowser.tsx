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

// We'll use these as the "starter" icons when the search is empty
const INITIAL_ICONS = [
  { prefix: 'flat-color-icons', name: 'search' },
  { prefix: 'flat-color-icons', name: 'like' },
  { prefix: 'flat-color-icons', name: 'calendar' },
  { prefix: 'flat-color-icons', name: 'camera' },
  { prefix: 'flat-color-icons', name: 'shop' },
  { prefix: 'flat-color-icons', name: 'support' },
  { prefix: 'flat-color-icons', name: 'briefcase' },
  { prefix: 'flat-color-icons', name: 'biometry' },
  { prefix: 'flat-color-icons', name: 'settings' },
  { prefix: 'flat-color-icons', name: 'fine-print' },
  { prefix: 'flat-color-icons', name: 'customer' },
  { prefix: 'flat-color-icons', name: 'shipped' },
  { prefix: 'logos',             name: 'google-icon' },
  { prefix: 'logos',             name: 'facebook' },
  { prefix: 'logos',             name: 'instagram-icon' },
  { prefix: 'logos',             name: 'whatsapp' },
];

async function searchIcons(query: string): Promise<IconResult[]> {
  const q = query.toLowerCase().trim();
  
  if (q.length === 0) {
    return INITIAL_ICONS.map(item => ({
      ...item,
      svgUrl: `https://api.iconify.design/${item.prefix}/${item.name}.svg`,
    }));
  }

  if (q.length < 2) return [];

  try {
    // We prioritize some color sets by including them in the search or just doing a broad search
    const res = await fetch(
      `https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=60`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    const icons: string[] = data.icons || [];
    return icons.map(fullName => {
      const [prefix, ...nameParts] = fullName.split(':');
      const name = nameParts.join(':');
      return {
        prefix,
        name,
        svgUrl: `https://api.iconify.design/${prefix}/${name}.svg`,
      };
    });
  } catch {
    return [];
  }
}

export function IconBrowser({ onAddImage }: IconBrowserProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IconResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load initial icons on mount or when expanded
  React.useEffect(() => {
    if (expanded && results.length === 0) {
      doSearch('');
    }
  }, [expanded]);


  const doSearch = useCallback(async (q: string) => {
    setLoading(true);
    setSearched(q.trim().length > 0);
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
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-br from-violet-500/10 via-fuchsia-500/10 to-cyan-500/10 text-violet-600 dark:text-violet-400 border border-violet-200/50 dark:border-violet-500/20 rounded-2xl text-xs font-black uppercase tracking-widest hover:shadow-lg hover:shadow-violet-500/10 transition-all active:scale-95 group">
        <Sparkles className="w-4 h-4 transition-transform group-hover:rotate-12" /> 
        Add Icon
      </button>
    );
  }

  return (
    <div className="space-y-4 py-1">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
        <p className="text-[10px] font-black text-violet-500 dark:text-violet-400 uppercase tracking-[0.2em]">
          {searched ? 'Detected Icons' : 'Premium Library'}
        </p>
        <button onClick={() => setExpanded(false)} className="p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-lg transition-all">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="relative group">
        <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
          <Search className="w-3.5 h-3.5 text-slate-400 group-focus-within:text-violet-500 transition-colors" />
        </div>
        <input type="text" value={query} onChange={e => handleInput(e.target.value)}
          placeholder="Search icons..." autoFocus
          className="w-full pl-9 pr-4 py-2.5 text-xs font-medium bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl focus:outline-none focus:ring-4 focus:ring-violet-500/10 focus:border-violet-500 dark:focus:border-violet-400 transition-all placeholder:text-slate-400" />
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
        <div className="grid grid-cols-5 gap-2 p-1.5 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-800/50 max-h-56 overflow-y-auto custom-scrollbar">
          {results.map(item => (
            <button key={`${item.prefix}:${item.name}`} onClick={() => handleAdd(item)} title={item.name}
              className="aspect-square bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:border-violet-400 dark:hover:border-violet-500 hover:shadow-lg hover:shadow-violet-500/10 transition-all p-2 group relative active:scale-90">
              {item.isLocal && <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white dark:border-slate-800 shadow-sm" title="Storage" />}
              <img src={item.svgUrl} alt={item.name} className="w-full h-full object-contain group-hover:scale-110 transition-transform duration-300" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

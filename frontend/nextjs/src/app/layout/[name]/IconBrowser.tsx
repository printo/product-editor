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
        className="w-full h-11 flex items-center justify-center gap-3 bg-white border border-slate-200 rounded-xl text-[11px] font-medium uppercase hover:bg-slate-50 transition-all active:scale-[0.98] group shadow-sm">
        <Sparkles className="w-4 h-4 text-indigo-600 transition-transform group-hover:rotate-12" /> 
        Add New Icon
      </button>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-4">
        <div className="flex flex-col">
          <p className="text-[11px] font-medium text-slate-900 uppercase">
            {searched ? 'Detected Icons' : 'Premium Library'}
          </p>
          <span className="text-[10px] text-slate-400 uppercase opacity-60">Iconify API</span>
        </div>
        <button onClick={() => setExpanded(false)} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="relative group">
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <Search className="w-4 h-4 text-slate-400 group-focus-within:text-indigo-600 transition-colors" />
        </div>
        <input type="text" value={query} onChange={e => handleInput(e.target.value)}
          placeholder="Search icons..." autoFocus
          className="w-full pl-11 pr-4 py-3 text-[11px] font-medium bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 transition-all placeholder:text-slate-300 shadow-sm" />
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center py-6 gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
          <p className="text-[10px] font-medium text-slate-400 uppercase">Searching...</p>
        </div>
      )}

      {!loading && results.length === 0 && (
        <div className="py-6 text-center">
          <p className="text-[10px] text-slate-400 uppercase">No icons found.</p>
        </div>
      )}

      {!loading && results.length > 0 && (
        <div className="grid grid-cols-4 gap-2.5 p-3 bg-white border border-slate-100 rounded-2xl shadow-sm max-h-72 overflow-y-auto custom-scrollbar">
          {results.map(item => (
            <button key={`${item.prefix}:${item.name}`} onClick={() => handleAdd(item)} title={item.name}
              className="aspect-square bg-slate-50 border border-slate-100 rounded-xl hover:border-indigo-200 hover:bg-white hover:shadow-md transition-all p-2.5 group relative active:scale-90">
              {item.isLocal && <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white shadow-sm z-10" />}
              <img src={item.svgUrl} alt={item.name} className="w-full h-full object-contain group-hover:scale-110 transition-transform duration-300" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

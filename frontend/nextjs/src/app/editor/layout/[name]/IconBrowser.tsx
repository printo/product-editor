'use client';

import React, { useState, useRef, useCallback } from 'react';
import { ImageOff, Search, Loader2, Sparkles, X } from 'lucide-react';
import { iconifyUrl, ownIconUrl } from '@/lib/icon-source';
import type { ImageOverlay } from './types';

interface IconBrowserProps {
  onAddImage: (overlay: ImageOverlay) => void;
  /** The page's API proxy and its auth headers, for the search. Without
   *  them only the starter icons show. */
  apiBase?: string;
  getAuthHeaders?: () => Record<string, string>;
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

type IconSearch = { items: IconResult[]; busy: boolean };

/**
 * Icons for a search, through our own server (backend services/icon_store.py),
 * which keeps a copy of every icon it has served. Until 2026-11-05 the browser
 * asked Iconify itself, for the search and for each of the sixty tiles, and
 * Iconify blocked the customer's address after about three searches.
 * `busy` means the server could not ask Iconify just now.
 */
// How long typing must pause before the box is searched. A word nobody has
// searched yet takes the server about 7 seconds, so each partial word this
// catches ("lo", "lov") is a wait and part of its allowance from Iconify.
const SEARCH_PAUSE_MS = 500;

async function searchIcons(
  query: string, apiBase?: string, getAuthHeaders?: () => Record<string, string>, signal?: AbortSignal,
): Promise<IconSearch> {
  const q = query.toLowerCase().trim();

  if (q.length === 0) {
    return { items: INITIAL_ICONS.map(item => ({ ...item, svgUrl: iconifyUrl(item.prefix, item.name) })), busy: false };
  }

  if (q.length < 2 || !apiBase) return { items: [], busy: false };

  try {
    const res = await fetch(`${apiBase}/icon-search?q=${encodeURIComponent(q)}`, { headers: getAuthHeaders?.() ?? {}, signal });
    if (!res.ok) return { items: [], busy: res.status === 503 || res.status === 429 };
    const data = (await res.json()) as { icons?: { prefix: string; name: string }[] };
    return {
      items: (data.icons || []).map(({ prefix, name }) => ({ prefix, name, svgUrl: iconifyUrl(prefix, name) })),
      busy: false,
    };
  } catch {
    return { items: [], busy: true };
  }
}

export function IconBrowser({ onAddImage, apiBase, getAuthHeaders }: IconBrowserProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IconResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  // Tiles whose picture did not load: shown as a plain placeholder, not as
  // the browser's broken-image mark, and not offered for adding.
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The search for the word now in the box. Only its answer may reach the
  // screen: a slow answer for an earlier word used to replace the right one.
  const searchRef = useRef<AbortController | null>(null);
  // Tracks whether we've already kicked off the default-icon load on expand.
  // Without this, running `doSearch('')` inside the effect would either need
  // results.length in the dep array (re-fires on every result change) or a
  // suppression directive — a flag is the cleanest way to express "once".
  const didInitialLoadRef = useRef(false);

  const doSearch = useCallback(async (q: string) => {
    searchRef.current?.abort();
    const search = new AbortController();
    searchRef.current = search;
    setLoading(true);
    setSearched(q.trim().length > 0);
    const { items, busy: serverBusy } = await searchIcons(q, apiBase, getAuthHeaders, search.signal);
    if (searchRef.current !== search) return;
    setResults(items);
    setBusy(serverBusy);
    setFailed(new Set());
    setLoading(false);
  }, [apiBase, getAuthHeaders]);

  React.useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    searchRef.current?.abort();
  }, []);

  // Load default icons the first time the picker expands.
  React.useEffect(() => {
    if (expanded && !didInitialLoadRef.current) {
      didInitialLoadRef.current = true;
      doSearch('');
    }
  }, [expanded, doSearch]);

  const handleInput = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // The word changed, so an answer still on its way is for the wrong word.
    searchRef.current?.abort();
    searchRef.current = null;
    debounceRef.current = setTimeout(() => doSearch(val), SEARCH_PAUSE_MS);
  };

  const handleAdd = (item: IconResult) => {
    const overlay: ImageOverlay = {
      id: crypto.randomUUID(),
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
        className="w-full h-11 flex items-center justify-center gap-3 bg-white border border-slate-200 rounded-lg text-[11px] font-medium uppercase hover:bg-slate-50 transition-all active:scale-[0.98] group shadow-sm">
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
          <span className="text-[10px] text-slate-400 uppercase opacity-60">Icon library</span>
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
          className="w-full pl-11 pr-4 py-3 text-[11px] font-medium bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 transition-all placeholder:text-slate-300 shadow-sm" />
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center py-6 gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
          <p className="text-[10px] font-medium text-slate-400 uppercase">Searching...</p>
        </div>
      )}

      {!loading && results.length === 0 && (
        <div className="py-6 text-center">
          <p className="text-[10px] text-slate-400 uppercase">
            {busy ? 'Icon search is busy. Please try again in a minute.' : 'No icons found.'}
          </p>
        </div>
      )}

      {!loading && results.length > 0 && (
        <div className="grid grid-cols-4 gap-2.5 p-3 bg-white border border-slate-100 rounded-xl shadow-sm max-h-72 overflow-y-auto custom-scrollbar">
          {results.map(item => {
            const key = `${item.prefix}:${item.name}`;
            const broken = failed.has(key);
            return (
              <button key={key} onClick={() => handleAdd(item)} title={broken ? `${item.name} could not be loaded` : item.name}
                disabled={broken}
                className="aspect-square bg-slate-50 border border-slate-100 rounded-lg hover:border-indigo-200 hover:bg-white hover:shadow-md transition-all p-2.5 group relative active:scale-90 disabled:opacity-50 disabled:hover:shadow-none disabled:hover:border-slate-100 disabled:hover:bg-slate-50 disabled:active:scale-100">
                {item.isLocal && <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white shadow-sm z-10" />}
                {broken ? (
                  <ImageOff className="w-full h-full p-1.5 text-slate-300" aria-label={`${item.name} could not be loaded`} />
                ) : (
                  <img src={ownIconUrl(item.svgUrl)} alt={item.name} loading="lazy"
                    onError={() => setFailed(prev => new Set(prev).add(key))}
                    className="w-full h-full object-contain group-hover:scale-110 transition-transform duration-300" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

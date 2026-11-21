'use client';

import React from 'react';
import { Loader2, X } from 'lucide-react';

/** The Google fonts ops can switch on for customers' text. */
export const GOOGLE_FONT_CHOICES = [
  'Roboto', 'Lato', 'Montserrat', 'Oswald', 'Raleway',
  'Poppins', 'Nunito', 'Ubuntu', 'Playfair Display', 'Merriweather',
  'Inter', 'Rubik', 'Work Sans', 'Quicksand', 'Barlow', 'Fira Sans',
  'Karla', 'Cabin', 'Arvo', 'Bitter', 'Crimson Text', 'Josefin Sans',
  'Pacifico', 'Dancing Script', 'Lobster', 'Bebas Neue', 'Anton',
  'Permanent Marker', 'Satisfy', 'Great Vibes', 'Abril Fatface',
  'Archivo', 'Source Sans 3', 'DM Sans', 'Space Grotesk', 'Outfit',
  'Sora', 'Manrope', 'Plus Jakarta Sans', 'Lexend',
];

/** The Fonts window: tick a font to offer it; every change is saved by the caller. */
export function FontPickerModal({ search, onSearch, selectedFonts, fontsLoaded, loadGoogleFont, isSaving, onChange, onClose }: {
  search: string;
  onSearch: (value: string) => void;
  selectedFonts: string[];
  fontsLoaded: Set<string>;
  loadGoogleFont: (family: string) => void;
  isSaving: boolean;
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl ring-1 ring-slate-900/5 w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">Google Fonts</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-900 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-3 border-b">
          <input type="text" placeholder="Search fonts..." value={search} onChange={e => onSearch(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-3 space-y-1">
          {/* Google Fonts */}
          {GOOGLE_FONT_CHOICES.filter(f => f.toLowerCase().includes(search.toLowerCase())).map(f => (
            <label key={f} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50 cursor-pointer"
              onMouseEnter={() => loadGoogleFont(f)}>
              <input type="checkbox" checked={selectedFonts.includes(f)}
                onChange={e => {
                  let next: string[];
                  if (e.target.checked) {
                    loadGoogleFont(f);
                    next = [...selectedFonts, f];
                  } else {
                    next = selectedFonts.filter(x => x !== f);
                  }
                  onChange(next);
                }}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              <span className="text-sm text-slate-700" style={{ fontFamily: fontsLoaded.has(f) ? f : 'inherit' }}>{f}</span>
              <span className="text-[9px] text-slate-400 ml-auto uppercase">Google</span>
            </label>
          ))}
        </div>
        <div className="px-6 py-3 border-t bg-slate-50 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {selectedFonts.length} font{selectedFonts.length !== 1 ? 's' : ''} selected
          </span>
          {isSaving && <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />}
        </div>
      </div>
    </div>
  );
}

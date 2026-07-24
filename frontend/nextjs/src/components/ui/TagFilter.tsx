'use client';

import { Filter } from 'lucide-react';
import { AVAILABLE_TAGS } from '@/lib/product-tags';
import { Dropdown } from '@/components/ui/Dropdown';

interface TagFilterProps {
  value: string;
  onChange: (value: string) => void;
}

const OPTIONS = ['', ...AVAILABLE_TAGS].map(tag => ({ value: tag, label: tag || 'All' }));

/** Reusable product-category filter — shared by the dashboard and the
 *  template library so both pages filter/render identically. Desktop shows
 *  every tag as a chip; mobile collapses to the shared Dropdown (not enough
 *  row width for ~10 chips at phone widths). */
export const TagFilter = ({ value, onChange }: TagFilterProps) => {
  return (
    <>
      <div className="flex items-center gap-2 mb-4 md:hidden">
        <div className="flex items-center gap-1.5 text-slate-500 shrink-0">
          <Filter className="w-3.5 h-3.5" />
          <span className="text-[11px] font-bold uppercase tracking-wide">Filter</span>
        </div>
        <Dropdown
          value={value}
          onChange={onChange}
          options={OPTIONS}
          triggerClassName="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-[11px] font-bold uppercase tracking-wide text-slate-600 min-w-[140px]"
          panelClassName="w-48"
          optionClassName="text-[11px] font-bold uppercase tracking-wide"
        />
      </div>

      <div className="hidden md:flex flex-wrap gap-2 mb-4">
        {OPTIONS.map(({ value: tag, label }) => {
          const isActive = value === tag;
          return (
            <button
              key={tag || '__all__'}
              onClick={() => onChange(isActive ? '' : tag)}
              className={[
                'px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide border transition-all',
                isActive
                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-400 hover:text-indigo-600',
              ].join(' ')}
            >
              {label}
            </button>
          );
        })}
      </div>
    </>
  );
};

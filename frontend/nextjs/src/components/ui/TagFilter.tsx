'use client';

import { Filter } from 'lucide-react';
import { AVAILABLE_TAGS } from '@/lib/product-tags';
import { Dropdown } from '@/components/ui/Dropdown';

interface TagFilterProps {
  value: string;
  onChange: (value: string) => void;
  /** Visibility/spacing for the slot this instance sits in. Both pages mount
   *  two instances driving the same state — see the note below. */
  className?: string;
}

const OPTIONS = ['', ...AVAILABLE_TAGS].map(tag => ({ value: tag, label: tag || 'All' }));

/** Reusable product-category filter — shared by the dashboard and the template
 *  library so both pages filter identically. A dropdown rather than a chip row
 *  because ~10 chips don't fit beside search at any breakpoint.
 *
 *  Placement differs by breakpoint, so each page mounts TWO instances bound to
 *  the same state and toggles them with `className`:
 *    md+    → in the header, beside the search box
 *    mobile → in the page body, where it gets a usable width
 *  The header row on mobile already carries search, Fonts and the
 *  Dashboard/Templates toggle; adding a fourth control there squeezed the
 *  search box to ~70px, so the filter moves out of the row rather than
 *  starving it.
 *
 *  The panel is right-aligned (`!left-auto right-0` overrides Dropdown's
 *  default left alignment) so the header instance doesn't open off-screen. */
export const TagFilter = ({ value, onChange, className = '' }: TagFilterProps) => (
  <div className={`items-center gap-1.5 shrink-0 ${className}`}>
    <Filter
      className={`w-3.5 h-3.5 shrink-0 ${value ? 'text-indigo-600' : 'text-slate-500'}`}
      aria-hidden="true"
    />
    <Dropdown
      value={value}
      onChange={onChange}
      options={OPTIONS}
      testId="tag-filter"
      triggerClassName={[
        'px-3 py-2 rounded-lg border bg-white transition-colors',
        'w-[150px] text-[11px] font-bold uppercase tracking-wide',
        value ? 'border-indigo-400 text-indigo-600' : 'border-slate-200 text-slate-600 hover:border-indigo-400',
      ].join(' ')}
      panelClassName="w-48 !left-auto right-0"
      optionClassName="text-[11px] font-bold uppercase tracking-wide"
    />
  </div>
);

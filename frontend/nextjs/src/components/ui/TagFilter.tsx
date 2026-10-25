'use client';

import { Filter } from 'lucide-react';
import type { LayoutTagInfo } from '@/lib/layout-tags';
import { Dropdown } from '@/components/ui/Dropdown';

interface TagFilterProps {
  /** The selected tag key, or '' for all. */
  value: string;
  onChange: (value: string) => void;
  /** Visibility/spacing for the slot this instance sits in. Both pages mount
   *  two instances driving the same state — see the note below. */
  className?: string;
  /** The ops-managed tag list (`useLayoutTags`). */
  tags: LayoutTagInfo[];
}

/** Switched-on tags, plus switched-off ones still on some layout. */
const filterOptions = (tags: LayoutTagInfo[]) => [
  { value: '', label: 'All' },
  ...tags.filter(t => t.isActive || t.layoutCount > 0).map(t => ({ value: t.key, label: t.name })),
];

/** Reusable product-category filter — shared by the dashboard and the template
 *  library so both pages filter identically. A dropdown rather than a chip row
 *  because ~10 chips don't fit beside search at any breakpoint.
 *
 *  Placement differs by breakpoint, so each page mounts TWO instances bound to
 *  the same state and toggles them with `className`:
 *    md+    → in the header, beside the search box
 *    mobile → in the page body, where it gets a usable width
 *  The header row on mobile already carries search, Fonts and the
 *  Dashboard/Layouts toggle; adding a fourth control there squeezed the
 *  search box to ~70px, so the filter moves out of the row rather than
 *  starving it.
 *
 *  The panel is right-aligned (`!left-auto right-0` overrides Dropdown's
 *  default left alignment) so the header instance doesn't open off-screen. */
export const TagFilter = ({ value, onChange, className = '', tags }: TagFilterProps) => (
  <div className={`items-center gap-1.5 shrink-0 ${className}`}>
    <Filter
      className={`w-3.5 h-3.5 shrink-0 ${value ? 'text-indigo-600' : 'text-slate-500'}`}
      aria-hidden="true"
    />
    <Dropdown
      value={value}
      onChange={onChange}
      options={filterOptions(tags)}
      testId="tag-filter"
      triggerClassName={[
        'px-3 py-2 rounded-lg border bg-white transition-colors',
        'w-[150px] text-[11px] font-bold uppercase tracking-wide',
        value ? 'border-indigo-400 text-indigo-600' : 'border-slate-200 text-slate-600 hover:border-indigo-400',
      ].join(' ')}
      panelClassName="w-48 max-h-80 overflow-y-auto !left-auto right-0"
      optionClassName="text-[11px] font-bold uppercase tracking-wide"
    />
  </div>
);

'use client';

import { X } from 'lucide-react';
import { Dropdown } from '@/components/ui/Dropdown';
import { MAX_TAGS_PER_LAYOUT, tagName, type LayoutTagInfo } from '@/lib/layout-tags';

interface TagPickerProps {
  /** The full tag list (`useLayoutTags`). */
  tags: LayoutTagInfo[];
  /** Selected tag keys, in order. */
  value: string[];
  onChange: (keys: string[]) => void;
  label?: string;
  /** Shown under the picker when the tag list failed to load. */
  error?: string | null;
}

/** Several tags per layout, shared by the generic, calendar and book editors.
 *  Selected tags show as chips; the menu offers only switched-on tags not
 *  already chosen. A switched-off tag a layout already carries stays as a chip
 *  (marked "off") until someone removes it. */
export const TagPicker = ({ tags, value, onChange, label = 'Tags', error }: TagPickerProps) => {
  const offered = tags.filter(t => t.isActive && !value.includes(t.key));
  const full = value.length >= MAX_TAGS_PER_LAYOUT;
  return (
    <div>
      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">{label}</label>
      <div className="rounded-lg border border-slate-200 bg-white">
        {value.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
            {value.map(key => {
              const tag = tags.find(t => t.key === key);
              const off = tag ? !tag.isActive : false;
              return (
                <span
                  key={key}
                  title={`Key: ${key}${off ? ' (switched off)' : ''}`}
                  className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md text-[11px] font-bold ${off ? 'bg-slate-100 text-slate-500' : 'bg-indigo-50 text-indigo-700'}`}
                >
                  {tagName(tags, key)}
                  {off && <span className="text-[9px] uppercase text-slate-400">off</span>}
                  <button
                    type="button"
                    aria-label={`Remove tag ${tagName(tags, key)}`}
                    onClick={() => onChange(value.filter(k => k !== key))}
                    className="p-0.5 rounded hover:bg-white/80"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {/* Full-width trigger, so the menu is exactly the picker's width and
            never pushes a narrow form column sideways. */}
        {!full && offered.length > 0 && (
          <Dropdown
            value=""
            onChange={key => key && onChange([...value, key])}
            options={offered.map(t => ({ value: t.key, label: t.name }))}
            placeholder={value.length ? 'Add another tag…' : 'Add a tag…'}
            testId="tag-picker"
            triggerClassName="w-full px-3 py-2.5 rounded-lg text-sm font-medium text-slate-500 hover:text-indigo-600"
            panelClassName="w-full"
            optionClassName="text-sm font-medium"
          />
        )}
        {(full || offered.length === 0) && (
          <p className="text-xs text-slate-400 px-3 py-2.5">
            {full
              ? `At most ${MAX_TAGS_PER_LAYOUT} tags.`
              : tags.length
                ? 'Every tag is already added.'
                : error
                  ? 'Tags could not be loaded.'
                  : 'Loading tags…'}
          </p>
        )}
      </div>
      {error && <p className="text-[11px] text-rose-600 mt-1.5">{error}</p>}
    </div>
  );
};

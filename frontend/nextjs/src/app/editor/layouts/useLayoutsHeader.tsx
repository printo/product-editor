/**
 * What the layouts page puts in the app header: the title and Close Editor
 * while the editor is open; the search box, tag filter, Fonts and the ops
 * links over the list. Moved out of page.tsx unchanged
 * (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, step 6).
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { CalendarDays, LayoutTemplate as TemplateIcon, Tag as TagIcon, Type, X } from 'lucide-react';
import { SearchInput } from '@/components/ui/SearchInput';
import { TagFilter } from '@/components/ui/TagFilter';
import { useHeader } from '@/context/HeaderContext';
import type { LayoutTagInfo } from '@/lib/layout-tags';

export function useLayoutsHeader({
  isModalOpen, setIsModalOpen, isEditMode, searchQuery, setSearchQuery, activeTagFilter, setActiveTagFilter,
  tagList, selectedFonts, layouts, canManageHolidays, setShowFontModal,
}: {
  isModalOpen: boolean;
  setIsModalOpen: (open: boolean) => void;
  isEditMode: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  activeTagFilter: string;
  setActiveTagFilter: (key: string) => void;
  tagList: LayoutTagInfo[];
  selectedFonts: string[];
  layouts: unknown[];
  canManageHolidays: boolean;
  setShowFontModal: (open: boolean) => void;
}) {
  const { setTitle, setDescription, setCenterActions, setRightActions } = useHeader();
  useEffect(() => {
    if (isModalOpen) {
      setTitle(isEditMode ? 'Edit Layout' : 'Create Layout');
      setDescription('Define canvas dimensions and print areas');
      setCenterActions(null);
      setRightActions(
        <button
          onClick={() => setIsModalOpen(false)}
          aria-label="Close Editor"
          className="flex items-center gap-1.5 p-2.5 md:px-3 md:py-1.5 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-full md:rounded border border-slate-200 hover:border-slate-300 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Close Editor</span>
        </button>
      );
    } else {
      setTitle('');
      setDescription('');
      setCenterActions(
        <div className="flex items-center gap-2 flex-1 min-w-0 md:flex-none md:w-full md:max-w-[900px]">
          {/* !w-auto + min-w-0 override SearchInput's mobile w-[175px] shrink-0 so
              this row (search + filter + Fonts + nav) can fit a 375px viewport. */}
          <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={`Filter across ${layouts.length} layouts`} className="flex-1 min-w-0 !w-auto" />
          <TagFilter value={activeTagFilter} onChange={setActiveTagFilter} tags={tagList} className="hidden xl:flex" />
          <button
            onClick={() => setShowFontModal(true)}
            aria-label="Fonts"
            title={`Fonts (${selectedFonts.length})`}
            className="flex items-center gap-1.5 px-2.5 py-2.5 md:px-3 md:py-2 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
          >
            <Type className="w-4 h-4 md:w-3.5 md:h-3.5" />
            <span className="hidden xl:inline">Fonts ({selectedFonts.length})</span>
          </button>
          {/* On phones the top row has no room for it; it sits beside the tag filter in the page instead. */}
          {canManageHolidays && (
            <Link
              href="/editor/layouts/holidays"
              aria-label="Holidays"
              title="Holidays printed on calendars"
              className="hidden md:flex items-center gap-1.5 px-2.5 py-2.5 md:px-3 md:py-2 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
            >
              <CalendarDays className="w-4 h-4 md:w-3.5 md:h-3.5" />
              <span className="hidden 2xl:inline">Holidays</span>
            </Link>
          )}
          {canManageHolidays && (
            <Link
              href="/editor/layouts/tags"
              aria-label="Tags"
              title="Layout tags"
              className="hidden md:flex items-center gap-1.5 px-2.5 py-2.5 md:px-3 md:py-2 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
            >
              <TagIcon className="w-4 h-4 md:w-3.5 md:h-3.5" />
              <span className="hidden 2xl:inline">Tags</span>
            </Link>
          )}
          {canManageHolidays && (
            <Link
              href="/editor/layouts/templates"
              aria-label="Templates"
              title="Every template, by size and layout"
              className="hidden md:flex items-center gap-1.5 px-2.5 py-2.5 md:px-3 md:py-2 bg-slate-50 text-slate-600 text-[10px] font-bold uppercase rounded-lg border border-slate-200 hover:border-slate-300 transition-colors shrink-0"
            >
              <TemplateIcon className="w-4 h-4 md:w-3.5 md:h-3.5" />
              <span className="hidden 2xl:inline">Templates</span>
            </Link>
          )}
        </div>
      );
      // The Django admin link lives on the header's role badge (HeaderUserMenu),
      // so this page adds no action of its own: a button here collided with
      // the Fonts button once the search row got narrow.
      setRightActions(null);
    }
    // activeTagFilter is a dep because centerActions is a captured JSX snapshot —
    // without it the dropdown would keep rendering the tag selected at mount.
    // The access flag likewise: the Holidays link is in that snapshot, so it
    // would stay hidden for an ops user whose session resolved after mount.
  }, [isModalOpen, setIsModalOpen, isEditMode, setTitle, setDescription, setCenterActions, setRightActions, searchQuery, setSearchQuery, activeTagFilter, setActiveTagFilter, tagList, selectedFonts.length, layouts.length, canManageHolidays, setShowFontModal]);
}

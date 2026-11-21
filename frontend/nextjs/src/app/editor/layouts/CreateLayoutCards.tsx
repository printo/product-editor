/**
 * The three "create" cards at the head of the layout list: generic (opens the
 * editor), calendar and book (their own editors).
 * Moved out of page.tsx unchanged (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, step 4).
 */
import Link from 'next/link';
import { BookOpen, CalendarDays, Layout, Plus } from 'lucide-react';

export function CreateLayoutCards({ openCreateModal }: { openCreateModal: () => void }) {
  return (
    <>
    {/* Single card split into two creation options */}
    {/* Side-by-side on phones (vertical space is scarce there), stacked
        from md up so each option gets the full card width. */}
    <div className="bg-white border-2 border-dashed border-slate-200 rounded-xl overflow-hidden min-h-[120px] md:min-h-[300px] flex flex-row md:flex-col col-span-1 md:col-span-2 lg:col-span-1">
      {/* Left half — Generic */}
      <button
        data-testid="create-generic-layout-btn"
        onClick={openCreateModal}
        className="group flex-1 flex flex-col items-center justify-center gap-1.5 md:gap-3 p-3 md:p-6 hover:bg-indigo-50 transition-all cursor-pointer border-r-2 md:border-r-0 md:border-b-2 border-dashed border-slate-200 hover:border-indigo-300"
      >
        <div className="w-8 h-8 md:w-12 md:h-12 bg-indigo-50 rounded-lg md:rounded-lg flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
          <Layout className="w-4 h-4 md:w-6 md:h-6 text-indigo-600" />
        </div>
        <div className="text-center">
          <p className="font-bold text-xs md:text-sm text-slate-800 group-hover:text-indigo-700 transition-colors">Generic Layout</p>
          <p className="hidden md:block text-[10px] text-slate-400 mt-0.5">Prints, stickers, products</p>
        </div>
        <span className="flex items-center gap-1 px-2 py-0.5 md:px-2.5 md:py-1 bg-indigo-50 text-indigo-700 text-[9px] md:text-[10px] font-bold uppercase rounded-full border border-indigo-200 group-hover:bg-indigo-100 transition-colors">
          <Plus className="w-3 h-3" /> Create
        </span>
      </button>

      {/* Middle — Calendar */}
      <Link
        href="/editor/layouts/calendar/new"
        data-testid="create-calendar-layout-link"
        className="group flex-1 flex flex-col items-center justify-center gap-1.5 md:gap-3 p-3 md:p-6 hover:bg-[#F17A26]/10 transition-all border-r-2 md:border-r-0 md:border-b-2 border-dashed border-slate-200 hover:border-[#F17A26]/40"
      >
        <div className="w-8 h-8 md:w-12 md:h-12 bg-[#F17A26]/10 rounded-lg md:rounded-lg flex items-center justify-center group-hover:bg-[#F17A26]/20 transition-colors">
          <CalendarDays className="w-4 h-4 md:w-6 md:h-6 text-[#F17A26]" />
        </div>
        <div className="text-center">
          <p className="font-bold text-xs md:text-sm text-slate-800 group-hover:text-[#F17A26] transition-colors">Calendar Layout</p>
          <p className="hidden md:block text-[10px] text-slate-400 mt-0.5">Month-grid with holidays</p>
        </div>
        <span className="flex items-center gap-1 px-2 py-0.5 md:px-2.5 md:py-1 bg-[#F17A26]/10 text-[#F17A26] text-[9px] md:text-[10px] font-bold uppercase rounded-full border border-[#F17A26]/30 group-hover:bg-[#F17A26]/20 transition-colors">
          <Plus className="w-3 h-3" /> Create
        </span>
      </Link>

      {/* Right — Book */}
      <Link
        href="/editor/layouts/book/new"
        data-testid="create-book-layout-link"
        className="group flex-1 flex flex-col items-center justify-center gap-1.5 md:gap-3 p-3 md:p-6 hover:bg-sky-50 transition-all hover:border-sky-300"
      >
        <div className="w-8 h-8 md:w-12 md:h-12 bg-sky-50 rounded-lg md:rounded-lg flex items-center justify-center group-hover:bg-sky-100 transition-colors">
          <BookOpen className="w-4 h-4 md:w-6 md:h-6 text-sky-700" />
        </div>
        <div className="text-center">
          <p className="font-bold text-xs md:text-sm text-slate-800 group-hover:text-sky-700 transition-colors">Book Layout</p>
          <p className="hidden md:block text-[10px] text-slate-400 mt-0.5">Photobooks, booklets</p>
        </div>
        <span className="flex items-center gap-1 px-2 py-0.5 md:px-2.5 md:py-1 bg-sky-50 text-sky-700 text-[9px] md:text-[10px] font-bold uppercase rounded-full border border-sky-200 group-hover:bg-sky-100 transition-colors">
          <Plus className="w-3 h-3" /> Create
        </span>
      </Link>
    </div>
    </>
  );
}

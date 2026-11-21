/**
 * One layout in the ops list: thumbnail, badges, tags, the action icons and
 * the details. Moved out of page.tsx unchanged (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, step 4).
 */
import Link from 'next/link';
import { ChevronRight, Copy, Edit2, Eye, LayoutTemplate as TemplateIcon, Trash2 } from 'lucide-react';
import { LayoutSVG } from '@/components/LayoutSVG';
import { resolveMaskSlots } from '@/lib/mask-slots';
import { printSheetLabel } from '@/lib/print-sheet';

export function LayoutCard({ layoutObj, openCopyModal, openEditModal, openViewModal, setDeleteConfirm }: {
  layoutObj: any;
  openCopyModal: (name: string) => void;
  openEditModal: (name: string) => void;
  openViewModal: (name: string) => void;
  setDeleteConfirm: (name: string) => void;
}) {
  const layoutStr = typeof layoutObj === 'string' ? layoutObj : layoutObj.name;
  // Phase 6.3 — Calendar layouts are flagged distinctly so ops can
  // spot calendar products at a glance and the Edit button routes
  // to the dedicated CalendarLayoutEditor instead of the generic
  // edit modal (whose schema doesn't cover monthRange/calendars[]).
  const isCalendar = typeof layoutObj === 'object' && layoutObj.productType === 'calendar';
  // Book layouts (BOOK_LAYOUT_PRD.md §6 Phase 5) carry no root
  // canvas/frames at all (each role authors its own under
  // book.cover/innerPage/backCover, D7) — openEditModal/
  // openCopyModal both read `data.canvas.*` directly and would
  // crash, so route Edit the same way calendar does and disable
  // Duplicate rather than let either reach a book layout.
  const isBook = typeof layoutObj === 'object' && layoutObj.productType === 'book';
  // Soft-deleted (see LayoutManagementView.delete). renamedTo set
  // means the name was superseded by a rename and still resolves
  // via LayoutCatalogue.resolve_active() — a dead end otherwise.
  const isDeprecated = typeof layoutObj === 'object' && !!layoutObj.isDeprecated;
  const renamedTo = typeof layoutObj === 'object' ? layoutObj.renamedTo : null;
  return (
    <div
      data-testid={`layout-card-${layoutStr}`}
      data-product-type={isCalendar ? 'calendar' : isBook ? 'book' : 'standard'}
      data-deprecated={isDeprecated || undefined}
      className={`bg-white border rounded-xl p-6 transition-all group relative ${
        isDeprecated
          ? 'opacity-60 border-slate-200 bg-slate-50/60'
          : 'border-slate-200 hover:shadow-lg hover:border-indigo-200'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 mb-4">
        {/* min-w-0 lets this side shrink, so a long name or file name no longer pushes the action icons out of the card. basis-56 is the room it needs: with less than that left beside the icons, they wrap under it instead of squeezing the name into a sliver. */}
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-4">
          {/* Thumbnail Preview */}
          <div className="w-16 h-16 bg-slate-50 rounded-lg overflow-hidden border border-slate-100 flex items-center justify-center flex-shrink-0 group-hover:border-indigo-100 transition-colors">
            <LayoutSVG layout={layoutObj} className="w-full h-full object-contain" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-slate-900 capitalize tracking-tight">{(typeof layoutObj === 'object' && layoutObj.displayName) || (layoutStr || '').replace(/_/g, ' ')}</h3>
              {isCalendar && (
                <span
                  data-testid={`calendar-badge-${layoutStr}`}
                  className="px-2 py-0.5 bg-emerald-100 text-emerald-800 text-[9px] rounded-full font-bold uppercase tracking-tight"
                  title="Calendar product — opens in the calendar layout editor"
                >
                  Calendar
                </span>
              )}
              {isBook && (
                <span
                  data-testid={`book-badge-${layoutStr}`}
                  className="px-2 py-0.5 bg-sky-100 text-sky-800 text-[9px] rounded-full font-bold uppercase tracking-tight"
                  title="Book product — opens in the book layout editor"
                >
                  Book
                </span>
              )}
              {isDeprecated && (
                renamedTo ? (
                  <span
                    data-testid={`renamed-badge-${layoutStr}`}
                    className="px-2 py-0.5 bg-amber-100 text-amber-800 text-[9px] rounded-full font-bold uppercase tracking-tight"
                    title={`Renamed to "${renamedTo}" — this identifier still resolves, it isn't a dead end`}
                  >
                    Renamed → {renamedTo}
                  </span>
                ) : (
                  <span
                    data-testid={`deleted-badge-${layoutStr}`}
                    className="px-2 py-0.5 bg-rose-100 text-rose-700 text-[9px] rounded-full font-bold uppercase tracking-tight"
                    title="Soft-deleted — no longer served to customers or partners"
                  >
                    Deleted
                  </span>
                )
              )}
            </div>
            <p className="text-[10px] text-slate-400 font-mono mt-0.5 tracking-wider break-all">{(layoutStr || '')}.json</p>
            {layoutObj.tags && layoutObj.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {layoutObj.tags.slice(0, 2).map((t: string) => (
                  <span key={t} className="px-2 py-0.5 bg-slate-100 text-slate-500 text-[9px] rounded-full font-bold uppercase tracking-tight">{t}</span>
                ))}
                {layoutObj.tags.length > 2 && (
                    <span className="text-[9px] text-slate-400 font-bold ml-0.5">+{layoutObj.tags.length - 2}</span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          {!isDeprecated && (
            <>
              <button
                onClick={() => { if (!isBook) openCopyModal(layoutStr); }}
                disabled={isBook}
                className="p-2 text-[#64318E] hover:bg-[#64318E]/10 rounded-lg transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                title={isBook ? 'Duplicating book layouts isn\'t supported yet' : 'Duplicate Layout'}
              >
                <Copy className="w-4 h-4" />
              </button>
              {isCalendar ? (
                <Link
                  href={`/editor/layouts/calendar/${layoutStr}`}
                  data-testid={`edit-calendar-${layoutStr}`}
                  className="p-2 text-[#F17A26] hover:bg-[#F17A26]/10 rounded-lg transition-all inline-flex items-center"
                  title="Edit Calendar Layout"
                >
                  <Edit2 className="w-4 h-4" />
                </Link>
              ) : isBook ? (
                <Link
                  href={`/editor/layouts/book/${layoutStr}`}
                  data-testid={`edit-book-${layoutStr}`}
                  className="p-2 text-[#F17A26] hover:bg-[#F17A26]/10 rounded-lg transition-all inline-flex items-center"
                  title="Edit Book Layout"
                >
                  <Edit2 className="w-4 h-4" />
                </Link>
              ) : (
                <button
                  onClick={() => openEditModal(layoutStr)}
                  className="p-2 text-[#F17A26] hover:bg-[#F17A26]/10 rounded-lg transition-all"
                  title="Edit Layout"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
              )}
              {!isCalendar && !isBook && (
                <Link
                  href={`/editor/layouts/templates/${encodeURIComponent(layoutStr)}`}
                  data-testid={`templates-${layoutStr}`}
                  className="p-2 text-[#64318E] hover:bg-[#64318E]/10 rounded-lg transition-all inline-flex items-center gap-1 text-[10px] font-bold"
                  title="Templates: ready-made decoration customers can start from"
                  aria-label={`Templates for ${layoutStr}`}
                >
                  <TemplateIcon className="w-4 h-4" />
                  {typeof layoutObj === 'object' && typeof layoutObj.templateCount === 'number' && layoutObj.templateCount > 0 ? layoutObj.templateCount : null}
                </Link>
              )}
            </>
          )}
          <button
            onClick={() => setDeleteConfirm(layoutStr)}
            disabled={isDeprecated}
            className="p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title={isDeprecated ? 'Already deleted' : 'Delete Layout'}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-slate-100/50 flex flex-col gap-1.5">
        {/* Structured Metadata (Prefer this if available) */}
        {layoutObj.metadata ? (
          <div className="space-y-3 pt-2">
            {layoutObj.metadata.filter((m: any) => m.key !== 'tags' || (Array.isArray(m.value) && m.value.length > 0)).map((meta: any) => (
              <div key={meta.key} className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                <span className="text-slate-400 font-medium">{meta.label}</span>
                <span className="text-slate-900 font-bold">
                  {meta.key.includes('At') ? new Date(meta.value).toLocaleString() : meta.value || 'N/A'}
                </span>
              </div>
            ))}
            {/* Fallback for dimensions if not in metadata */}
            {!layoutObj.metadata.some((m: any) => m.key === 'dimensions') && layoutObj.canvas && (
              <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                <span className="text-slate-400 font-medium">Dimensions</span>
                <span className="text-slate-900 font-bold">{layoutObj.canvas.widthMm?.toFixed(2)} x {layoutObj.canvas.heightMm?.toFixed(2)}mm</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
              <span className="text-slate-400 font-medium">Created By</span>
              <span className="text-slate-900 font-bold">{layoutObj.createdBy || 'System'}</span>
            </div>
            <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
              <span className="text-slate-400 font-medium">Created At</span>
              <span className="text-slate-900 font-bold">{layoutObj.createdAt ? new Date(layoutObj.createdAt).toLocaleString() : 'N/A'}</span>
            </div>
            <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
              <span className="text-slate-400 font-medium">Updated By</span>
              <span className="text-slate-900 font-bold">{layoutObj.updatedBy || 'System'}</span>
            </div>
            <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
              <span className="text-slate-400 font-medium">Last Updated</span>
              <span className="text-slate-900 font-bold">{layoutObj.updatedAt ? new Date(layoutObj.updatedAt).toLocaleString() : 'N/A'}</span>
            </div>
            {layoutObj.canvas && (
              <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                <span className="text-slate-400 font-medium">Dimensions</span>
                <span className="text-slate-900 font-bold">{layoutObj.canvas.widthMm?.toFixed(2)} x {layoutObj.canvas.heightMm?.toFixed(2)}mm</span>
              </div>
            )}
            {layoutObj.productType !== 'calendar' && layoutObj.productType !== 'book' && (
              <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                <span className="text-slate-400 font-medium">Print</span>
                <span className="text-slate-900 font-bold">{printSheetLabel(layoutObj.printSheet)}</span>
              </div>
            )}
            {(() => {
              const slots = resolveMaskSlots(layoutObj);
              const names = [slots.frameMaskUrl && 'Frame picture', slots.artworkMaskUrl && 'Artwork'].filter(Boolean);
              return names.length > 0 ? (
                <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                  <span className="text-slate-400 font-medium">Masks</span>
                  <span className="text-slate-900 font-bold">{names.join(' + ')}</span>
                </div>
              ) : null;
            })()}
            <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
              <span className="text-slate-400 font-medium">Version</span>
              <span className="text-slate-900 font-bold">{layoutObj.version ?? 'N/A'}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-6">
        <span className="text-sm font-semibold text-slate-500 flex items-center gap-1">
          <Eye className="w-4 h-4" />
          View Raw JSON
        </span>
        <button
          onClick={() => openViewModal(layoutStr)}
          aria-label="View Raw JSON"
          className="text-slate-500 hover:text-indigo-600 transition-colors"
        >
          <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
        </button>
      </div>
    </div>
  );
}

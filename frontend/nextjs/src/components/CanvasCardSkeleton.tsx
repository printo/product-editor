'use client';

type Props = {
  /** How many placeholder cards to draw. */
  count: number;
  /** CSS aspect-ratio for the thumbnail box, e.g. "1200 / 1800". */
  aspectRatio: string;
};

/**
 * Placeholder grid shown while a saved design is being restored.
 *
 * Without this the editor renders its "No images selected" empty state for the
 * ~2s between `layoutLoading` clearing and the restored canvases landing in
 * state — telling the customer their work is gone right before it reappears.
 *
 * Geometry is kept in sync with the real card grid in
 * `editor/layout/[name]/page.tsx` (same column classes, same card shell, same
 * thumbnail aspect ratio) so the swap to real cards doesn't shift the layout.
 */
export default function CanvasCardSkeleton({ count, aspectRatio }: Props) {
  return (
    <section role="status" aria-live="polite" className="space-y-6 pt-0">
      <span className="sr-only">Restoring your saved design…</span>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7 gap-3 sm:gap-3.5 justify-items-center sm:justify-items-stretch">
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="bg-white rounded-2xl border-2 border-slate-200 w-[86vw] max-w-sm sm:w-auto sm:max-w-none overflow-hidden"
          >
            <div
              className="relative bg-slate-100 animate-pulse rounded-t-2xl"
              style={{ aspectRatio }}
            />
            <div className="p-2.5 space-y-2">
              <div className="h-2.5 w-1/2 rounded-full bg-slate-100 animate-pulse" />
              <div className="h-2 w-3/4 rounded-full bg-slate-100 animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

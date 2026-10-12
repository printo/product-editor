'use client';

/**
 * /editor/layouts/holidays — add, edit and delete the holidays calendars
 * print. Auth-gated with the rest of /editor/layouts (src/proxy.ts).
 *
 * Suspense because HolidayManager reads `?locale=` / `?year=` through
 * useSearchParams, which a static build refuses outside a boundary.
 */

import { Suspense } from 'react';
import { HolidayManager } from './HolidayManager';

export default function HolidaysPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-slate-500">Loading holidays…</div>}>
      <HolidayManager />
    </Suspense>
  );
}

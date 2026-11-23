/**
 * The ops layout list: loaded once signed in (and again after a save or a
 * delete), plus the search, tag filter and "show deleted" choices that narrow
 * it. Moved out of page.tsx unchanged (docs/LAYOUTS_PAGE_SPLIT_PLAN.md, step 4).
 */
import { useCallback, useEffect, useState } from 'react';
import { layoutTagKeys } from '@/lib/layout-tags';

export function useLayoutList(status: string) {
  const [layouts, setLayouts] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  // Tag filter holds a tag key ('' = All). It narrows alongside the text
  // search so ops can type "5x7" while filtered to Photo Prints.
  const [activeTagFilter, setActiveTagFilter] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);

  const fetchLayouts = useCallback(async () => {
    try {
      // no-store: the endpoint sends Cache-Control: private, max-age=60, so a
      // refetch right after a create/delete would otherwise be served from the
      // browser cache and still show the row that was just removed.
      const res = await fetch('/api/internal/proxy/ops/layouts', {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      if (data.layouts) {
        const layoutDetails = (data.layouts || []).map((item: any) => {
          if (typeof item === 'string') return { name: item };
          return {
            ...item,
            id: item.name,
            tags: item.tags || [],
            tagKeys: layoutTagKeys(item),
          };
        });
        setLayouts(layoutDetails);
      }
    } catch (err) {
      console.error('Failed to fetch layouts', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the list once the session is confirmed; the load's first setState is the spinner
      fetchLayouts();
    }
  }, [status, fetchLayouts]);

  const visibleLayouts = layouts.filter((l: any) => {
    const q = searchQuery.toLowerCase();
    const name = typeof l === 'string' ? l : (l.name || '');
    const layoutTags: string[] = l.tags || [];
    // Text search matches name OR any tag name.
    const matchesSearch = !q || name.toLowerCase().includes(q) || layoutTags.some((t: string) => t.toLowerCase().includes(q));
    // Tag filter holds a tag key: '' means All.
    const matchesTag = !activeTagFilter || (l.tagKeys || []).includes(activeTagFilter);
    // Soft-deleted rows stay in the API response (see showDeleted) — keep
    // them out of the grid unless asked for.
    const isDeprecated = typeof l === 'object' && !!(l as any).isDeprecated;
    const matchesDeleted = showDeleted || !isDeprecated;
    return matchesSearch && matchesTag && matchesDeleted;
  });

  return {
    layouts, isLoading, fetchLayouts, visibleLayouts,
    searchQuery, setSearchQuery, activeTagFilter, setActiveTagFilter, showDeleted, setShowDeleted,
  };
}

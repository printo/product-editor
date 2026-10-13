'use client';

import { useEffect, useState } from 'react';
import { isLayoutTemplate, type LayoutTemplate } from './layout-template';

/** The published templates for this layout, loaded once the layout is known
 *  (GET /api/templates?layout=, through whichever proxy the page uses). Off
 *  for calendars and books, which templates don't cover yet. */
export function useLayoutTemplates({ apiBase, getAuthHeaders, layoutName, enabled }: {
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
  layoutName: string | null | undefined;
  enabled: boolean;
}): { templates: LayoutTemplate[]; templatesLoaded: boolean } {
  const [templates, setTemplates] = useState<LayoutTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  useEffect(() => {
    if (!enabled || !layoutName) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/templates?layout=${encodeURIComponent(layoutName)}`, {
          headers: { ...getAuthHeaders(), Accept: 'application/json' },
        });
        if (!res.ok) return;
        const data = await res.json();
        const list = Array.isArray(data?.templates) ? data.templates.filter(isLayoutTemplate) : [];
        if (!cancelled) setTemplates(list);
      } catch {
        // No templates is the quiet failure: the editor works without them.
      } finally {
        if (!cancelled) setTemplatesLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, getAuthHeaders, layoutName, enabled]);

  return { templates, templatesLoaded };
}

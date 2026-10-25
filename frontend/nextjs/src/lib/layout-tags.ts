'use client';

// The ops-managed layout tag list (`GET /api/layout-tags`). A tag has a fixed
// `key`, which is what layouts store (`tagKeys`) and what filters match on,
// and a `name` ops may rename. Switched-off tags stay on the layouts that
// carry them but are not offered for new picks. Backend twin of the key rule:
// services/layout_tags.py.

import { useCallback, useEffect, useState } from 'react';

export interface LayoutTagInfo {
  key: string;
  name: string;
  isActive: boolean;
  layoutCount: number;
}

export const TAG_KEY_MAX = 50;
export const TAG_NAME_MAX = 60;
export const MAX_TAGS_PER_LAYOUT = 20;

const TAG_KEY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function isTagKey(value: string): boolean {
  return value.length > 0 && value.length <= TAG_KEY_MAX && TAG_KEY_RE.test(value);
}

/** Suggested key for a name: 'Photo Prints' -> 'photo_prints'. */
export function keyForName(name: string): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.join('_').slice(0, TAG_KEY_MAX).replace(/^_+|_+$/g, '');
}

/** The tag keys a layout response carries; older responses carry none. */
export function layoutTagKeys(layout: { tagKeys?: unknown }): string[] {
  return Array.isArray(layout.tagKeys) ? layout.tagKeys.filter((k): k is string => typeof k === 'string') : [];
}

/** Display name for a key, falling back to the key itself. */
export function tagName(tags: LayoutTagInfo[], key: string): string {
  return tags.find(t => t.key === key)?.name ?? key;
}

/** Fetch the tag list through the internal proxy. Reads are open to every tier.
 *  `enabled` holds the request until the session is known, avoiding a 401. */
export function useLayoutTags(enabled = true) {
  const [tags, setTags] = useState<LayoutTagInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/internal/proxy/layout-tags', { cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error(`Could not load tags (HTTP ${res.status}).`);
        const body = (await res.json()) as { tags?: LayoutTagInfo[] };
        if (!cancelled) {
          setTags(Array.isArray(body.tags) ? body.tags : []);
          setError(null);
          setLoaded(true);
        }
      })
      .catch(e => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load tags.');
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { tags, error, loading: !loaded, reload };
}

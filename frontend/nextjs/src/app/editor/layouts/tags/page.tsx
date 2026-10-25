'use client';

/**
 * /editor/layouts/tags — create, rename and switch off layout tags.
 * Auth-gated with the rest of /editor/layouts (src/proxy.ts).
 */

import { TagManager } from './TagManager';

export default function TagsPage() {
  return <TagManager />;
}

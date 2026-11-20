'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Screen-reader announcements for the whole page.
 *
 * A live region only speaks reliably when it was already in the page before
 * its text arrived: a warning or toast that mounts with its text in it is
 * often never read out. So the page keeps two empty regions from the start
 * (`AnnouncerProvider`, in the root layout), and components hand them text
 * with `useAnnounce` or `useAnnounceWhen`. The visible message is drawn as
 * before, without a live role of its own, so nothing is read twice.
 *
 * Polite is for warnings, progress and confirmations; assertive (`role=alert`)
 * only for errors that stop what the customer was doing.
 */
type Announce = (text: string, opts?: { assertive?: boolean }) => void;

const AnnouncerContext = createContext<Announce>(() => {});

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const pending = useRef<{ polite: string[]; assertive: string[] }>({ polite: [], assertive: [] });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const announce = useCallback<Announce>((text, opts) => {
    pending.current[opts?.assertive ? 'assertive' : 'polite'].push(text);
    // Empty first, then the text: the same message twice in a row is a change
    // a screen reader notices only if the region was cleared in between.
    // Messages arriving together (two warnings at once) are read as one.
    if (timer.current) return;
    setPolite('');
    setAssertive('');
    timer.current = setTimeout(() => {
      timer.current = null;
      const { polite: p, assertive: a } = pending.current;
      pending.current = { polite: [], assertive: [] };
      if (p.length) setPolite(p.join(' '));
      if (a.length) setAssertive(a.join(' '));
    }, 50);
  }, []);

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div role="status" className="sr-only" data-testid="announcer-polite">{polite}</div>
      <div role="alert" className="sr-only" data-testid="announcer-assertive">{assertive}</div>
    </AnnouncerContext.Provider>
  );
}

/** The page's announcer; a no-op outside `AnnouncerProvider`. */
export function useAnnounce(): Announce {
  return useContext(AnnouncerContext);
}

/** Announces `text` each time it appears or changes (not when it goes away). */
export function useAnnounceWhen(text: string | null | undefined | false, opts?: { assertive?: boolean }): void {
  const announce = useAnnounce();
  const assertive = opts?.assertive ?? false;
  const last = useRef<string | null>(null);
  useEffect(() => {
    const next = text || null;
    if (next && next !== last.current) announce(next, { assertive });
    last.current = next;
  }, [text, assertive, announce]);
}

/** Same as `useAnnounceWhen`, but re-announces `text` whenever `key` changes,
 *  for a message that repeats with the same words (a second removal). */
export function useAnnounceKeyed(text: string | null, key: unknown, opts?: { assertive?: boolean }): void {
  const announce = useAnnounce();
  const assertive = opts?.assertive ?? false;
  const keyed = useMemo(() => ({ text, key }), [text, key]);
  useEffect(() => {
    if (keyed.text) announce(keyed.text, { assertive });
  }, [keyed, assertive, announce]);
}

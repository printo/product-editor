'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  checkedChars, coverageKey, fetchUnprintable, textNeedsCheck, unprintableGraphemes, withoutUnprintable,
  type PrintableItem,
} from '@/lib/print-coverage';
import type { CanvasItem, Overlay, SurfaceState } from './types';

/** How long to wait before each automatic retry of an unanswered check. */
const RETRY_DELAYS_MS = [1000, 3000, 8000];

/** A card whose text holds characters the print will leave out. */
export interface UnprintableText {
  /** "Canvas 3", or the side's label on a multi-sided product. */
  where: string;
  /** The pieces that won't print, as the customer reads them. */
  chars: string[];
}

const item = (o: Overlay): PrintableItem | null =>
  o.type === 'text' && textNeedsCheck(o.text) ? { text: checkedChars(o.text), fontFamily: o.fontFamily } : null;

/**
 * Text the print can't draw (an emoji in a script font, Hindi in a Latin
 * font). In the canvas editor it is not allowed: once the server has said a
 * character won't print, it is taken out of the text box and `removals`
 * counts up so the editor can say why. A card that already carries such text
 * (saved before the answer came, or restored) gets a badge and a notice
 * before submit; that part warns and never blocks. The answer is the
 * server's, cached per font and set of special characters, asked once after
 * typing pauses. A failed or unsure answer changes nothing, and is asked
 * again by itself up to three times.
 */
export function useUnprintableText({ surfaceStates, canvases, editingCanvas, setEditingCanvas, apiBase, getAuthHeaders }: {
  surfaceStates: SurfaceState[];
  canvases: CanvasItem[];
  editingCanvas: CanvasItem | null;
  setEditingCanvas: Dispatch<SetStateAction<CanvasItem | null>>;
  apiBase: string;
  getAuthHeaders: () => Record<string, string>;
}) {
  const [known, setKnown] = useState<Map<string, string[]>>(() => new Map());
  const [removals, setRemovals] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const attemptsRef = useRef(new Map<string, number>());
  const retryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  const askedRef = useRef(new Set<string>());
  const requestRef = useRef({ apiBase, getAuthHeaders });
  useEffect(() => { requestRef.current = { apiBase, getAuthHeaders }; }, [apiBase, getAuthHeaders]);

  const groups = useMemo(() => (
    surfaceStates.length > 1
      ? surfaceStates.map(s => ({ surfaceKey: s.key as string | null, label: s.label || s.key, canvases: s.canvases }))
      : [{ surfaceKey: null as string | null, label: null as string | null, canvases }]
  ), [surfaceStates, canvases]);

  useEffect(() => {
    const wanted = new Map<string, PrintableItem>();
    const want = (o: Overlay) => {
      const it = item(o);
      if (!it) return;
      const key = coverageKey(it);
      if (!known.has(key) && !askedRef.current.has(key)) wanted.set(key, it);
    };
    groups.forEach(g => g.canvases.forEach(c => c.overlays.forEach(want)));
    editingCanvas?.overlays.forEach(want);
    if (wanted.size === 0) return;

    const t = setTimeout(async () => {
      const entries = [...wanted.entries()];
      entries.forEach(([key]) => askedRef.current.add(key));
      let answers: (string[] | null)[] = entries.map(() => null);
      try {
        const { apiBase: base, getAuthHeaders: headers } = requestRef.current;
        answers = await fetchUnprintable(base, headers(), entries.map(([, it]) => it));
        // The same map back when nothing was answered: a new one would run
        // this effect again at once and ask in a loop for as long as the
        // server stayed unsure.
        setKnown(prev => {
          let next = prev;
          entries.forEach(([key], i) => {
            const r = answers[i];
            if (!r) return;
            if (next === prev) next = new Map(prev);
            next.set(key, r);
          });
          return next;
        });
      } catch {
        // Best effort: an unanswered check must never disturb the editor.
      } finally {
        entries.forEach(([key]) => askedRef.current.delete(key));
      }

      // Ask again by itself for whatever went unanswered (the request failed,
      // or the server could not read the font just now): a few tries, further
      // apart each time. Without this the unsupported character stayed in the
      // text box, with no toast, until the customer happened to type again.
      let retryIn: number | null = null;
      entries.forEach(([key], i) => {
        if (answers[i]) {
          attemptsRef.current.delete(key);
          return;
        }
        const tried = attemptsRef.current.get(key) ?? 0;
        if (tried >= RETRY_DELAYS_MS.length) return;
        attemptsRef.current.set(key, tried + 1);
        retryIn = Math.min(retryIn ?? Infinity, RETRY_DELAYS_MS[tried]);
      });
      if (retryIn !== null) {
        const timers = retryTimersRef.current;
        const retry = setTimeout(() => {
          timers.delete(retry);
          setRetryTick(n => n + 1);
        }, retryIn);
        timers.add(retry);
      }
    }, 350);
    return () => clearTimeout(t);
    // retryTick only re-runs the effect: a key still unanswered is wanted again.
  }, [groups, editingCanvas, known, retryTick]);

  /** The pieces of this overlay's text that won't print; [] when all will, or not yet known. */
  const unprintableFor = useCallback((o: Overlay): string[] => {
    const it = item(o);
    if (!it || o.type !== 'text') return [];
    return unprintableGraphemes(o.text, known.get(coverageKey(it)) ?? []);
  }, [known]);

  // The canvas editor does not keep what the print can't draw: take it out of
  // the text box. Runs on every edit, so a second paste of a character already
  // asked about is removed without another request.
  useEffect(() => {
    if (!editingCanvas) return;
    let changed = false;
    const overlays = editingCanvas.overlays.map(o => {
      const it = item(o);
      if (!it || o.type !== 'text') return o;
      const unprintable = known.get(coverageKey(it));
      if (!unprintable || unprintable.length === 0) return o;
      const text = withoutUnprintable(o.text, unprintable);
      if (text === o.text) return o;
      changed = true;
      return { ...o, text };
    });
    if (!changed) return;
    setEditingCanvas({ ...editingCanvas, overlays });
    setRemovals(n => n + 1);
  }, [editingCanvas, known, setEditingCanvas]);

  const { unprintableByCard, unprintableTexts } = useMemo(() => {
    const byCard = new Map<string, string[]>();
    const texts: UnprintableText[] = [];
    for (const g of groups) {
      g.canvases.forEach((c, idx) => {
        const chars: string[] = [];
        for (const o of c.overlays) {
          for (const ch of unprintableFor(o)) if (!chars.includes(ch)) chars.push(ch);
        }
        if (chars.length === 0) return;
        // Same key as lowDpiByCard, so the card looks both up the same way.
        byCard.set(`${g.surfaceKey ?? ''}:${idx}`, chars);
        const page = g.canvases.length > 1 || !g.label ? `Canvas ${idx + 1}` : '';
        texts.push({ where: [g.label, page].filter(Boolean).join(', '), chars });
      });
    }
    return { unprintableByCard: byCard, unprintableTexts: texts };
  }, [groups, unprintableFor]);

  return { unprintableFor, unprintableByCard, unprintableTexts, removals };
}

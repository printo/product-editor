/**
 * Which characters of a text box the print cannot draw.
 *
 * The browser borrows a glyph from another font on the device when the
 * chosen font has none, so an emoji typed into a caption shows in the
 * editor. The print draws from one font file and leaves it out (or draws an
 * empty box). The server knows which: `POST /api/text/printable` answers
 * from the font file the print uses (services/text_coverage.py), so there is
 * deliberately no copy of that rule here.
 */
import { readError } from '@/lib/read-error';

export interface PrintableItem {
  text: string;
  fontFamily?: string | null;
  fontWeight?: number;
}

const PLAIN = /^[\x20-\x7E\s]*$/;

/** Keyboard English needs no check: every font on the fonts list has it. */
export function textNeedsCheck(text: string): boolean {
  return !PLAIN.test(text);
}

/** The characters worth asking about: everything but keyboard English, each once. */
export function checkedChars(text: string): string {
  return Array.from(new Set(Array.from(text).filter(ch => !PLAIN.test(ch)))).sort().join('');
}

/** One answer serves every text box with the same font and the same special characters. */
export function coverageKey(item: PrintableItem): string {
  return `${(item.fontFamily ?? '').trim().toLowerCase()}|${item.fontWeight ?? 400}|${checkedChars(item.text)}`;
}

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
type SegmenterCtor = new (locale?: string, options?: { granularity: 'grapheme' }) => Segmenter;

function graphemes(text: string): string[] {
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!ctor) return Array.from(text);
  return Array.from(new ctor(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment);
}

/**
 * What to show the customer: the pieces of `text` as they read them (a
 * family emoji or a Hindi syllable is one piece) that hold a character the
 * print can't draw, each once, in reading order.
 */
export function unprintableGraphemes(text: string, unprintable: readonly string[]): string[] {
  if (unprintable.length === 0) return [];
  const bad = new Set(unprintable);
  const out: string[] = [];
  for (const piece of graphemes(text)) {
    if (!out.includes(piece) && Array.from(piece).some(ch => bad.has(ch))) out.push(piece);
  }
  return out;
}

/** `text` without the pieces `unprintableGraphemes` would list. */
export function withoutUnprintable(text: string, unprintable: readonly string[]): string {
  if (unprintable.length === 0) return text;
  const bad = new Set(unprintable);
  return graphemes(text).filter(piece => !Array.from(piece).some(ch => bad.has(ch))).join('');
}

/**
 * Ask the server which characters of each item won't print. One entry per
 * item: the characters, or `null` when the server couldn't tell just now
 * (unknown, not printable).
 */
export async function fetchUnprintable(
  apiBase: string,
  headers: Record<string, string>,
  items: PrintableItem[],
): Promise<(string[] | null)[]> {
  const res = await fetch(`${apiBase}/text/printable`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(await readError(res, `Printable check failed: ${res.status}`));
  const body = (await res.json()) as { results?: { unprintable?: string[]; checked?: boolean }[] };
  return items.map((_, i) => {
    const r = body.results?.[i];
    return r?.checked && Array.isArray(r.unprintable) ? r.unprintable : null;
  });
}

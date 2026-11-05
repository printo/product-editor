/**
 * lib/print-coverage — the editor's side of "this text won't print".
 *
 * The rule itself (which characters a font has) lives on the server and is
 * pinned by services/tests/test_text_coverage.py. These pin what the editor
 * does around it: plain English never asks, one answer is reused for every
 * text box with the same font and special characters, the customer is shown
 * whole emoji rather than code points, and an unsure server answer is
 * unknown, never "printable".
 */
import {
  checkedChars, coverageKey, fetchUnprintable, textNeedsCheck, unprintableGraphemes, withoutUnprintable,
} from '../print-coverage';

const MAN_DANCING = '\u{1F57A}';
const NOTES = '\u{1F3B6}';

describe('textNeedsCheck', () => {
  it('skips keyboard English, with line breaks', () => {
    expect(textNeedsCheck('Won the argument, still love her!\nLine 2\t~')).toBe(false);
    expect(textNeedsCheck('')).toBe(false);
  });

  it.each([`Hi ${MAN_DANCING}`, 'Café', '₹500', 'नमस्ते', 'வணக்கம்', '“quoted”'])('asks about %s', (text) => {
    expect(textNeedsCheck(text)).toBe(true);
  });
});

describe('coverageKey', () => {
  it('is the same for two captions with the same font and special characters', () => {
    const a = coverageKey({ text: `Won the argument ${MAN_DANCING} ${NOTES}`, fontFamily: 'Pacifico' });
    const b = coverageKey({ text: `${NOTES}${MAN_DANCING}${MAN_DANCING} something else entirely`, fontFamily: ' pacifico ' });
    expect(a).toBe(b);
  });

  it('differs by font, weight and characters', () => {
    const base = coverageKey({ text: MAN_DANCING, fontFamily: 'Pacifico' });
    expect(coverageKey({ text: MAN_DANCING, fontFamily: 'Inter' })).not.toBe(base);
    expect(coverageKey({ text: MAN_DANCING, fontFamily: 'Pacifico', fontWeight: 700 })).not.toBe(base);
    expect(coverageKey({ text: NOTES, fontFamily: 'Pacifico' })).not.toBe(base);
  });

  it('sends only the special characters, never the sentence', () => {
    expect(checkedChars(`Dear Asha, happy birthday ${MAN_DANCING}!`)).toBe(MAN_DANCING);
  });
});

describe('unprintableGraphemes', () => {
  it('lists each piece once, in reading order', () => {
    const text = `Won ${NOTES} the ${MAN_DANCING} argument ${NOTES}`;
    expect(unprintableGraphemes(text, [MAN_DANCING, NOTES])).toEqual([NOTES, MAN_DANCING]);
  });

  it('shows a joined emoji whole, not its parts', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(unprintableGraphemes(`us ${family}`, ['\u{1F468}', '\u{1F469}', '\u{1F467}'])).toEqual([family]);
  });

  it('keeps the heart with its colour selector', () => {
    expect(unprintableGraphemes('I ❤️ you', ['❤'])).toEqual(['❤️']);
  });

  it('is empty when everything prints', () => {
    expect(unprintableGraphemes(`fine ${MAN_DANCING}`, [])).toEqual([]);
  });
});

describe('withoutUnprintable', () => {
  it('takes out every piece that will not print and keeps the rest, line breaks included', () => {
    const text = `Won ${NOTES} the argument\n${MAN_DANCING} ${NOTES} ok`;
    expect(withoutUnprintable(text, [MAN_DANCING, NOTES])).toBe('Won  the argument\n  ok');
  });

  it('takes a joined emoji and a heart with its selector out whole', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(withoutUnprintable(`us ${family} \u2764\uFE0F!`, ['\u{1F468}', '\u{1F469}', '\u{1F467}', '\u2764'])).toBe('us  !');
  });

  it('returns the same text when everything prints', () => {
    expect(withoutUnprintable('Café ₹500', [])).toBe('Café ₹500');
  });
});

describe('fetchUnprintable', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const respond = (status: number, body: unknown) => {
    const mock = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  };

  it('posts the items and lines the answers up with them', async () => {
    const mock = respond(200, { results: [{ unprintable: [MAN_DANCING], checked: true }, { unprintable: [], checked: true }] });
    const items = [{ text: MAN_DANCING, fontFamily: 'Pacifico' }, { text: 'é', fontFamily: 'Inter' }];
    await expect(fetchUnprintable('/api/embed/proxy', { 'X-Embed-Token': 't' }, items)).resolves.toEqual([[MAN_DANCING], []]);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe('/api/embed/proxy/text/printable');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Embed-Token': 't', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ items });
  });

  it('treats an answer the server was unsure of as unknown', async () => {
    respond(200, { results: [{ unprintable: [], checked: false }] });
    await expect(fetchUnprintable('/api', {}, [{ text: MAN_DANCING, fontFamily: 'Lobster' }])).resolves.toEqual([null]);
  });

  it('treats a missing result as unknown', async () => {
    respond(200, { results: [] });
    await expect(fetchUnprintable('/api', {}, [{ text: MAN_DANCING }])).resolves.toEqual([null]);
  });

  it('throws on a refused request', async () => {
    respond(403, { detail: 'Path not allowed' });
    await expect(fetchUnprintable('/api', {}, [{ text: MAN_DANCING }])).rejects.toThrow('Path not allowed');
  });
});

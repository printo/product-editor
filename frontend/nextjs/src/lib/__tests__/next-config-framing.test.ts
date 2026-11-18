/**
 * Which pages may be framed. Every page refuses another site's frame except
 * the embed editor, which printo.in frames and which keeps its own
 * frame-ancestors policy. A second Content-Security-Policy rule must never be
 * added for the other pages: Next.js lets a later rule replace an earlier one
 * with the same header name, which would overwrite the whole-app policy.
 */
type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  const mod = await import('../../../next.config.mjs');
  return (mod.default as { headers: () => Promise<Rule[]> }).headers();
}

// Next.js builds each source with path-to-regexp; the sources used here are a
// catch-all, a negative lookahead and a named prefix, which RegExp reads the same.
function applies(source: string, path: string): boolean {
  const pattern = source
    .replace('/:path*', '/.*')
    .replace(/\/:name\*$/, '/.*');
  return new RegExp(`^${pattern}$`).test(path);
}

function headersFor(all: Rule[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of all.filter((r) => applies(r.source, path))) {
    for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

describe('framing policy', () => {
  it.each(['/dashboard', '/login', '/editor/layouts', '/editor/layouts/templates/x'])(
    '%s cannot be framed by another site',
    async (path) => {
      expect(headersFor(await rules(), path)['X-Frame-Options']).toBe('SAMEORIGIN');
    },
  );

  it('the embed editor is left to its own printo.in policy', async () => {
    const h = headersFor(await rules(), '/editor/layout/circle_48mm');
    expect(h['X-Frame-Options']).toBeUndefined();
    expect(h['Content-Security-Policy']).toContain('frame-ancestors');
    expect(h['Content-Security-Policy']).toContain('https://printo.in');
  });

  it('no non-editor rule sets Content-Security-Policy, which would replace the whole-app policy', async () => {
    const framing = (await rules()).filter((r) => r.source.includes('(?!editor/layout/)'));
    expect(framing).toHaveLength(1);
    expect(framing[0].headers.map((h) => h.key)).toEqual(['X-Frame-Options']);
  });
});

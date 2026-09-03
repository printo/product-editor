/**
 * Unit tests for the Phase 3 pre-submit guards (empty-surface and
 * duplicate-fill detection). Warn-and-proceed only — nothing here blocks.
 */
import {
  checkOrderQty,
  collectDuplicateFills,
  collectEmptySurfaces,
  duplicateFingerprint,
} from '@/lib/submit-guards';

let n = 0;
function makeFile(name: string): File {
  const f = new File(['x'.repeat(5 + (n % 3))], name, { type: 'image/jpeg' });
  Object.defineProperty(f, 'lastModified', { value: 1700000000000 + n++ });
  return f;
}

const frame = (file: File | null, fileId?: string) => ({ originalFile: file, fileId });
const canvasOf = (...frames: ReturnType<typeof frame>[]) => ({ frames });

describe('collectEmptySurfaces', () => {
  it('flags a surface with no canvases', () => {
    const out = collectEmptySurfaces([
      { key: 'front', label: 'Front', canvases: [canvasOf(frame(makeFile('a.jpg')))] },
      { key: 'back', label: 'Back', canvases: [] },
    ]);
    expect(out).toEqual([{ key: 'back', label: 'Back' }]);
  });

  it('flags a surface whose every frame is photo-less', () => {
    const out = collectEmptySurfaces([
      { key: 'front', label: 'Front', canvases: [canvasOf(frame(makeFile('a.jpg')))] },
      { key: 'back', label: 'Back', canvases: [canvasOf(frame(null), frame(null))] },
    ]);
    expect(out.map(s => s.key)).toEqual(['back']);
  });

  it('a lost-but-recoverable frame (fileId, no File) does NOT count as empty', () => {
    const out = collectEmptySurfaces([
      { key: 'front', label: 'Front', canvases: [canvasOf(frame(makeFile('a.jpg')))] },
      { key: 'back', label: 'Back', canvases: [canvasOf(frame(null, 'f-1'))] },
    ]);
    expect(out).toEqual([]);
  });

  it('single-surface layouts never warn', () => {
    expect(collectEmptySurfaces([{ key: 'only', label: 'Only', canvases: [] }])).toEqual([]);
  });

  it('all filled → no warnings', () => {
    const out = collectEmptySurfaces([
      { key: 'front', label: 'Front', canvases: [canvasOf(frame(makeFile('a.jpg')))] },
      { key: 'back', label: 'Back', canvases: [canvasOf(frame(makeFile('b.jpg')))] },
    ]);
    expect(out).toEqual([]);
  });
});

describe('collectDuplicateFills', () => {
  it('reports the same photo placed on two surfaces', () => {
    const a = makeFile('holiday.jpg');
    const out = collectDuplicateFills(
      [
        { label: 'Front', canvases: [canvasOf(frame(a))] },
        { label: 'Back', canvases: [canvasOf(frame(a))] },
      ],
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].fileName).toBe('holiday.jpg');
    expect(out[0].placements).toEqual(['Front', 'Back']);
  });

  it('content-identical but distinct File objects are still detected', () => {
    const a = makeFile('same.jpg');
    const b = new File(['x'.repeat(a.size)], 'same.jpg', { type: 'image/jpeg' });
    Object.defineProperty(b, 'lastModified', { value: a.lastModified });
    const out = collectDuplicateFills(
      [{ label: 'your design', canvases: [canvasOf(frame(a)), canvasOf(frame(b))] }],
      new Set(),
    );
    expect(out).toHaveLength(1);
  });

  it('deliberate qty auto-fill duplicates are exempt', () => {
    const a = makeFile('cycled.jpg');
    const out = collectDuplicateFills(
      [{ label: 'your design', canvases: [canvasOf(frame(a)), canvasOf(frame(a))] }],
      new Set([duplicateFingerprint(a)]),
    );
    expect(out).toEqual([]);
  });

  it('three distinct photos → nothing to report', () => {
    const out = collectDuplicateFills(
      [{
        label: 'your design',
        canvases: [canvasOf(frame(makeFile('1.jpg'))), canvasOf(frame(makeFile('2.jpg'))), canvasOf(frame(makeFile('3.jpg')))],
      }],
      new Set(),
    );
    expect(out).toEqual([]);
  });
});

describe('checkOrderQty', () => {
  it('exact match passes', () => {
    expect(checkOrderQty(12, 12, 1)).toEqual({ status: 'ok' });
  });

  it('fewer photos than ordered reports the shortfall', () => {
    expect(checkOrderQty(8, 12, 1)).toEqual({ status: 'under', uploaded: 8, needed: 12 });
  });

  it('more photos than ordered reports the cap, not a pass', () => {
    expect(checkOrderQty(20, 12, 1)).toEqual({ status: 'over', uploaded: 20, allowed: 12 });
  });

  it('no qty in the URL disables the check entirely', () => {
    expect(checkOrderQty(20, null, 1)).toEqual({ status: 'ok' });
  });

  it('a non-positive qty is ignored rather than capping everything to zero', () => {
    expect(checkOrderQty(5, 0, 1)).toEqual({ status: 'ok' });
    expect(checkOrderQty(5, -3, 1)).toEqual({ status: 'ok' });
  });

  it('multi-surface products opt out — qty does not describe their surface count', () => {
    expect(checkOrderQty(20, 12, 2)).toEqual({ status: 'ok' });
    expect(checkOrderQty(2, 12, 12)).toEqual({ status: 'ok' });
  });

  it('over is capped to exactly the ordered quantity when trimmed', () => {
    const verdict = checkOrderQty(20, 12, 1);
    expect(verdict.status).toBe('over');
    // Mirrors handleOverConfirm's "Keep first N" branch.
    const trimmed = Array.from({ length: 20 }, (_, i) => i)
      .slice(0, verdict.status === 'over' ? verdict.allowed : 0);
    expect(trimmed).toHaveLength(12);
    expect(checkOrderQty(trimmed.length, 12, 1)).toEqual({ status: 'ok' });
  });
});

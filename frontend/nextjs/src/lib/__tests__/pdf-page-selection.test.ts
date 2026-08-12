import {
  spliceExpandedPdfPages,
  toggleSelectAll,
  togglePageSelection,
} from '@/lib/pdf-page-selection';

function makeFile(name: string): File {
  return new File([new Uint8Array([1])], name, { type: 'image/png' });
}

describe('togglePageSelection', () => {
  it('adds and removes normally when unrestricted', () => {
    let selected = togglePageSelection(new Set(), 2, null);
    expect(selected).toEqual(new Set([2]));
    selected = togglePageSelection(selected, 5, null);
    expect(selected).toEqual(new Set([2, 5]));
    selected = togglePageSelection(selected, 2, null);
    expect(selected).toEqual(new Set([5]));
  });

  it('replaces the selection under maxSelectable=1', () => {
    let selected = togglePageSelection(new Set(), 0, 1);
    expect(selected).toEqual(new Set([0]));
    // Selecting page B after A yields {B} only, not {A, B}.
    selected = togglePageSelection(selected, 3, 1);
    expect(selected).toEqual(new Set([3]));
  });

  it('clears the selection when re-clicking the selected page under maxSelectable=1', () => {
    const selected = togglePageSelection(new Set([4]), 4, 1);
    expect(selected).toEqual(new Set());
  });

  it('stops accepting new picks once a numeric cap above 1 is full', () => {
    let selected = togglePageSelection(new Set(), 0, 2);
    selected = togglePageSelection(selected, 1, 2);
    expect(selected).toEqual(new Set([0, 1]));
    // Full — a third pick is ignored rather than evicting an existing one.
    selected = togglePageSelection(selected, 2, 2);
    expect(selected).toEqual(new Set([0, 1]));
    // But removing an existing one still works, freeing a slot.
    selected = togglePageSelection(selected, 0, 2);
    expect(selected).toEqual(new Set([1]));
  });

  it('never mutates the input Set', () => {
    const original = new Set([1]);
    togglePageSelection(original, 2, null);
    expect(original).toEqual(new Set([1]));
  });
});

describe('toggleSelectAll', () => {
  it('selects every page from empty', () => {
    expect(toggleSelectAll(new Set(), 4)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('selects every page from a partial selection', () => {
    expect(toggleSelectAll(new Set([1]), 4)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('clears the selection when everything is already selected', () => {
    expect(toggleSelectAll(new Set([0, 1, 2, 3]), 4)).toEqual(new Set());
  });
});

describe('spliceExpandedPdfPages', () => {
  it('splices a PDF\'s pages back into its original position', () => {
    const photoA = makeFile('a.jpg');
    const pdfX = makeFile('x.pdf');
    const photoB = makeFile('b.jpg');
    const p1 = makeFile('x-page-1.png');
    const p2 = makeFile('x-page-2.png');

    const result = spliceExpandedPdfPages([photoA, pdfX, photoB], new Map([[1, [p1, p2]]]));
    expect(result).toEqual([photoA, p1, p2, photoB]);
  });

  it('removes a cancelled PDF entirely, leaving no gap', () => {
    const photoA = makeFile('a.jpg');
    const pdfX = makeFile('x.pdf');
    const photoB = makeFile('b.jpg');

    const result = spliceExpandedPdfPages([photoA, pdfX, photoB], new Map([[1, []]]));
    expect(result).toEqual([photoA, photoB]);
  });

  it('passes non-PDF files through untouched when the map is empty', () => {
    const photoA = makeFile('a.jpg');
    const photoB = makeFile('b.jpg');
    expect(spliceExpandedPdfPages([photoA, photoB], new Map())).toEqual([photoA, photoB]);
  });

  it('handles multiple PDFs in the same batch independently', () => {
    const pdfX = makeFile('x.pdf');
    const pdfY = makeFile('y.pdf');
    const x1 = makeFile('x-page-1.png');
    const y1 = makeFile('y-page-1.png');
    const y2 = makeFile('y-page-2.png');

    const result = spliceExpandedPdfPages(
      [pdfX, pdfY],
      new Map([
        [0, [x1]],
        [1, [y1, y2]],
      ]),
    );
    expect(result).toEqual([x1, y1, y2]);
  });
});

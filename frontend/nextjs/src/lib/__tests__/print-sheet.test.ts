/**
 * Reading a layout's print sheet and the rectangles the ops editor and the
 * layout cards draw for it. The print itself is cut by services/print_sheet.py.
 */
import {
  printSheetAreasMm, printSheetAreasPx, printSheetLabel, printSheetMode, printSheetSource,
  printSheetToJson, readPrintSheet, typedSheet, windowsBleedAreaMm, windowsVisibleAreaMm,
} from '../print-sheet';

const typed = { mode: 'bleed', xMm: 10, yMm: 20, widthMm: 60, heightMm: 90, bleedMm: 3 } as const;
// Two windows as the ops editor holds them (visible rect + bleed).
const windows = [
  { xMm: 10, yMm: 20, widthMm: 35, heightMm: 50, bleedMm: 2 },
  { xMm: '55', yMm: '80', widthMm: '35', heightMm: '50', bleedMm: '2' },
];

describe('reading the setting', () => {
  it('is the whole canvas unless the mode says bleed', () => {
    expect(printSheetMode(undefined)).toBe('canvas');
    expect(printSheetMode({ mode: 'canvas' })).toBe('canvas');
    expect(printSheetMode({ mode: 'window' })).toBe('canvas');
    expect(printSheetMode({ mode: 'bleed' })).toBe('bleed');
    expect(readPrintSheet(null)).toEqual({ mode: 'canvas' });
    expect(readPrintSheet({ mode: 'bleed' })).toEqual({ mode: 'bleed' });
    expect(readPrintSheet(typed)).toEqual(typed);
  });

  it('needs all four numbers for a typed rectangle, and defaults the bleed to 0', () => {
    expect(typedSheet({ mode: 'bleed', xMm: 1, yMm: 2, widthMm: 3 })).toBeNull();
    expect(typedSheet({ mode: 'bleed', xMm: '1', yMm: 2, widthMm: 3, heightMm: 4 })).toBeNull();
    expect(typedSheet({ mode: 'bleed', xMm: 1, yMm: 2, widthMm: 3, heightMm: 4 })).toEqual({ xMm: 1, yMm: 2, widthMm: 3, heightMm: 4, bleedMm: 0 });
    expect(printSheetSource({ mode: 'bleed' })).toBe('windows');
    expect(printSheetSource(typed)).toBe('typed');
  });

  it('labels and serialises the three choices', () => {
    expect(printSheetLabel(undefined)).toBe('Whole canvas');
    expect(printSheetLabel({ mode: 'bleed' })).toBe('Bleed area (from the photo windows)');
    expect(printSheetLabel(typed)).toBe('Bleed area (typed)');
    const rect = { xMm: 1, yMm: 2, widthMm: 3, heightMm: 4, bleedMm: 1 };
    expect(printSheetToJson('canvas', 'typed', rect)).toEqual({ mode: 'canvas' });
    expect(printSheetToJson('bleed', 'windows', rect)).toEqual({ mode: 'bleed' });
    expect(printSheetToJson('bleed', 'typed', rect)).toEqual({ mode: 'bleed', ...rect });
  });
});

describe('the bleed area from the photo windows', () => {
  it('is the box around every window grown by its own bleed', () => {
    expect(windowsVisibleAreaMm(windows)).toEqual({ xMm: 10, yMm: 20, widthMm: 80, heightMm: 110 });
    expect(windowsBleedAreaMm(windows)).toEqual({ xMm: 8, yMm: 18, widthMm: 84, heightMm: 114 });
    expect(windowsBleedAreaMm([])).toBeNull();
  });

  it('gives the ops editor both rectangles, or nothing for a whole-canvas print', () => {
    expect(printSheetAreasMm({ mode: 'canvas' }, windows)).toBeNull();
    expect(printSheetAreasMm({ mode: 'bleed' }, windows)).toEqual({
      visible: { xMm: 10, yMm: 20, widthMm: 80, heightMm: 110 },
      bleed: { xMm: 8, yMm: 18, widthMm: 84, heightMm: 114 },
    });
    expect(printSheetAreasMm({ mode: 'bleed' }, [])).toBeNull();
    expect(printSheetAreasMm(typed, windows)).toEqual({
      visible: { xMm: 10, yMm: 20, widthMm: 60, heightMm: 90 },
      bleed: { xMm: 7, yMm: 17, widthMm: 66, heightMm: 96 },
    });
  });
});

describe('the rectangles on a layout card', () => {
  // 100 x 150 mm at 10 px/mm; stored windows are fractions that already include the bleed.
  const canvas = { width: 1000, height: 1500, widthMm: 100, heightMm: 150 };
  const stored = [
    { x: 0.08, y: 18 / 150, width: 0.39, height: 54 / 150, bleedMm: 2 },
    { x: 0.53, y: 78 / 150, width: 0.39, height: 54 / 150, bleedMm: 2 },
  ];

  it('comes from the windows', () => {
    expect(printSheetAreasPx({ mode: 'bleed' }, canvas, stored)).toEqual({
      visible: { x: 100, y: 200, width: 800, height: 1100 },
      bleed: { x: 80, y: 180, width: 840, height: 1140 },
    });
  });

  it('comes from a typed rectangle, rounded like the frames', () => {
    expect(printSheetAreasPx(typed, canvas, stored)).toEqual({
      visible: { x: 100, y: 200, width: 600, height: 900 },
      bleed: { x: 70, y: 170, width: 660, height: 960 },
    });
  });

  it('falls back to the dpi when the canvas has no mm size', () => {
    const px = printSheetAreasPx({ mode: 'bleed', xMm: 25.4, yMm: 0, widthMm: 25.4, heightMm: 25.4 }, { width: 600, height: 600, dpi: 300 }, []);
    expect(px?.visible).toEqual({ x: 300, y: 0, width: 300, height: 300 });
  });

  it('is nothing for a whole-canvas print or no windows', () => {
    expect(printSheetAreasPx(undefined, canvas, stored)).toBeNull();
    expect(printSheetAreasPx({ mode: 'bleed' }, canvas, [])).toBeNull();
  });
});

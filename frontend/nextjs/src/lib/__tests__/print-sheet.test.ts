/**
 * Reading a layout's print sheet and the rectangle the ops editor and the
 * layout cards draw for it. The print itself is cut by services/print_sheet.py.
 */
import {
  printSheetAreaMm, printSheetAreaPx, printSheetLabel, printSheetMode, readPrintSheet, windowsBleedAreaMm,
} from '../print-sheet';

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
  });

  it('keeps only the mode of whatever it is handed', () => {
    expect(readPrintSheet({ mode: 'bleed', xMm: 1, yMm: 2, widthMm: 3, heightMm: 4 })).toEqual({ mode: 'bleed' });
  });

  it('labels the two choices', () => {
    expect(printSheetLabel(undefined)).toBe('Whole canvas');
    expect(printSheetLabel({ mode: 'bleed' })).toBe('Bleed area');
  });
});

describe('the bleed area from the photo windows', () => {
  it('is the box around every window grown by its own bleed', () => {
    expect(windowsBleedAreaMm(windows)).toEqual({ xMm: 8, yMm: 18, widthMm: 84, heightMm: 114 });
    expect(windowsBleedAreaMm([])).toBeNull();
  });

  it('follows the windows: move one and the box moves', () => {
    const moved = [{ ...windows[0], xMm: 20 }, windows[1]];
    expect(windowsBleedAreaMm(moved)).toEqual({ xMm: 18, yMm: 18, widthMm: 74, heightMm: 114 });
  });

  it('gives the ops editor the rectangle, or nothing for a whole-canvas print', () => {
    expect(printSheetAreaMm({ mode: 'canvas' }, windows)).toBeNull();
    expect(printSheetAreaMm({ mode: 'bleed' }, windows)).toEqual({ xMm: 8, yMm: 18, widthMm: 84, heightMm: 114 });
    expect(printSheetAreaMm({ mode: 'bleed' }, [])).toBeNull();
  });
});

describe('the rectangle on a layout card', () => {
  // 100 x 150 mm at 10 px/mm; stored windows are fractions that already include the bleed.
  const canvas = { width: 1000, height: 1500 };
  const stored = [
    { x: 0.08, y: 18 / 150, width: 0.39, height: 54 / 150 },
    { x: 0.53, y: 78 / 150, width: 0.39, height: 54 / 150 },
  ];

  it('comes from the windows, rounded like the frames', () => {
    expect(printSheetAreaPx({ mode: 'bleed' }, canvas, stored)).toEqual({ x: 80, y: 180, width: 840, height: 1140 });
  });

  it('is nothing for a whole-canvas print or no windows', () => {
    expect(printSheetAreaPx(undefined, canvas, stored)).toBeNull();
    expect(printSheetAreaPx({ mode: 'bleed' }, canvas, [])).toBeNull();
  });
});

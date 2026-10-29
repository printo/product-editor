/**
 * Reading a layout's print sheet and the rectangle the ops editor and the
 * layout cards draw for it. The print itself is cut by services/print_sheet.py.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  boxKey, boxLabelIn, inches, printAreaBoxMm, printSheetAreaMm, printSheetAreaPx, printSheetLabel, printSheetMode, readPrintSheet,
  windowBoxMm, windowsBleedAreaMm,
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

describe('the window box a template is keyed on (parity with services/print_sheet.py)', () => {
  interface Case {
    name: string;
    canvas: { width: number; height: number; widthMm?: number; heightMm?: number };
    frames: Array<{ x: number; y: number; width: number; height: number; bleedMm?: number }>;
    windowBox: { xMm: number; yMm: number; widthMm: number; heightMm: number } | null;
    windowKey: string | null;
    printAreaBox: { xMm: number; yMm: number; widthMm: number; heightMm: number } | null;
    printAreaKey: string | null;
  }
  const fixture = path.resolve(__dirname, '../../../../../storage/parity-fixtures/template-window-box.json');
  const cases: Case[] = JSON.parse(fs.readFileSync(fixture, 'utf8')).cases;

  it('loads the shared fixture', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(windowBoxMm(c.canvas, c.frames)).toEqual(c.windowBox);
    expect(boxKey(windowBoxMm(c.canvas, c.frames))).toBe(c.windowKey);
    expect(printAreaBoxMm(c.canvas, c.frames)).toEqual(c.printAreaBox);
    expect(boxKey(printAreaBoxMm(c.canvas, c.frames))).toBe(c.printAreaKey);
  });

  it('keys a 1-inch and a half-inch frame picture around one window the same', () => {
    const byName = Object.fromEntries(cases.map(c => [c.name, c]));
    const key = (c: Case) => boxKey(windowBoxMm(c.canvas, c.frames));
    expect(key(byName['4x6 window with 0.3 in bleed inside a 1 in frame picture'])).toBe('117x168');
    expect(key(byName['the same window with 0.3 in bleed inside a half-inch frame picture'])).toBe('117x168');
    expect(key(byName['classic 4x6 print: one full-canvas window, no bleed'])).toBe('102x152');
  });

  it('labels a box in inches for the ops pages', () => {
    expect(boxLabelIn({ xMm: 0, yMm: 0, widthMm: 101.6, heightMm: 152.4 })).toBe('4 × 6 in');
    expect(boxLabelIn({ xMm: 0, yMm: 0, widthMm: 116.84, heightMm: 167.64 })).toBe('4.6 × 6.6 in');
    expect(boxLabelIn({ xMm: 0, yMm: 0, widthMm: 210.06, heightMm: 296.93 })).toBe('8.27 × 11.69 in');
    expect(boxLabelIn(null)).toBe('no print areas');
    expect(inches(7.62)).toBe('0.3');
    expect(inches(5)).toBe('0.2');
    expect(boxKey(null)).toBeNull();
  });
});

import fs from 'fs';
import path from 'path';
import { coverKeysPresent, isCoverKey, sheetLabels } from '../calendar-covers';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../../storage/parity-fixtures/calendar-cover-order.json'), 'utf8'),
);

const block = { canvas: { width: 400, height: 600 }, frames: [{}] };

describe('calendar cover sheet order (parity with services/calendar_covers.py)', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const layout = { frontCover: c.hasFront ? block : undefined, backCover: c.hasBack ? block : undefined };
      expect(sheetLabels(layout, c.months)).toEqual(c.expected);
    });
  }

  it('a block without a canvas is not a cover', () => {
    expect(coverKeysPresent({ frontCover: {} as never })).toEqual([]);
    expect(coverKeysPresent(null)).toEqual([]);
  });

  it('knows its own keys', () => {
    expect(isCoverKey('cover_front')).toBe(true);
    expect(isCoverKey('month_01')).toBe(false);
  });
});

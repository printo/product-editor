import { Rect } from 'fabric';
import { hideTextBoxVerticalHandles } from '../overlay-geometry';

// A Textbox cannot be built under happy-dom (it needs a real text-measuring
// canvas); every Fabric object shares the same control API, so a Rect shows
// that the call takes exactly these two handles away.
describe('hideTextBoxVerticalHandles', () => {
  it('takes the top and bottom handles off and keeps the others', () => {
    const box = new Rect({ width: 200, height: 40 });
    expect(box.isControlVisible('mt')).toBe(true);
    expect(box.isControlVisible('mb')).toBe(true);

    hideTextBoxVerticalHandles(box);

    expect(box.isControlVisible('mt')).toBe(false);
    expect(box.isControlVisible('mb')).toBe(false);
    for (const key of ['ml', 'mr', 'tl', 'tr', 'bl', 'br', 'mtr']) {
      expect(box.isControlVisible(key)).toBe(true);
    }
  });
});

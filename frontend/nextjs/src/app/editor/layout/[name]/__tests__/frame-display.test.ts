import { getFrameFillBehavior } from '../frame-display';
import { nearestQuarterTurn } from '../frame-fill';

describe('getFrameFillBehavior', () => {
  it('fills behind a photo of the frame’s own shape too: turned, shrunk or moved it leaves a gap', () => {
    expect(getFrameFillBehavior({ fitMode: 'contain', fillStyle: 'blur' }, 1000, 1000, 800, 800)).toEqual({
      enabled: true,
      style: 'blur',
    });
  });

  it('never fills in Cover', () => {
    expect(getFrameFillBehavior({ fitMode: 'cover', fillStyle: 'blur' }, 1600, 900, 800, 800)).toEqual({
      enabled: false,
      style: null,
    });
  });

  it('enables a blurred background when contain mode leaves whitespace', () => {
    expect(getFrameFillBehavior({ fitMode: 'contain', fillStyle: 'blur' }, 1600, 900, 800, 800)).toEqual({
      enabled: true,
      style: 'blur',
    });
  });

  it('falls back to a border-color fill when requested', () => {
    expect(getFrameFillBehavior({ fitMode: 'contain', fillStyle: 'border' }, 1600, 900, 800, 800)).toEqual({
      enabled: true,
      style: 'border',
    });
  });
});

describe('nearestQuarterTurn — the turn the blurred fill is drawn at', () => {
  it('matches the print engine, a tie going up', () => {
    // Same angles and answers as test_the_nearest_quarter_turn_rounds_a_tie_up
    // in services/tests/test_frame_fill.py.
    expect([0, 44, 45, 89, 135, 160, 314, 315, 359, 360, -30, -46].map(nearestQuarterTurn))
      .toEqual([0, 0, 90, 90, 180, 180, 270, 0, 0, 0, 0, 270]);
  });
});

import {
  shouldAutoRotate90, resolveRotation, formatWait, formatLayoutDisplayName,
  readCardCountHint, writeCardCountHint, MAX_SKELETON_CARDS, activatesCard,
} from '../editor-utils';
import type { OrientationOutcome, OrientationResult } from '@/lib/ml-orientation';

// Sizes from the worked examples in shouldAutoRotate90's comment.
const CLASSIC_5X7 = [1500, 2100] as const;      // ratio 0.714, clearly portrait
const RETRO_POLAROID = [945, 921] as const;     // ratio 1.026, near-square
const PORTRAIT_PHOTO = [3000, 4000] as const;   // 0.75
const LANDSCAPE_PHOTO = [4000, 3000] as const;  // 1.333

const pose = (rotation: OrientationResult['rotation']): OrientationResult => ({ rotation, confidence: 0.9, source: 'pose' });

describe('shouldAutoRotate90', () => {
  it('keeps a portrait photo upright in a portrait frame', () => {
    expect(shouldAutoRotate90(...PORTRAIT_PHOTO, ...CLASSIC_5X7)).toBe(false);
  });

  it('turns a landscape photo to fill a portrait frame', () => {
    expect(shouldAutoRotate90(...LANDSCAPE_PHOTO, ...CLASSIC_5X7)).toBe(true);
  });

  it('never turns a photo in a near-square frame (the retro polaroid case)', () => {
    expect(shouldAutoRotate90(...PORTRAIT_PHOTO, ...RETRO_POLAROID)).toBe(false);
    expect(shouldAutoRotate90(...LANDSCAPE_PHOTO, ...RETRO_POLAROID)).toBe(false);
  });

  it('treats frame ratios from 0.8 to 1.25, inclusive, as near-square', () => {
    expect(shouldAutoRotate90(...LANDSCAPE_PHOTO, 800, 1000)).toBe(false);
    expect(shouldAutoRotate90(...PORTRAIT_PHOTO, 1250, 1000)).toBe(false);
    expect(shouldAutoRotate90(...LANDSCAPE_PHOTO, 790, 1000)).toBe(true);
    expect(shouldAutoRotate90(...PORTRAIT_PHOTO, 1260, 1000)).toBe(true);
  });

  it('turns a photo only when that brings it at least 30% closer to the frame shape', () => {
    // Frame ratio 1.5. A 0.95 photo would get only ~19% closer; a 0.85 photo ~50%.
    expect(shouldAutoRotate90(950, 1000, 1500, 1000)).toBe(false);
    expect(shouldAutoRotate90(850, 1000, 1500, 1000)).toBe(true);
  });

  it('never turns a square photo', () => {
    expect(shouldAutoRotate90(1000, 1000, 1500, 1000)).toBe(false);
  });

  it('refuses zero or negative sizes', () => {
    expect(shouldAutoRotate90(0, 3000, ...CLASSIC_5X7)).toBe(false);
    expect(shouldAutoRotate90(...LANDSCAPE_PHOTO, 1500, -1)).toBe(false);
  });
});

describe('resolveRotation', () => {
  it('turns a photo to fill a clearly portrait or landscape frame, whatever the pose model says', () => {
    const outcomes: OrientationOutcome[] = [pose(180), pose(0), 'no-rotate', 'use-heuristic'];
    for (const outcome of outcomes) {
      expect(resolveRotation(outcome, ...LANDSCAPE_PHOTO, ...CLASSIC_5X7)).toBe(90);
    }
  });

  it('follows the pose model when turning would not improve the fill', () => {
    expect(resolveRotation(pose(270), ...PORTRAIT_PHOTO, ...CLASSIC_5X7)).toBe(270);
    expect(resolveRotation(pose(90), ...PORTRAIT_PHOTO, ...RETRO_POLAROID)).toBe(90);
  });

  it('leaves the photo as it is when the model finds nothing or is switched off', () => {
    expect(resolveRotation('no-rotate', ...PORTRAIT_PHOTO, ...RETRO_POLAROID)).toBe(0);
    expect(resolveRotation('use-heuristic', ...LANDSCAPE_PHOTO, ...RETRO_POLAROID)).toBe(0);
  });
});

describe('formatWait', () => {
  it('shows seconds to the nearest 5, never under 5', () => {
    expect(formatWait(0)).toBe('~5 s');
    expect(formatWait(12)).toBe('~10 s');
    expect(formatWait(13)).toBe('~15 s');
    expect(formatWait(89)).toBe('~90 s');
  });

  it('shows minutes from 90 seconds on', () => {
    expect(formatWait(90)).toBe('~2 min');
    expect(formatWait(149)).toBe('~2 min');
    expect(formatWait(150)).toBe('~3 min');
  });
});

describe('formatLayoutDisplayName', () => {
  // The same cases as DefaultDisplayNameTest (backend/django/api/tests/test_layout_rename_alias.py):
  // the server's default_display_name_for() must give the same answer.
  it('turns underscores into spaces and capitalises each word', () => {
    expect(formatLayoutDisplayName('classic_a4')).toBe('Classic A4');
    expect(formatLayoutDisplayName('retro_polaroid_-_4.2x3.5_in')).toBe('Retro Polaroid - 4.2x3.5 In');
  });

  it('returns an empty string for an empty name', () => {
    expect(formatLayoutDisplayName('')).toBe('');
  });

  it('collapses runs of underscores and trims the ends', () => {
    expect(formatLayoutDisplayName('__photo__strip__')).toBe('Photo Strip');
  });
});

describe('card-count hint', () => {
  const openOrder = (orderId?: string) =>
    window.history.replaceState(null, '', orderId ? `/editor/layout/x?order_id=${orderId}` : '/editor/layout/x');

  beforeEach(() => {
    window.localStorage.clear();
    openOrder();
  });
  afterEach(() => jest.restoreAllMocks());

  it('is remembered per order under pe:cards:<order id> and read back from the URL', () => {
    writeCardCountHint('ORD-1', 7);
    expect(window.localStorage.getItem('pe:cards:ORD-1')).toBe('7');
    openOrder('ORD-1');
    expect(readCardCountHint()).toBe(7);
  });

  it('reads 0 when the URL has no order id', () => {
    window.localStorage.setItem('pe:cards:ORD-1', '5');
    expect(readCardCountHint()).toBe(0);
  });

  it('is capped, so a bad value cannot render thousands of placeholders', () => {
    window.localStorage.setItem('pe:cards:ORD-1', '5000');
    openOrder('ORD-1');
    expect(readCardCountHint()).toBe(MAX_SKELETON_CARDS);
  });

  it('ignores anything that is not a positive number', () => {
    openOrder('ORD-1');
    for (const bad of ['abc', '0', '-3', '']) {
      window.localStorage.setItem('pe:cards:ORD-1', bad);
      expect(readCardCountHint()).toBe(0);
    }
  });

  it('is removed when the order has no cards left', () => {
    writeCardCountHint('ORD-1', 3);
    writeCardCountHint('ORD-1', 0);
    expect(window.localStorage.getItem('pe:cards:ORD-1')).toBeNull();
  });

  it('is not written without an order id', () => {
    writeCardCountHint('', 4);
    expect(window.localStorage.length).toBe(0);
  });

  it('survives storage that throws (private browsing, cross-site iframes)', () => {
    window.localStorage.setItem('pe:cards:ORD-1', '5');
    openOrder('ORD-1');
    // Where storage is blocked, merely touching window.localStorage throws.
    const access = jest.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });
    expect(readCardCountHint()).toBe(0);
    expect(() => writeCardCountHint('ORD-1', 3)).not.toThrow();
    expect(access).toHaveBeenCalled();
  });
});

describe('activatesCard', () => {
  const card = new EventTarget();
  const buttonInCard = new EventTarget();

  it('is Enter or Space pressed on the card itself', () => {
    expect(activatesCard({ key: 'Enter', target: card, currentTarget: card })).toBe(true);
    expect(activatesCard({ key: ' ', target: card, currentTarget: card })).toBe(true);
    expect(activatesCard({ key: 'a', target: card, currentTarget: card })).toBe(false);
  });

  it('leaves keys pressed on a button inside the card to that button', () => {
    expect(activatesCard({ key: 'Enter', target: buttonInCard, currentTarget: card })).toBe(false);
    expect(activatesCard({ key: ' ', target: buttonInCard, currentTarget: card })).toBe(false);
  });
});

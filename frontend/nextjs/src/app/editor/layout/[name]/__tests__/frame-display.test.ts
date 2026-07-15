import { getFrameFillBehavior } from '../frame-display';

describe('getFrameFillBehavior', () => {
  it('does not enable fill styling when the image already matches the frame ratio', () => {
    expect(getFrameFillBehavior({ fitMode: 'contain', fillStyle: 'blur' }, 1000, 1000, 800, 800)).toEqual({
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

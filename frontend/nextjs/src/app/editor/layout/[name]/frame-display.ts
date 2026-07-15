export type FrameFillStyle = 'blur' | 'border';

export interface FrameDisplayOptions {
  fitMode: 'contain' | 'cover';
  fillStyle: FrameFillStyle | string;
}

export function getFrameFillBehavior(
  options: FrameDisplayOptions,
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
) {
  if (options.fitMode !== 'contain') {
    return { enabled: false, style: null };
  }

  const imageRatio = imageWidth / Math.max(imageHeight, 1);
  const frameRatio = frameWidth / Math.max(frameHeight, 1);
  const needsFill = Math.abs(imageRatio - frameRatio) > 0.001;

  if (!needsFill) {
    return { enabled: false, style: null };
  }

  const style = options.fillStyle === 'border' ? 'border' : 'blur';
  return { enabled: true, style };
}

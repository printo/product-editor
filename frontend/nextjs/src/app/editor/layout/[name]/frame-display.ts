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

  // Always, in Fit: a photo of the frame's own shape still leaves the frame
  // showing once it is turned, made smaller or moved, and the fill used to be
  // skipped for it, so those gaps stayed white with Blur on. Behind a photo
  // that covers the frame it is simply not seen. The sizes stay in the
  // signature for the callers.
  void imageWidth; void imageHeight; void frameWidth; void frameHeight;

  const style = options.fillStyle === 'border' ? 'border' : 'blur';
  return { enabled: true, style };
}

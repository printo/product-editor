import { NumberField } from '@/components/ui/NumberField';

export type RectFrac = { x: number; y: number; width: number; height: number };

/**
 * X / Y / Width / Height in millimetres for a block stored as canvas
 * fractions (0..1). Typed mm → fraction, kept inside the canvas and at least
 * 1 mm wide/tall. Shared by the photo frames and the calendar block so both
 * tabs of the Layout step read and edit the same way.
 */
export function MmRectFields({
  rect, canvasW, canvasH, onPatch, testId,
}: {
  rect: RectFrac;
  canvasW: number;
  canvasH: number;
  onPatch: (next: Partial<RectFrac>) => void;
  testId?: string;
}) {
  const toMm = (f: number, total: number) => Math.round(f * total * 100) / 100;
  const setMm = (key: keyof RectFrac, mm: number) => {
    const total = key === 'x' || key === 'width' ? canvasW : canvasH;
    if (!(total > 0)) return;
    const f = mm / total;
    const minSize = Math.min(1, 1 / total);
    if (key === 'x') onPatch({ x: Math.min(Math.max(0, f), 1 - rect.width) });
    else if (key === 'y') onPatch({ y: Math.min(Math.max(0, f), 1 - rect.height) });
    else if (key === 'width') onPatch({ width: Math.min(Math.max(minSize, f), 1 - rect.x) });
    else onPatch({ height: Math.min(Math.max(minSize, f), 1 - rect.y) });
  };
  return (
    <div className="grid grid-cols-2 gap-2" data-testid={testId}>
      <NumberField label="X (mm)" value={toMm(rect.x, canvasW)} step={0.5} min={0} onChange={(n) => setMm('x', n)} />
      <NumberField label="Y (mm)" value={toMm(rect.y, canvasH)} step={0.5} min={0} onChange={(n) => setMm('y', n)} />
      <NumberField label="Width (mm)" value={toMm(rect.width, canvasW)} step={0.5} min={1} onChange={(n) => setMm('width', n)} />
      <NumberField label="Height (mm)" value={toMm(rect.height, canvasH)} step={0.5} min={1} onChange={(n) => setMm('height', n)} />
    </div>
  );
}

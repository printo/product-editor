/**
 * The pop-up that places a date's photo. It holds no copy of the placement:
 * every change goes to the design at once (so no preview can disagree with
 * another), and Cancel hands back the placement it opened with.
 */
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarCellPhotoDialog } from '@/components/CalendarCellPhotoDialog';
import type { CellImagePlacement } from '@/types/calendar';

const placed = (over: Partial<CellImagePlacement> = {}): CellImagePlacement =>
  ({ fit: 'cover', rotation: 0, blur: false, panX: 0, panY: 0, ...over });

function setup(initial: CellImagePlacement = placed()) {
  const onChange = jest.fn();
  const onSave = jest.fn();
  const onCancel = jest.fn();
  // The host: applies each change, as the editor does.
  function Host() {
    const [placement, setPlacement] = useState(initial);
    return (
      <CalendarCellPhotoDialog
        src="blob:p" placement={placement} cellAspect={1.5} dateLabel="Thursday, 1 January 2026"
        onChange={change => { onChange(change); setPlacement(p => ({ ...p, ...change })); }}
        onSave={onSave} onCancel={onCancel}
      />
    );
  }
  render(<Host />);
  return { onChange, onSave, onCancel, drawn: () => screen.getByTestId('calendar-cell-photo') };
}

describe('CalendarCellPhotoDialog', () => {
  it('is a named modal showing the stored placement in the date’s shape', () => {
    const { drawn } = setup(placed({ fit: 'contain', rotation: 180, blur: true }));
    expect(screen.getByRole('dialog', { name: 'Place the photo' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Thursday, 1 January 2026')).toBeInTheDocument();
    expect(drawn()).toHaveAttribute('data-fit', 'contain');
    expect(drawn()).toHaveAttribute('data-rotation', '180');
    expect(drawn()).toHaveAttribute('data-blur', 'on');
    expect(parseFloat(drawn().parentElement?.style.aspectRatio ?? '')).toBe(1.5);
  });

  it('each control reports its change at once; Save only closes', async () => {
    const { onChange, onSave, onCancel, drawn } = setup();
    expect(screen.getByTestId('cell-photo-blur')).toBeDisabled();
    await userEvent.click(screen.getByTestId('cell-photo-fit-contain'));
    expect(onChange).toHaveBeenLastCalledWith({ fit: 'contain' });
    await userEvent.click(screen.getByTestId('cell-photo-blur'));
    expect(onChange).toHaveBeenLastCalledWith({ blur: true });
    await userEvent.click(screen.getByTestId('cell-photo-rotate'));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 90, panX: 0, panY: 0 });
    expect(drawn()).toHaveAttribute('data-fit', 'contain');
    expect(drawn()).toHaveAttribute('data-rotation', '90');
    await userEvent.click(screen.getByTestId('cell-photo-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('four quarter turns come back to upright', async () => {
    const { onChange } = setup(placed({ rotation: 270 }));
    await userEvent.click(screen.getByTestId('cell-photo-rotate'));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 0, panX: 0, panY: 0 });
  });

  it('Cancel, the close button and Escape hand back the placement the pop-up opened with', async () => {
    const original = placed({ fit: 'contain', rotation: 90 });
    const { onSave, onCancel } = setup(original);
    await userEvent.click(screen.getByTestId('cell-photo-rotate'));
    await userEvent.click(screen.getByTestId('cell-photo-fit-cover'));
    await userEvent.click(screen.getByTestId('cell-photo-cancel'));
    await userEvent.click(screen.getByRole('button', { name: 'Close without saving' }));
    await userEvent.keyboard('{Escape}');
    expect(onCancel.mock.calls).toEqual([[original], [original], [original]]);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a click outside the pop-up does nothing', async () => {
    const { onSave, onCancel } = setup();
    await userEvent.click(screen.getByTestId('cell-photo-dialog-backdrop'));
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('the four arrows move a photo that fills the date, a step at a time, and stop at the edge', async () => {
    const { onChange, drawn } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Move photo left' }));
    expect(onChange).toHaveBeenLastCalledWith({ panX: -0.25 });
    await userEvent.click(screen.getByRole('button', { name: 'Move photo down' }));
    expect(onChange).toHaveBeenLastCalledWith({ panY: 0.25 });
    expect(drawn()).toHaveAttribute('data-pan', '-0.25,0.25');
    for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole('button', { name: 'Move photo left' }));
    expect(drawn()).toHaveAttribute('data-pan', '-1,0.25');
    expect(screen.getByRole('button', { name: 'Move photo left' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move photo right' })).toBeEnabled();
  });

  it('a whole photo has nowhere to move: the arrows are off', () => {
    setup(placed({ fit: 'contain' }));
    for (const way of ['left', 'up', 'down', 'right']) {
      expect(screen.getByRole('button', { name: `Move photo ${way}` })).toBeDisabled();
    }
  });

  it('a turn puts the photo back in the centre', async () => {
    const { onChange } = setup(placed({ panX: 0.5, panY: -1 }));
    await userEvent.click(screen.getByTestId('cell-photo-rotate'));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 90, panX: 0, panY: 0 });
  });

  it('dragging the preview moves the photo by its room, only the way it hangs over', () => {
    const { onChange, drawn } = setup();
    const preview = screen.getByTestId('cell-photo-preview');
    preview.getBoundingClientRect = () => ({ width: 300, height: 200, left: 0, top: 0, right: 300, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    // A 1200 x 400 photo filling a 300 x 200 box is drawn 600 wide: 300 px of room across, none down.
    const img = drawn().querySelector('img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1200 });
    Object.defineProperty(img, 'naturalHeight', { value: 400 });
    fireEvent.load(img);
    expect(screen.getByRole('button', { name: 'Move photo up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move photo left' })).toBeEnabled();
    fireEvent.pointerDown(preview, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(preview, { clientX: 175, clientY: 160, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith({ panX: 0.5, panY: 0 });
    fireEvent.pointerMove(preview, { clientX: 900, clientY: 100, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith({ panX: 1, panY: 0 });
    fireEvent.pointerUp(preview, { pointerId: 1 });
    onChange.mockClear();
    fireEvent.pointerMove(preview, { clientX: 0, clientY: 0, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});

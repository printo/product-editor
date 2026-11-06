/**
 * The pop-up that places a date's photo. It holds no copy of the placement:
 * every change goes to the design at once (so no preview can disagree with
 * another), and Cancel hands back the placement it opened with.
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarCellPhotoDialog } from '@/components/CalendarCellPhotoDialog';
import type { CellImagePlacement } from '@/types/calendar';

function setup(initial: CellImagePlacement = { fit: 'cover', rotation: 0, blur: false }) {
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
    const { drawn } = setup({ fit: 'contain', rotation: 180, blur: true });
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
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 90 });
    expect(drawn()).toHaveAttribute('data-fit', 'contain');
    expect(drawn()).toHaveAttribute('data-rotation', '90');
    await userEvent.click(screen.getByTestId('cell-photo-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('four quarter turns come back to upright', async () => {
    const { onChange } = setup({ fit: 'cover', rotation: 270, blur: false });
    await userEvent.click(screen.getByTestId('cell-photo-rotate'));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 0 });
  });

  it('Cancel, the close button and Escape hand back the placement the pop-up opened with', async () => {
    const original: CellImagePlacement = { fit: 'contain', rotation: 90, blur: false };
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
});

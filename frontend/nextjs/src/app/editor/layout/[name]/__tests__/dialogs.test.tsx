import { useState, type ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { AutoFillPickerDialog } from '../dialogs/AutoFillPickerDialog';
import { BookOverflowDialog } from '../dialogs/BookOverflowDialog';
import { DeleteConfirmDialog } from '../dialogs/DeleteConfirmDialog';
import { DownloadOptionsDialog } from '../dialogs/DownloadOptionsDialog';
import { EmbedDisclaimerDialog } from '../dialogs/EmbedDisclaimerDialog';
import { OverQuantityDialog } from '../dialogs/OverQuantityDialog';
import { RepickConfirmDialog } from '../dialogs/RepickConfirmDialog';
import { TruncatedImagesDialog } from '../dialogs/TruncatedImagesDialog';
import type { PreSubmitNoticeData } from '../EditorNotices';

const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
const NO_NOTICES: PreSubmitNoticeData = {
  lowDpiFrames: [], emptySurfaces: [], duplicateFills: [], totalUploadedCount: 0, qtyNeeded: 0,
};
/** The header's close button: an X icon with no text. */
const closeButton = (container: HTMLElement) => container.querySelector('button svg.lucide-x')!.closest('button')!;

describe('AutoFillPickerDialog', () => {
  function Picker({ files, needed, uploaded, onConfirm = jest.fn(), onClose = jest.fn() }: {
    files: File[]; needed: number; uploaded: number; onConfirm?: () => void; onClose?: () => void;
  }) {
    const [selected, setSelected] = useState<Set<number>>(new Set());
    return (
      <AutoFillPickerDialog
        qtyUnder={{ needed, uploaded }}
        files={files}
        getFileUrl={f => `blob:${f.name}`}
        pickerSelected={selected}
        setPickerSelected={setSelected}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    );
  }

  it('shows every photo and how many slots are left', () => {
    render(<Picker files={[photo('a.jpg'), photo('b.jpg')]} needed={5} uploaded={2} />);
    expect(screen.getByRole('dialog', { name: 'Choose images to repeat' }))
      .toHaveTextContent('Tap up to 3 images to duplicate into the remaining slots.');
    expect(screen.getByRole('img', { name: 'a.jpg' })).toHaveAttribute('src', 'blob:a.jpg');
  });

  it('says image and slot for a single remaining slot', () => {
    render(<Picker files={[photo('a.jpg')]} needed={2} uploaded={1} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('Tap up to 1 image to duplicate into the remaining slot.');
  });

  it('toggles photos and confirms only with at least one selected', () => {
    const onConfirm = jest.fn();
    render(<Picker files={[photo('a.jpg'), photo('b.jpg')]} needed={5} uploaded={2} onConfirm={onConfirm} />);
    expect(screen.getByRole('button', { name: 'Select at least one image' })).toBeDisabled();
    const a = screen.getByRole('button', { name: 'a.jpg' });
    fireEvent.click(a);
    expect(a).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'b.jpg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use 2 selected to fill 3 slots' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(a);
    expect(a).toHaveAttribute('aria-pressed', 'false');
  });

  it('closes', () => {
    const onClose = jest.fn();
    render(<Picker files={[photo('a.jpg')]} needed={2} uploaded={1} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('DeleteConfirmDialog', () => {
  it('removes the photo or cancels', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(<DeleteConfirmDialog onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText('Remove image?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('RepickConfirmDialog', () => {
  it('says how many edited pages would lose their adjustments', () => {
    const { rerender } = render(<RepickConfirmDialog losingCount={1} onDecide={jest.fn()} />);
    expect(screen.getByRole('alertdialog', { name: 'Replacing photos will discard edits' }))
      .toHaveTextContent('One page you edited uses photos that are not in the new selection');
    rerender(<RepickConfirmDialog losingCount={3} onDecide={jest.fn()} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('3 pages you edited use photos that are not in the new selection');
  });

  it('replaces anyway or keeps the edits', () => {
    const onDecide = jest.fn();
    render(<RepickConfirmDialog losingCount={2} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Replace anyway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits' }));
    expect(onDecide.mock.calls).toEqual([[true], [false]]);
  });
});

describe('OverQuantityDialog', () => {
  it('offers only "keep first N" or "choose again" — the quantity is a hard cap', () => {
    const onDecide = jest.fn();
    render(<OverQuantityDialog orderQty={5} selectedCount={8} onDecide={onDecide} />);
    expect(screen.getByRole('alertdialog', { name: 'More images than ordered' }))
      .toHaveTextContent('Your order is for 5 images but you selected 8. Only 5 can be printed on this order');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Keep first 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose again' }));
    expect(onDecide.mock.calls).toEqual([[true], [false]]);
  });

  it('says image for an order of one', () => {
    render(<OverQuantityDialog orderQty={1} selectedCount={2} onDecide={jest.fn()} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Your order is for 1 image but you selected 2.');
  });
});

describe('TruncatedImagesDialog', () => {
  it('names a cut-off file and offers to remove it or keep it', () => {
    const onDecide = jest.fn();
    render(<TruncatedImagesDialog badFiles={[photo('beach.jpg')]} onDecide={onDecide} />);
    expect(screen.getByText('Incomplete image detected')).toBeInTheDocument();
    expect(screen.getByText('• beach.jpg')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep anyway' }));
    expect(onDecide.mock.calls).toEqual([['remove'], ['keep']]);
  });

  it('counts and lists several', () => {
    render(<TruncatedImagesDialog badFiles={[photo('a.jpg'), photo('b.jpg')]} onDecide={jest.fn()} />);
    expect(screen.getByText('2 incomplete images detected')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Remove them' })).toBeInTheDocument();
  });
});

describe('BookOverflowDialog', () => {
  it('explains how many photos fit and offers to extend the book or keep its pages', () => {
    const onDecide = jest.fn();
    const overflow = { files: Array.from({ length: 30 }, (_, i) => photo(`p${i}.jpg`)), currentCapacity: 24, suggestedCount: 32 };
    render(<BookOverflowDialog overflow={overflow} pageCount={24} onDecide={onDecide} />);
    expect(screen.getByText("30 photos won't fit on 24 pages")).toBeInTheDocument();
    expect(screen.getByText('Only 24 of 30 photos will be used unless you add more pages. Extend to 32 pages to fit them all?'))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Extend to 32 pages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep 24 pages' }));
    expect(onDecide.mock.calls).toEqual([['extend'], ['keep']]);
  });
});

describe('DownloadOptionsDialog', () => {
  function setup(overrides: Partial<ComponentProps<typeof DownloadOptionsDialog>> = {}) {
    const props = {
      ...NO_NOTICES,
      disclaimerChecked: false, onDisclaimerChange: jest.fn(),
      includeUploads: false, onIncludeUploadsChange: jest.fn(),
      onClose: jest.fn(), onDownloadZip: jest.fn(), onImposition: jest.fn(),
      ...overrides,
    };
    return { ...render(<DownloadOptionsDialog {...props} />), props };
  }

  it('keeps both download options disabled until the disclaimer is ticked', () => {
    const { rerender, props } = setup();
    expect(screen.getByRole('button', { name: /ZIP Archive/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Imposition/ })).toBeDisabled();
    rerender(<DownloadOptionsDialog {...props} disclaimerChecked />);
    fireEvent.click(screen.getByRole('button', { name: /ZIP Archive/ }));
    expect(props.onDownloadZip).toHaveBeenCalledTimes(1);
    expect(props.onImposition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Imposition/ }));
    expect(props.onImposition).toHaveBeenCalledTimes(1);
    expect(props.onDownloadZip).toHaveBeenCalledTimes(1);
  });

  it('reports the disclaimer and the include-uploads checkbox', () => {
    const { props } = setup();
    const [disclaimer, uploads] = screen.getAllByRole('checkbox');
    fireEvent.click(disclaimer);
    fireEvent.click(uploads);
    expect(props.onDisclaimerChange).toHaveBeenCalledWith(true);
    expect(props.onIncludeUploadsChange).toHaveBeenCalledWith(true);
  });

  it('closes from the X button and from the backdrop', () => {
    const { container, props } = setup();
    fireEvent.click(closeButton(container));
    fireEvent.click(container.querySelector('.backdrop-blur-md')!);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('shows the pre-submit notices', () => {
    setup({ totalUploadedCount: 3, qtyNeeded: 5 });
    expect(screen.getByText('You have uploaded only 3 out of 5 photos')).toBeInTheDocument();
  });
});

describe('EmbedDisclaimerDialog', () => {
  function setup(overrides: Partial<ComponentProps<typeof EmbedDisclaimerDialog>> = {}) {
    const props = {
      ...NO_NOTICES,
      disclaimerChecked: false, onDisclaimerChange: jest.fn(),
      onClose: jest.fn(), onProceed: jest.fn(),
      ...overrides,
    };
    return { ...render(<EmbedDisclaimerDialog {...props} />), props };
  }

  it('proceeds only once the disclaimer is ticked', () => {
    const { rerender, props } = setup();
    expect(screen.getByRole('button', { name: 'Yes, Proceed' })).toBeDisabled();
    rerender(<EmbedDisclaimerDialog {...props} disclaimerChecked />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Proceed' }));
    expect(props.onProceed).toHaveBeenCalledTimes(1);
  });

  it('reports the disclaimer checkbox', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(props.onDisclaimerChange).toHaveBeenCalledWith(true);
  });

  it('closes from Go Back, the X button and the backdrop', () => {
    const { container, props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    fireEvent.click(closeButton(container));
    fireEvent.click(container.querySelector('.backdrop-blur-md')!);
    expect(props.onClose).toHaveBeenCalledTimes(3);
  });

  it('shows the pre-submit notices', () => {
    setup({ emptySurfaces: [{ key: 'back', label: 'Back' }] });
    expect(screen.getByText('One side has no photo')).toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { ImpositionModal } from '../ImpositionModal';
import { computeImpositionLayout, type ItemSize } from '../imposition';
import type { Imposition } from '../useImposition';
import type { ImpositionSettings } from '../types';

const A4: ImpositionSettings = {
  preset: 'a4', widthIn: 8.27, heightIn: 11.69, marginMm: 6, gutterMm: 5, orientation: 'portrait',
  cropMarksEnabled: true, cropMarkLenMm: 3,
};
const items = (n: number, size: ItemSize = { wIn: 4, hIn: 6 }) => Array.from({ length: n }, () => size);

/** A real layout result, wrapped the way useImposition returns it. */
function imposition(overrides: Partial<Imposition> = {}, layoutItems = items(20), settings = A4): Imposition {
  const result = computeImpositionLayout(settings, layoutItems);
  return {
    showImpositionModal: true, setShowImpositionModal: jest.fn(), isImposing: false,
    impositionSettings: settings, setImpositionSettings: jest.fn(),
    impositionPreviewRef: { current: null }, impositionPreviewBoxRef: { current: null },
    previewSheetIdx: 0, setPreviewSheetIdx: jest.fn(),
    impositionResult: result, sheetCount: result.sheets.length,
    impositionPlacedTotal: result.placedPerCanvas.reduce((a, b) => a + b, 0),
    impositionSheetLabel: settings.preset === 'custom' ? `${settings.widthIn}″ × ${settings.heightIn}″` : settings.preset.toUpperCase(),
    executeImposition: jest.fn(),
    ...overrides,
  } as Imposition;
}

/** Applies a setState argument the way React would. */
function applied<T>(arg: SetStateAction<T>, prev: T): T {
  return typeof arg === 'function' ? (arg as (p: T) => T)(prev) : arg;
}

describe('ImpositionModal', () => {
  it('says which sheet is previewed and offers every sheet for download', () => {
    const imp = imposition();
    render(<ImpositionModal imposition={imp} />);
    expect(imp.sheetCount).toBeGreaterThan(1);
    expect(screen.getByText(`Sheet 1 of ${imp.sheetCount}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Download ${imp.sheetCount} print sheets` })).toBeEnabled();
  });

  it('steps between sheets, and cannot step back from the first', () => {
    const imp = imposition();
    render(<ImpositionModal imposition={imp} />);
    expect(screen.getByRole('button', { name: 'Previous sheet' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next sheet' }));
    const arg = (imp.setPreviewSheetIdx as jest.Mock).mock.calls[0][0];
    expect(applied(arg, 0)).toBe(1);
  });

  it('changes the sheet size, and asks for width and height only for a custom size', () => {
    const imp = imposition();
    const { unmount } = render(<ImpositionModal imposition={imp} />);
    expect(screen.queryByText('Width')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'a3' }));
    const arg = (imp.setImpositionSettings as jest.Mock).mock.calls[0][0];
    expect(applied(arg, A4).preset).toBe('a3');
    unmount();
    render(<ImpositionModal imposition={imposition({}, items(2), { ...A4, preset: 'custom', widthIn: 12, heightIn: 18 })} />);
    expect(screen.getByText('Width')).toBeInTheDocument();
    expect(screen.getByText('Height')).toBeInTheDocument();
  });

  it('downloads, and holds the button while working', () => {
    const imp = imposition();
    const { rerender } = render(<ImpositionModal imposition={imp} />);
    fireEvent.click(screen.getByRole('button', { name: /print sheets?$/ }));
    expect(imp.executeImposition).toHaveBeenCalledTimes(1);
    rerender(<ImpositionModal imposition={{ ...imp, isImposing: true }} />);
    expect(screen.getByRole('button', { name: /print sheets?$/ })).toBeDisabled();
  });

  it('says when nothing fits, and offers nothing to download', () => {
    render(<ImpositionModal imposition={imposition({}, items(1, { wIn: 30, hIn: 30 }))} />);
    expect(screen.getByText('Nothing fits on this sheet')).toBeInTheDocument();
    expect(screen.getByText('1 canvas will not be printed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download print sheet' })).toBeDisabled();
  });

  it('closes from the X button and from the backdrop', () => {
    const imp = imposition();
    const { container } = render(<ImpositionModal imposition={imp} />);
    fireEvent.click(container.querySelector('button svg.lucide-x')!.closest('button')!);
    fireEvent.click(container.querySelector('.backdrop-blur-sm')!);
    expect((imp.setShowImpositionModal as jest.Mock).mock.calls).toEqual([[false], [false]]);
  });
});

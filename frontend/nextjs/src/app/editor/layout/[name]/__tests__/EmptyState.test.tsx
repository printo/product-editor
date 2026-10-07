import { fireEvent, render, screen } from '@testing-library/react';
import { EmptyState } from '../EmptyState';
import type { CanvasItem } from '../types';

function setup(over: Partial<Parameters<typeof EmptyState>[0]> = {}) {
  const input = document.createElement('input');
  const props = {
    isProcessing: false, canvases: [] as CanvasItem[], restorePending: false, restoreCount: 0,
    layout: { canvas: { width: 1200, height: 1800 } }, dragOverIdx: null, setDragOverIdx: jest.fn(),
    uploadInputRef: { current: input }, handleFileChange: jest.fn(async () => {}), ...over,
  };
  const click = jest.spyOn(input, 'click').mockImplementation(() => {});
  return { ...render(<EmptyState {...props} />), props, click };
}

describe('EmptyState', () => {
  it('while a saved design restores, shows placeholder cards — as many as last time, else three', () => {
    const { container, unmount } = setup({ restorePending: true, restoreCount: 5 });
    expect(screen.getByRole('status').querySelectorAll('[aria-hidden="true"]')).toHaveLength(5);
    expect(screen.queryByText('No images selected')).toBeNull();
    unmount();
    setup({ restorePending: true });
    expect(screen.getByRole('status').querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    expect(container).toBeDefined();
  });

  it('shows nothing once there are cards, or while photos are processing', () => {
    expect(setup({ canvases: [{} as CanvasItem] }).container).toBeEmptyDOMElement();
    expect(setup({ isProcessing: true }).container).toBeEmptyDOMElement();
  });

  it('opens the photo picker by click, Enter or Space', () => {
    const { click } = setup();
    const zone = screen.getByRole('button');
    expect(zone).toHaveTextContent('No images selected');
    fireEvent.click(zone);
    fireEvent.keyDown(zone, { key: 'Enter' });
    fireEvent.keyDown(zone, { key: ' ' });
    fireEvent.keyDown(zone, { key: 'a' });
    expect(click).toHaveBeenCalledTimes(3);
  });

  it('takes dropped photos, highlighting while they are over it', () => {
    const { props, unmount } = setup();
    const zone = screen.getByRole('button');
    fireEvent.dragOver(zone);
    expect(props.setDragOverIdx).toHaveBeenLastCalledWith({ idx: -1, surfaceKey: null });
    fireEvent.dragLeave(zone);
    expect(props.setDragOverIdx).toHaveBeenLastCalledWith(null);
    const files = [new File(['x'], 'a.jpg', { type: 'image/jpeg' })];
    fireEvent.drop(zone, { dataTransfer: { files } });
    expect(props.handleFileChange).toHaveBeenCalledWith({ target: { files } });
    unmount();
    setup({ dragOverIdx: { idx: -1, surfaceKey: null } });
    expect(screen.getByRole('button').className).toMatch(/border-indigo-500/);
  });

  it('a drop with no files does nothing', () => {
    const { props } = setup();
    fireEvent.drop(screen.getByRole('button'), { dataTransfer: { files: [] } });
    expect(props.handleFileChange).not.toHaveBeenCalled();
  });
});

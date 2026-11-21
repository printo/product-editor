/**
 * Save changes redraws the card the way every other card is drawn.
 *
 * Until 2026-11-22 it asked for an export-style render without masks, so on a
 * mug or a photo frame the frame picture vanished from the card after a save
 * and only came back on a refresh or a quick action.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CanvasEditorModal, type CanvasEditorModalProps } from '../CanvasEditorModal';
import { renderCanvas } from '../fabric-renderer';
import type { CanvasItem } from '../types';

jest.mock('../fabric-renderer', () => ({
  renderCanvas: jest.fn(async () => 'data:image/png;base64,U0FWRUQ='),
  calculateSmartCropOffsets: jest.fn(async () => ({ x: 0, y: 0 })),
}));
jest.mock('next/dynamic', () => () => () => null);
jest.mock('@/lib/use-is-phone', () => ({ useIsPhone: () => false }));
jest.mock('../CanvasEditorSidebar', () => ({
  CanvasEditorSidebar: ({ handleSaveChanges }: { handleSaveChanges: () => void }) => (
    <button onClick={handleSaveChanges}>Save changes</button>
  ),
}));

const layout = { name: 'mug', frameMaskUrl: '/api/layouts/masks/mug_mask_abc.png' };
const card = { frames: [], overlays: [], dataUrl: 'data:old' } as unknown as CanvasItem;

function props(over: Partial<CanvasEditorModalProps> = {}): CanvasEditorModalProps {
  return {
    activeCanvasIdx: 0,
    editingCanvas: card,
    canvases: [card],
    layout,
    globalFitMode: 'contain' as CanvasEditorModalProps['globalFitMode'],
    selectedFonts: [],
    apiBase: '/api',
    getAuthHeaders: () => ({}),
    setEditingCanvas: jest.fn(),
    setCanvases: jest.fn(),
    setFiles: jest.fn(),
    setError: jest.fn(),
    onClose: jest.fn(),
    onOpenCanvas: jest.fn(),
    getFileUrl: () => 'blob:x',
    loadGoogleFont: jest.fn(),
    skipNextGenerateRef: { current: false },
    expandPdfPages: async files => files,
    ...over,
  };
}

describe('CanvasEditorModal: Save changes', () => {
  it('redraws the card as a thumbnail, with the frame picture', async () => {
    const p = props();
    render(<CanvasEditorModal {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(p.onClose).toHaveBeenCalled());
    expect(renderCanvas).toHaveBeenCalledTimes(1);
    const [item, usedLayout, , options] = (renderCanvas as jest.Mock).mock.calls[0];
    expect(item).toBe(card);
    expect(usedLayout).toBe(layout);
    // No isExport and no includeMask:false: either one drops the frame picture.
    expect(options).toEqual({ thumbnail: true });
    expect(p.setCanvases).toHaveBeenCalledWith([
      expect.objectContaining({ dataUrl: 'data:image/png;base64,U0FWRUQ=' }),
    ]);
  });
});

describe('pictures drawn on an editor canvas', () => {
  // A picture loaded without crossOrigin from another address (the mask CDN)
  // taints the canvas: every toDataURL then throws a SecurityError, which is
  // what production alerted on for every mug and photo-frame edit.
  it.each(['FabricEditor.tsx', 'fabric-renderer.ts', 'CanvasEditorModal.tsx'])(
    '%s loads every picture with crossOrigin',
    file => {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      const loads = source.split('\n').filter(line => /\.fromURL\(|\.setSrc\(/.test(line));
      expect(loads.length).toBeGreaterThan(0);
      for (const line of loads) expect(line).toContain("crossOrigin: 'anonymous'");
    },
  );
});

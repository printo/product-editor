import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ProcessingOverlay } from '../ProcessingOverlay';

type Props = ComponentProps<typeof ProcessingOverlay>;
const IDLE: Props = {
  isProcessing: false, isDownloading: false, isImposing: false, renderProgress: null,
  serverRenderLabel: null, heicConverting: false, embedToken: null,
};
const show = (p: Partial<Props>) => render(<ProcessingOverlay {...IDLE} {...p} />);

describe('ProcessingOverlay', () => {
  it('shows nothing while idle, or while busy without progress yet', () => {
    expect(show({}).container).toBeEmptyDOMElement();
    expect(show({ isProcessing: true }).container).toBeEmptyDOMElement();
  });

  it('preview generation: "Processing your design", the percentage and the file count', () => {
    show({ isProcessing: true, renderProgress: { current: 1, total: 4 } });
    expect(screen.getByText('Processing Your Design')).toBeInTheDocument();
    expect(screen.getByText('Optimizing images for print')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('Rendering File 1 of 4')).toBeInTheDocument();
  });

  it('submit: reads as saving in the embed and as a download on the dashboard', () => {
    const { unmount } = show({ isDownloading: true, embedToken: 'tok', renderProgress: { current: 1, total: 2 } });
    expect(screen.getByText('Saving Your Design')).toBeInTheDocument();
    expect(screen.getByText('This may take a moment')).toBeInTheDocument();
    unmount();
    show({ isDownloading: true, renderProgress: { current: 40, total: 100 } });
    expect(screen.getByText('Preparing Download')).toBeInTheDocument();
    expect(screen.getByText('Bundling high-res print files')).toBeInTheDocument();
    expect(screen.getByText('Zipping... 40%')).toBeInTheDocument();
  });

  it('prefers the server render label when there is one', () => {
    show({ isDownloading: true, renderProgress: { current: 1, total: 3 }, serverRenderLabel: 'Uploading photos…' });
    expect(screen.getByText('Uploading photos…')).toBeInTheDocument();
  });

  it('imposition shows the same progress card', () => {
    show({ isImposing: true, renderProgress: { current: 3, total: 6 } });
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('HEIC conversion has its own card', () => {
    show({ heicConverting: true });
    expect(screen.getByText('Converting iPhone Photo')).toBeInTheDocument();
  });
});

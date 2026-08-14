/**
 * Component + serializer tests for BookLayoutEditor
 * (BOOK_LAYOUT_PRD.md §6 Phase 5).
 *
 * Covers:
 *   - draftToLayoutJson serialization → shape matches validate_book_layout
 *     (backend/django/api/validators.py) and services/book_layout.py
 *   - validateDraft catches the same bounds as the server validator
 *     (mirrors services/tests/test_book_validator.py's cases)
 *   - Field rendering + edit → state updates
 *   - Back-cover toggle: omitted by default (documented blank fallback),
 *     included in the JSON only when the checkbox is on
 *   - Save button gates on validation + fires onSave with serialized JSON
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BookLayoutEditor,
  draftToLayoutJson,
  validateDraft,
  type BookLayoutDraft,
} from '@/components/BookLayoutEditor';

function setup(propOverrides: Partial<React.ComponentProps<typeof BookLayoutEditor>> = {}) {
  const onSave = jest.fn().mockResolvedValue(undefined);
  const onCancel = jest.fn();
  const utils = render(
    <BookLayoutEditor onSave={onSave} onCancel={onCancel} {...propOverrides} />
  );
  return { ...utils, onSave, onCancel };
}

function goodDraft(overrides: Partial<BookLayoutDraft> = {}): BookLayoutDraft {
  const role = { canvasWidthMm: 210, canvasHeightMm: 297, dpi: 300, frames: [{ x: 0.05, y: 0.05, width: 0.9, height: 0.9 }] };
  return {
    name: 'softcover_a4',
    productType: 'book',
    bleedMm: 3,
    gutterMm: 10,
    paperThicknessMm: 0.12,
    coverThicknessMm: 0,
    pageCountMin: 20,
    pageCountMax: 60,
    pageCountStep: 4,
    pageCountDefault: 24,
    cover: { ...role },
    innerPage: { ...role },
    hasBackCover: false,
    backCover: { ...role },
    ...overrides,
  };
}

describe('draftToLayoutJson', () => {
  it('derives canvas px from mm + dpi and omits backCover by default', () => {
    const json = draftToLayoutJson(goodDraft()) as any;
    expect(json.productType).toBe('book');
    expect(json.book.cover.canvas.width).toBe(Math.round((210 * 300) / 25.4));
    expect(json.book.cover.canvas.height).toBe(Math.round((297 * 300) / 25.4));
    expect(json.book.pageCount).toEqual({ min: 20, max: 60, step: 4, default: 24 });
    expect(json.book.backCover).toBeUndefined();
  });

  it('includes backCover only when hasBackCover is set', () => {
    const json = draftToLayoutJson(goodDraft({ hasBackCover: true })) as any;
    expect(json.book.backCover).toBeDefined();
    expect(json.book.backCover.canvas.width).toBeGreaterThan(0);
  });
});

describe('validateDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(validateDraft(goodDraft())).toBeNull();
  });

  it('rejects a page-count grid the max cannot reach from min in whole steps', () => {
    const err = validateDraft(goodDraft({ pageCountMin: 20, pageCountMax: 61, pageCountStep: 4 }));
    expect(err).toMatch(/reachable/i);
  });

  it('rejects a default outside [min, max]', () => {
    const err = validateDraft(goodDraft({ pageCountDefault: 100 }));
    expect(err).toMatch(/default/i);
  });

  it('rejects a negative gutter', () => {
    const err = validateDraft(goodDraft({ gutterMm: -1 }));
    expect(err).toMatch(/gutterMm/);
  });

  it('rejects a cover with a non-positive canvas dimension', () => {
    const err = validateDraft(goodDraft({ cover: { ...goodDraft().cover, canvasWidthMm: 0 } }));
    expect(err).toMatch(/Cover/);
  });

  it('rejects a frame extending past the canvas edge', () => {
    const err = validateDraft(goodDraft({
      innerPage: { ...goodDraft().innerPage, frames: [{ x: 0.5, y: 0.5, width: 0.8, height: 0.8 }] },
    }));
    expect(err).toMatch(/extends past/);
  });

  it('does not validate the back cover when hasBackCover is off', () => {
    // A garbage backCover draft must not block save while the checkbox is off.
    const draft = goodDraft({ backCover: { canvasWidthMm: -5, canvasHeightMm: -5, dpi: 0, frames: [] } });
    expect(validateDraft(draft)).toBeNull();
  });

  it('rejects an invalid layout name', () => {
    expect(validateDraft(goodDraft({ name: 'bad name!' }))).toMatch(/letters, digits/);
  });
});

describe('BookLayoutEditor component', () => {
  it('renders with sensible defaults for a brand-new layout', () => {
    setup({ newLayoutName: 'my_new_book' });
    expect(screen.getByTestId('book-name-input')).toHaveValue('my_new_book');
    expect(screen.getByTestId('role-section-cover')).toBeInTheDocument();
    expect(screen.getByTestId('role-section-inner-page')).toBeInTheDocument();
    expect(screen.queryByTestId('role-section-back-cover')).not.toBeInTheDocument();
  });

  it('reveals the back-cover editor only once the checkbox is checked', async () => {
    setup();
    expect(screen.queryByTestId('role-section-back-cover')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('has-back-cover-checkbox'));
    expect(screen.getByTestId('role-section-back-cover')).toBeInTheDocument();
  });

  it('adds and removes frames on a role', async () => {
    setup();
    const before = screen.getAllByTestId(/^cover-frame-/).length;
    await userEvent.click(screen.getByTestId('cover-add-frame'));
    expect(screen.getAllByTestId(/^cover-frame-/)).toHaveLength(before + 1);
    await userEvent.click(screen.getByLabelText(`Remove frame ${before + 1}`));
    expect(screen.getAllByTestId(/^cover-frame-/)).toHaveLength(before);
  });

  it('blocks Save and shows an error when the draft is invalid', async () => {
    const { onSave } = setup();
    await userEvent.clear(screen.getByTestId('book-name-input'));
    await userEvent.type(screen.getByTestId('book-name-input'), 'bad name!');
    await userEvent.click(screen.getByTestId('save-btn'));
    expect(await screen.findByTestId('save-error')).toHaveTextContent(/letters, digits/);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('fires onSave with the serialized JSON when the draft is valid', async () => {
    const { onSave } = setup({ newLayoutName: 'valid_book' });
    await userEvent.click(screen.getByTestId('save-btn'));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0];
    expect(payload.name).toBe('valid_book');
    expect(payload.productType).toBe('book');
    expect(payload.book.cover).toBeDefined();
    expect(payload.book.innerPage).toBeDefined();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const { onCancel } = setup();
    await userEvent.click(screen.getByTestId('cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('seeds from an `initial` partial draft (existing-layout load path)', () => {
    setup({
      initial: {
        name: 'existing_book',
        pageCountDefault: 32,
        cover: { canvasWidthMm: 303, canvasHeightMm: 216, dpi: 300, frames: [{ x: 0, y: 0, width: 1, height: 1 }] },
      },
    });
    expect(screen.getByTestId('book-name-input')).toHaveValue('existing_book');
  });

  it('shows the resolved spine width computed from the default page count (R2)', () => {
    // Default draft: 24 pages, 0.12mm paper, 0mm cover thickness →
    // (24/2) * 0.12 + 2*0 = 1.44mm.
    setup();
    expect(screen.getByTestId('resolved-spine')).toHaveTextContent('1.44 mm');
  });

  it('recomputes the resolved spine live as the default page count changes', () => {
    setup();
    const defaultPagesInput = screen.getByRole('spinbutton', { name: /Default pages/i });
    // type="number" inputs don't support selection APIs in real browsers or
    // happy-dom, so simulating keystrokes (clear + type) can't reliably
    // replace the value — fire the change directly instead.
    fireEvent.change(defaultPagesInput, { target: { value: '40' } });
    // (40/2) * 0.12 = 2.4mm
    expect(screen.getByTestId('resolved-spine')).toHaveTextContent('2.40 mm');
  });
});

/**
 * The customer's template picker: lists the layout's templates with "start
 * blank", applies at once on an empty design, and asks first when cards
 * already exist (every card is rewritten). The same entry re-applies the
 * template in force.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TemplatePickerDialog } from '../dialogs/TemplatePickerDialog';
import type { LayoutTemplate } from '../layout-template';

const tpl = (id: string, displayName: string): LayoutTemplate => ({
  id, displayName, layoutName: 'classic_4x6', thumbnailUrl: null,
  decoration: { surfaces: { default: { bgColor: '#fff4e6', overlays: [] } } },
});
const TEMPLATES = [tpl('retro-birthday', 'Retro Birthday'), tpl('minimal', 'Minimal')];

describe('TemplatePickerDialog', () => {
  it('lists the templates and start blank, marking the one in force', () => {
    render(<TemplatePickerDialog templates={TEMPLATES} activeTemplate={TEMPLATES[1]} cardCount={0} firstStep={false} onPick={jest.fn()} onClose={jest.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Choose a template' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retro Birthday/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Minimal/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Start blank/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('applies straight away when there are no cards yet', async () => {
    const onPick = jest.fn();
    const onClose = jest.fn();
    render(<TemplatePickerDialog templates={TEMPLATES} activeTemplate={null} cardCount={0} firstStep={true} onPick={onPick} onClose={onClose} />);
    expect(screen.getByText('Start with a template')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retro Birthday/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(TEMPLATES[0]));
    expect(onClose).toHaveBeenCalled();
  });

  it('asks before rewriting existing cards, and can go back', async () => {
    const onPick = jest.fn();
    render(<TemplatePickerDialog templates={TEMPLATES} activeTemplate={null} cardCount={3} firstStep={false} onPick={onPick} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Retro Birthday/ }));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Use "Retro Birthday" on your 3 cards\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Retro Birthday/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all cards' }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(TEMPLATES[0]));
  });

  it('offers to re-apply the template in force, and to remove it', async () => {
    const onPick = jest.fn();
    render(<TemplatePickerDialog templates={TEMPLATES} activeTemplate={TEMPLATES[0]} cardCount={1} firstStep={false} onPick={onPick} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Retro Birthday/ }));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Apply "Retro Birthday" to your card again\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    fireEvent.click(screen.getByRole('button', { name: /Start blank/ }));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Remove the template from your card\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove template' }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(null));
  });

  it('says so when the layout has no templates', () => {
    render(<TemplatePickerDialog templates={[]} activeTemplate={null} cardCount={0} firstStep={false} onPick={jest.fn()} onClose={jest.fn()} />);
    expect(screen.getByText('No templates for this product yet.')).toBeTruthy();
  });
});

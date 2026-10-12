import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { CalendarDayPicker, type CalendarDayPickerProps } from '@/components/CalendarDayPicker';

const ENGLISH_2027 = Array.from({ length: 12 }, (_, i) => ({ year: 2027, month: i + 1 }));
const FINANCIAL_2027 = Array.from({ length: 12 }, (_, i) => ({ year: i < 9 ? 2027 : 2028, month: ((i + 3) % 12) + 1 }));

/** The picker is controlled; this host keeps the selection like the editor does. */
function Host(props: Partial<CalendarDayPickerProps> & { start: string; onSelect?: (iso: string) => void }) {
  const { start, onSelect, ...rest } = props;
  const [iso, setIso] = useState(start);
  return (
    <CalendarDayPicker
      iso={iso}
      months={ENGLISH_2027}
      weekStart="sunday"
      onSelectDate={next => { onSelect?.(next); setIso(next); }}
      {...rest}
    />
  );
}

const day = (name: RegExp | string) => screen.getByRole('button', { name });
const selected = () => screen.getByRole('button', { pressed: true });

describe('CalendarDayPicker', () => {
  it('shows the selected month with every day as a button, the selected one pressed', () => {
    render(<Host start="2027-03-01" />);
    expect(screen.getByTestId('day-picker-month')).toHaveTextContent('March 2027');
    expect(screen.getByRole('group', { name: 'Days in March 2027' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /March 2027/ })).toHaveLength(31);
    expect(selected()).toHaveAccessibleName('1 March 2027');
    // Only the selected day is a tab stop.
    expect(selected()).toHaveAttribute('tabindex', '0');
    expect(day('2 March 2027')).toHaveAttribute('tabindex', '-1');
  });

  it('clicking a day selects it', async () => {
    const onSelect = jest.fn();
    render(<Host start="2027-03-01" onSelect={onSelect} />);
    await userEvent.setup().click(day('17 March 2027'));
    expect(onSelect).toHaveBeenCalledWith('2027-03-17');
    expect(selected()).toHaveAccessibleName('17 March 2027');
  });

  it('marks days with entries and holidays, and names them', () => {
    render(
      <Host
        start="2027-03-01"
        cells={{
          '2027-03-08': [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
          '2027-03-10': [{ type: 'image', uploadId: 'u' }],
          '2027-03-12': [{ type: 'hide' }],
        }}
        holidays={[{ date: '2027-03-08', name: "Women's Day" }, { date: '2027-03-22', name: 'Holi' }]}
      />,
    );
    expect(day(/^8 March 2027/)).toHaveAccessibleName("8 March 2027, 2 entries, holiday: Women's Day");
    expect(day(/^8 March 2027/)).toHaveAttribute('data-has-entries', 'true');
    expect(day(/^8 March 2027/)).toHaveAttribute('data-has-holiday', 'true');
    expect(day(/^10 March 2027/)).toHaveAccessibleName('10 March 2027, photo');
    expect(day(/^12 March 2027/)).toHaveAccessibleName('12 March 2027, hidden');
    expect(day(/^22 March 2027/)).toHaveAccessibleName('22 March 2027, holiday: Holi');
    expect(day('9 March 2027')).not.toHaveAttribute('data-has-entries');
  });

  it('steps between months, keeping the day where the month has it', async () => {
    const user = userEvent.setup();
    render(<Host start="2027-01-31" />);
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(selected()).toHaveAccessibleName('28 February 2027');
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(selected()).toHaveAccessibleName('28 January 2027');
  });

  it('never leaves the printed months: English stops at January and December', () => {
    const { unmount } = render(<Host start="2027-01-15" />);
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled();
    unmount();
    render(<Host start="2027-12-15" />);
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  it('a Financial calendar runs April to the next March', async () => {
    const user = userEvent.setup();
    render(<Host start="2027-04-01" months={FINANCIAL_2027} />);
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    selected().focus();
    await user.keyboard('{ArrowLeft}');
    expect(selected()).toHaveAccessibleName('1 April 2027');
    await user.keyboard('{PageDown}'.repeat(11));
    expect(screen.getByTestId('day-picker-month')).toHaveTextContent('March 2028');
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
  });

  it('moves with the keyboard and keeps focus on the selected day', async () => {
    const user = userEvent.setup();
    render(<Host start="2027-03-01" />);
    selected().focus();
    await user.keyboard('{ArrowRight}');
    expect(selected()).toHaveAccessibleName('2 March 2027');
    expect(selected()).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(selected()).toHaveAccessibleName('9 March 2027');
    await user.keyboard('{End}');
    expect(selected()).toHaveAccessibleName('31 March 2027');
    await user.keyboard('{ArrowRight}');
    expect(selected()).toHaveAccessibleName('1 April 2027');
    expect(selected()).toHaveFocus();
    await user.keyboard('{Home}{ArrowUp}');
    expect(selected()).toHaveAccessibleName('25 March 2027');
    await user.keyboard('{PageUp}');
    expect(selected()).toHaveAccessibleName('25 February 2027');
    expect(selected()).toHaveFocus();
  });

  it('starts the week on Monday when the layout does', () => {
    render(<Host start="2027-03-01" weekStart="monday" />);
    // 1 March 2027 is a Monday: no blank before it.
    const group = screen.getByRole('group', { name: 'Days in March 2027' });
    expect(group.firstElementChild).toBe(day('1 March 2027'));
  });
});

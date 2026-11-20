import { act, fireEvent, render, screen } from '@testing-library/react';
import LoginPage from '../page';
import { AnnouncerProvider } from '@/lib/announcer';

let params = new URLSearchParams();
jest.mock('next/navigation', () => ({ useSearchParams: () => params }));
jest.mock('next/script', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/actions/auth', () => ({ loginAction: jest.fn(), googleLoginAction: jest.fn() }));

describe('login form', () => {
  beforeEach(() => { params = new URLSearchParams(); });

  it('names its fields so a password manager fills them', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Username / Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('the show-password button has a name and says whether it is on', () => {
    render(<LoginPage />);
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
  });

  it('reads a sign-in error out', () => {
    jest.useFakeTimers();
    params = new URLSearchParams('error=AccountInactive');
    render(<AnnouncerProvider><LoginPage /></AnnouncerProvider>);
    act(() => { jest.advanceTimersByTime(60); });
    expect(screen.getByTestId('announcer-assertive')).toHaveTextContent('no longer active');
    jest.useRealTimers();
  });
});

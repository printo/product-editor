import { render, screen } from '@testing-library/react';
import { HeaderUserMenu } from '../HeaderUserMenu';

describe('HeaderUserMenu', () => {
  it('renders the role badge as a link when given a href', () => {
    render(<HeaderUserMenu name="Kanna" roleLabel="Django Admin" roleHref="/django-admin/" onSignOut={() => {}} />);
    const link = screen.getByRole('link', { name: 'Django Admin' });
    expect(link).toHaveAttribute('href', '/django-admin/');
  });

  it('renders a plain badge when there is no href', () => {
    render(<HeaderUserMenu name="Kanna" roleLabel="Editor" onSignOut={() => {}} />);
    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

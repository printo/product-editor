import { headerRoleLabel } from '../header-role-label';

describe('headerRoleLabel', () => {
  it('shows Super Admin for is_super_user (even when also ops team)', () => {
    expect(headerRoleLabel({ is_super_user: true, is_ops_team: true })).toBe('Super Admin');
    expect(headerRoleLabel({ is_super_user: true, is_ops_team: false })).toBe('Super Admin');
  });

  it('shows Operations Team for ops-only users', () => {
    expect(headerRoleLabel({ is_super_user: false, is_ops_team: true })).toBe('Operations Team');
  });

  it('shows Designer for standard users', () => {
    expect(headerRoleLabel({ is_super_user: false, is_ops_team: false })).toBe('Designer');
    expect(headerRoleLabel(undefined)).toBe('Designer');
    expect(headerRoleLabel(null)).toBe('Designer');
  });
});

import { headerRoleLabel } from '../header-role-label';

const ALL_TRUE = { is_ops_team: true, is_deliveryq: true, pia_access: true };

describe('headerRoleLabel', () => {
  it('shows Super Admin only when every product flag is true', () => {
    // Same rule as the Django-admin gate, so the badge cannot claim a
    // privilege the gate would refuse.
    expect(headerRoleLabel(ALL_TRUE)).toBe('Super Admin');
  });

  it('shows Operations Team for ops-only users', () => {
    expect(headerRoleLabel({ is_ops_team: true, is_deliveryq: false, pia_access: false })).toBe('Operations Team');
    expect(headerRoleLabel({ is_ops_team: true, is_deliveryq: true, pia_access: false })).toBe('Operations Team');
  });

  it('ignores is_super_user, which PIA does not send', () => {
    // The badge keyed on this field for months and could never appear.
    expect(headerRoleLabel({ is_super_user: true } as never)).toBe('Designer');
    expect(headerRoleLabel({ ...ALL_TRUE, is_super_user: false })).toBe('Super Admin');
  });

  it('shows Designer for standard users', () => {
    expect(headerRoleLabel({ is_ops_team: false, is_deliveryq: false, pia_access: false })).toBe('Designer');
    expect(headerRoleLabel(undefined)).toBe('Designer');
    expect(headerRoleLabel(null)).toBe('Designer');
  });
});

import { isAdmin, canManageTemplates, roleLabel, isRegistrationActive } from '../roles';

/**
 * The role model gates the Django admin (read/edit/delete on every table) and
 * ops-owned config. Each case below is a request that would otherwise reach
 * one of those.
 */

const ADMIN = { is_staff: true, is_ops_team: false };
const OPS = { is_staff: false, is_ops_team: true };
const EDITOR = { is_staff: false, is_ops_team: false };

describe('isAdmin', () => {
  it('is exactly is_staff', () => {
    expect(isAdmin(ADMIN)).toBe(true);
    expect(isAdmin(OPS)).toBe(false);
    expect(isAdmin(EDITOR)).toBe(false);
  });

  it('denies an absent or empty session', () => {
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin({})).toBe(false);
  });

  it('requires literal true, not merely truthy', () => {
    // PIA sends booleans. Anything else means the shape changed, and we should
    // not be guessing about a table-wide-delete grant.
    expect(isAdmin({ is_staff: 1 } as never)).toBe(false);
    expect(isAdmin({ is_staff: 'yes' } as never)).toBe(false);
  });

  it('ignores the other PIA product flags entirely', () => {
    // is_deliveryq and pia_access grant access to different products; an
    // earlier rule required all of them, which made breadth of job into
    // privilege.
    expect(isAdmin({ is_ops_team: true, is_deliveryq: true, pia_access: true } as never)).toBe(false);
  });

  it('ignores is_superuser, which marked a courier service account in PIA', () => {
    // It DENIED app access there. Its return must never grant anything.
    expect(isAdmin({ is_superuser: true } as never)).toBe(false);
    expect(isAdmin({ is_staff: true, is_superuser: false } as never)).toBe(true);
  });
});

describe('canManageTemplates', () => {
  it('allows the ops team', () => {
    expect(canManageTemplates(OPS)).toBe(true);
  });

  it('allows an admin without needing an ops flag too', () => {
    // "Admin gets everything below" — an administrator must not have to be
    // separately flagged into the ops team.
    expect(canManageTemplates(ADMIN)).toBe(true);
  });

  it('denies the editor tier', () => {
    expect(canManageTemplates(EDITOR)).toBe(false);
    expect(canManageTemplates(undefined)).toBe(false);
    expect(canManageTemplates({})).toBe(false);
  });
});

describe('roleLabel', () => {
  it('names each tier, and never claims more than the gates allow', () => {
    expect(roleLabel(ADMIN)).toBe('Admin');
    expect(roleLabel(OPS)).toBe('Operations Team');
    expect(roleLabel(EDITOR)).toBe('Editor');
    expect(roleLabel(undefined)).toBe('Editor');
  });

  it('shows Admin for is_staff even without the ops flag', () => {
    expect(roleLabel({ is_staff: true })).toBe('Admin');
  });
});

describe('isRegistrationActive', () => {
  it('accepts ACTIVE, case- and space-insensitively', () => {
    expect(isRegistrationActive({ registration_status: 'ACTIVE' })).toBe(true);
    expect(isRegistrationActive({ registration_status: ' active ' })).toBe(true);
  });

  it('rejects any other explicit status', () => {
    // PIA's /auth/ does not refuse these logins, so this check is the only
    // thing standing between a departed employee and a working session.
    expect(isRegistrationActive({ registration_status: 'INACTIVE' })).toBe(false);
    expect(isRegistrationActive({ registration_status: 'SUSPENDED' })).toBe(false);
    expect(isRegistrationActive({ registration_status: 'PENDING' })).toBe(false);
  });

  it('treats an absent status as active, deliberately', () => {
    // Failing closed here would lock out every user the moment PIA shipped a
    // payload without the field — and their Google endpoint has already
    // omitted a field the password endpoint sent. The caller logs the absence
    // instead, so we notice without an outage.
    expect(isRegistrationActive({})).toBe(true);
    expect(isRegistrationActive(undefined)).toBe(true);
    expect(isRegistrationActive({ registration_status: '' })).toBe(true);
  });
});

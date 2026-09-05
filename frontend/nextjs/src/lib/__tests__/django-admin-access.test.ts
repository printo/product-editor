import { hasFullAccess, REQUIRED_FLAGS } from '../django-admin-access';

/**
 * This rule gates the Django admin, which can read, edit and delete every
 * table. Each case below is a request that would otherwise reach that.
 */

const ALL_TRUE = { is_ops_team: true, is_deliveryq: true, pia_access: true };

describe('hasFullAccess', () => {
  it('grants only when every product flag is true', () => {
    expect(hasFullAccess(ALL_TRUE)).toBe(true);
  });

  it('denies when any single flag is false', () => {
    for (const flag of REQUIRED_FLAGS) {
      expect(hasFullAccess({ ...ALL_TRUE, [flag]: false })).toBe(false);
    }
  });

  it('denies when any single flag is missing', () => {
    // A payload that quietly stops carrying a flag must fail closed, not be
    // coerced into a grant.
    for (const flag of REQUIRED_FLAGS) {
      const partial = { ...ALL_TRUE };
      delete (partial as Record<string, unknown>)[flag];
      expect(hasFullAccess(partial)).toBe(false);
    }
  });

  it('denies the real-world ops-only session that prompted this rule', () => {
    // kanna.p@printo.in, 2026-09-05 — the exact PIA payload.
    expect(hasFullAccess({ is_ops_team: true, is_deliveryq: false, pia_access: false })).toBe(false);
  });

  it('denies an absent session', () => {
    expect(hasFullAccess(undefined)).toBe(false);
    expect(hasFullAccess(null)).toBe(false);
    expect(hasFullAccess({})).toBe(false);
  });

  it('requires literal true, not merely truthy', () => {
    // PIA sends booleans; anything else means the shape changed and we should
    // not be guessing about a table-wide-delete grant.
    const truthy = { is_ops_team: 1, is_deliveryq: 'yes', pia_access: {} } as unknown;
    expect(hasFullAccess(truthy as Parameters<typeof hasFullAccess>[0])).toBe(false);
  });

  it('ignores is_superuser, which in PIA means a courier service account', () => {
    // It denies app access there, so it must never satisfy or influence this
    // gate — requiring it would make the rule satisfiable only by accounts
    // barred from the app.
    const withCourierFlag = { ...ALL_TRUE, is_superuser: true } as Parameters<typeof hasFullAccess>[0];
    expect(hasFullAccess(withCourierFlag)).toBe(true);
    const courierOnly = { is_superuser: true, is_staff: true } as Parameters<typeof hasFullAccess>[0];
    expect(hasFullAccess(courierOnly)).toBe(false);
  });
});

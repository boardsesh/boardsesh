import { describe, it, expect } from 'vitest';
import { rolesGrantGlobalAdmin, rolesGrantScopedAdmin, type AdminRoleScope } from '../admin-scope';

describe('admin scope predicates', () => {
  it('grants global admin for an unscoped admin row', () => {
    const roles: AdminRoleScope[] = [{ role: 'admin', boardType: null }];
    expect(rolesGrantGlobalAdmin(roles)).toBe(true);
    expect(rolesGrantScopedAdmin(roles)).toBe(false);
  });

  it('denies global admin for a board-scoped admin row', () => {
    const roles: AdminRoleScope[] = [{ role: 'admin', boardType: 'kilter' }];
    expect(rolesGrantGlobalAdmin(roles)).toBe(false);
    expect(rolesGrantScopedAdmin(roles)).toBe(true);
  });

  it('grants global admin when both a scoped and a global row are held', () => {
    const roles: AdminRoleScope[] = [
      { role: 'admin', boardType: 'kilter' },
      { role: 'admin', boardType: null },
    ];
    expect(rolesGrantGlobalAdmin(roles)).toBe(true);
  });

  it('ignores non-admin roles even when they are global', () => {
    const roles: AdminRoleScope[] = [
      { role: 'community_leader', boardType: null },
      { role: 'tester', boardType: null },
    ];
    expect(rolesGrantGlobalAdmin(roles)).toBe(false);
    expect(rolesGrantScopedAdmin(roles)).toBe(false);
  });

  it('treats a missing boardType the same as a null one', () => {
    const roles: AdminRoleScope[] = [{ role: 'admin' }];
    expect(rolesGrantGlobalAdmin(roles)).toBe(true);
    expect(rolesGrantScopedAdmin(roles)).toBe(false);
  });

  it('denies both for an empty role list', () => {
    expect(rolesGrantGlobalAdmin([])).toBe(false);
    expect(rolesGrantScopedAdmin([])).toBe(false);
  });
});

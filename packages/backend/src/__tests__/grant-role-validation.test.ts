import { describe, it, expect } from 'vite-plus/test';
import { GrantRoleInputSchema } from '../validation/schemas';

describe('GrantRoleInputSchema', () => {
  it('accepts a global tester grant with null boardType', () => {
    const result = GrantRoleInputSchema.safeParse({ userId: 'u1', role: 'tester', boardType: null });
    expect(result.success).toBe(true);
  });

  it('accepts a global tester grant with boardType omitted', () => {
    const result = GrantRoleInputSchema.safeParse({ userId: 'u1', role: 'tester' });
    expect(result.success).toBe(true);
  });

  it('rejects a board-scoped tester grant', () => {
    const result = GrantRoleInputSchema.safeParse({ userId: 'u1', role: 'tester', boardType: 'kilter' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['boardType']);
      expect(result.error.issues[0].message).toBe('Tester role is global and cannot be scoped to a board');
    }
  });

  it('still allows a board-scoped admin grant', () => {
    const result = GrantRoleInputSchema.safeParse({ userId: 'u1', role: 'admin', boardType: 'kilter' });
    expect(result.success).toBe(true);
  });

  it('still allows a board-scoped community_leader grant', () => {
    const result = GrantRoleInputSchema.safeParse({ userId: 'u1', role: 'community_leader', boardType: 'tension' });
    expect(result.success).toBe(true);
  });
});

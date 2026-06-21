import { describe, expect, it } from 'vitest';
import { brushRoleColor, getPaintRoles } from '../brush-roles';

describe('getPaintRoles', () => {
  it('excludes FOOT for MoonBoard saved-climb roles', () => {
    expect(getPaintRoles('moonboard')).toEqual(['STARTING', 'HAND', 'FINISH']);
  });

  it('returns all four paint roles for Kilter', () => {
    expect(getPaintRoles('kilter')).toEqual(['STARTING', 'HAND', 'FINISH', 'FOOT']);
  });

  it('uses configured role colour overrides when painting a role', () => {
    expect(brushRoleColor('kilter', 'HAND', { HAND: '#123456' })).toBe('#123456');
  });
});

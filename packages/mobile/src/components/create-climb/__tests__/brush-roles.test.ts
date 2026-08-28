import { describe, expect, it } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';
import { brushRoleColor, getNextBrushRole, getPaintRoles } from '../brush-roles';

describe('getPaintRoles', () => {
  it('excludes FOOT for MoonBoard saved-climb roles', () => {
    expect(getPaintRoles('moonboard')).toEqual(['STARTING', 'HAND', 'FINISH']);
  });

  // Callers read this during render, so an unknown board must degrade rather than
  // throw where nothing can catch it (#3804).
  it('returns no paint roles for a board missing from the role table', () => {
    expect(() => getPaintRoles('not-a-board' as BoardName)).not.toThrow();
    expect(getPaintRoles('not-a-board' as BoardName)).toEqual([]);
  });

  it('returns all four paint roles for Kilter', () => {
    expect(getPaintRoles('kilter')).toEqual(['STARTING', 'HAND', 'FINISH', 'FOOT']);
  });

  it('uses configured role colour overrides when painting a role', () => {
    expect(brushRoleColor('kilter', 'HAND', { HAND: '#123456' })).toBe('#123456');
  });
});

describe('getNextBrushRole', () => {
  it('assigns the selected brush to a blank hold', () => {
    expect(getNextBrushRole('kilter', 'OFF', 'HAND')).toBe('HAND');
  });

  it('cycles from the selected brush through the remaining roles, then OFF', () => {
    // Kilter roles are STARTING, HAND, FINISH, FOOT; brush selected is HAND.
    expect(getNextBrushRole('kilter', 'HAND', 'HAND')).toBe('FINISH');
    expect(getNextBrushRole('kilter', 'FINISH', 'HAND')).toBe('FOOT');
    expect(getNextBrushRole('kilter', 'FOOT', 'HAND')).toBe('STARTING');
    expect(getNextBrushRole('kilter', 'STARTING', 'HAND')).toBe('OFF');
  });

  it('wraps from OFF back to the selected brush', () => {
    expect(getNextBrushRole('kilter', 'OFF', 'FINISH')).toBe('FINISH');
  });

  it('skips FOOT for MoonBoard, matching its paint roles', () => {
    expect(getNextBrushRole('moonboard', 'STARTING', 'STARTING')).toBe('HAND');
    expect(getNextBrushRole('moonboard', 'FINISH', 'STARTING')).toBe('OFF');
  });

  it('starts the cycle at whichever role is currently the selected brush', () => {
    // Selecting FINISH as the brush rotates the cycle to start there.
    expect(getNextBrushRole('kilter', 'OFF', 'FINISH')).toBe('FINISH');
    expect(getNextBrushRole('kilter', 'FINISH', 'FINISH')).toBe('FOOT');
    expect(getNextBrushRole('kilter', 'FOOT', 'FINISH')).toBe('STARTING');
    expect(getNextBrushRole('kilter', 'STARTING', 'FINISH')).toBe('HAND');
    expect(getNextBrushRole('kilter', 'HAND', 'FINISH')).toBe('OFF');
  });

  it('always clears when the eraser brush is selected, regardless of current state', () => {
    expect(getNextBrushRole('kilter', 'HAND', 'OFF')).toBe('OFF');
    expect(getNextBrushRole('kilter', 'OFF', 'OFF')).toBe('OFF');
  });

  it('clears a hold in an unrecognised state instead of throwing', () => {
    expect(() => getNextBrushRole('not-a-board' as BoardName, 'OFF', 'HAND')).not.toThrow();
    expect(getNextBrushRole('not-a-board' as BoardName, 'OFF', 'HAND')).toBe('OFF');
  });
});

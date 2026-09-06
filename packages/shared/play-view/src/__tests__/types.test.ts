import { describe, it, expect } from 'vitest';
import { boardSupportsMirroring } from '../board-utils';

describe('boardSupportsMirroring', () => {
  it('returns true for tension with layout 1', () => {
    expect(boardSupportsMirroring('tension', 1)).toBe(true);
  });

  it('returns false for tension with layout 11', () => {
    expect(boardSupportsMirroring('tension', 11)).toBe(false);
  });

  it('returns true for decoy board', () => {
    expect(boardSupportsMirroring('decoy', 1)).toBe(true);
  });

  it('returns false for kilter board', () => {
    expect(boardSupportsMirroring('kilter', 1)).toBe(false);
  });

  it('returns false for an unknown board', () => {
    expect(boardSupportsMirroring('moonboard', 1)).toBe(false);
  });

  it('returns true for woods board', () => {
    expect(boardSupportsMirroring('woods', 1)).toBe(true);
  });

  it('returns true for tension with other layout ids', () => {
    expect(boardSupportsMirroring('tension', 5)).toBe(true);
    expect(boardSupportsMirroring('tension', 99)).toBe(true);
  });
});

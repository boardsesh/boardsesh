import { describe, it, expect } from 'vitest';
import { isMoonboardBoardName, toBoardName } from '../board-name';

describe('toBoardName', () => {
  it('returns the board name for a supported board', () => {
    expect(toBoardName('kilter')).toBe('kilter');
    expect(toBoardName('tension')).toBe('tension');
    expect(toBoardName('moonboard')).toBe('moonboard');
  });

  it('returns null for an empty string', () => {
    expect(toBoardName('')).toBeNull();
  });

  it('returns null for undefined or null', () => {
    expect(toBoardName(undefined)).toBeNull();
    expect(toBoardName(null)).toBeNull();
  });

  it('returns null for an unknown board string', () => {
    expect(toBoardName('not-a-board')).toBeNull();
    expect(toBoardName('Kilter')).toBeNull(); // case-sensitive
  });

  it('returns null for whitespace-padded names', () => {
    expect(toBoardName(' kilter')).toBeNull();
    expect(toBoardName('kilter ')).toBeNull();
    expect(toBoardName(' kilter ')).toBeNull();
  });

  it('returns null for numeric-like strings', () => {
    expect(toBoardName('0')).toBeNull();
    expect(toBoardName('1')).toBeNull();
  });
});

describe('isMoonboardBoardName', () => {
  it('returns true for the canonical MoonBoard board name', () => {
    expect(isMoonboardBoardName('moonboard')).toBe(true);
  });

  it('returns false for a non-MoonBoard board name', () => {
    expect(isMoonboardBoardName('kilter')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isMoonboardBoardName(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isMoonboardBoardName(undefined)).toBe(false);
  });
});

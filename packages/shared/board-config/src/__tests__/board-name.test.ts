import { describe, it, expect } from 'vitest';
import { formatBoardDisplayName, toBoardName } from '../board-name';

describe('toBoardName', () => {
  it('returns the board name for a supported board', () => {
    expect(toBoardName('kilter')).toBe('kilter');
    expect(toBoardName('tension')).toBe('tension');
    expect(toBoardName('moonboard')).toBe('moonboard');
    expect(toBoardName('quantum')).toBe('quantum');
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

describe('formatBoardDisplayName', () => {
  it('uses the Quantum Board product name', () => {
    expect(formatBoardDisplayName('quantum')).toBe('Quantum Board');
  });
});

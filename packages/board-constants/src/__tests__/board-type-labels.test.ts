import { describe, expect, it } from 'vitest';
import { boardTypeLabel } from '../board-type-labels';

describe('boardTypeLabel', () => {
  it('pins the trademark casing (the canonical board-type lookup)', () => {
    expect(boardTypeLabel('kilter')).toBe('Kilter');
    expect(boardTypeLabel('tension')).toBe('Tension');
    expect(boardTypeLabel('moonboard')).toBe('MoonBoard');
    expect(boardTypeLabel('soill')).toBe('So iLL');
    expect(boardTypeLabel('quantum')).toBe('Quantum Board');
  });

  it('falls back to the raw type for unknown boards', () => {
    expect(boardTypeLabel('someNewBoard')).toBe('someNewBoard');
  });
});

import { describe, expect, it } from 'vitest';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { BOARD_TYPE_LABELS, boardTypeLabel } from '../board-type-labels';

describe('boardTypeLabel', () => {
  it('pins the trademark casing (the canonical board-type lookup)', () => {
    expect(boardTypeLabel('kilter')).toBe('Kilter');
    expect(boardTypeLabel('tension')).toBe('Tension');
    expect(boardTypeLabel('moonboard')).toBe('MoonBoard');
    expect(boardTypeLabel('soill')).toBe('So iLL');
  });

  it('falls back to the raw type for unknown boards', () => {
    expect(boardTypeLabel('someNewBoard')).toBe('someNewBoard');
  });
});

describe('BOARD_TYPE_LABELS', () => {
  it('labels exactly the supported boards (the logbook board filter allow-lists these keys)', () => {
    expect(Object.keys(BOARD_TYPE_LABELS).sort()).toEqual([...SUPPORTED_BOARDS].sort());
  });
});

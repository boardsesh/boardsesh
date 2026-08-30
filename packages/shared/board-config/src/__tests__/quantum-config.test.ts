import { describe, expect, it } from 'vitest';
import { SUPPORTED_BOARDS as SCHEMA_SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { ANGLES, BOARD_IMAGE_DIMENSIONS, SUPPORTED_BOARDS, getBoardAngleOptions } from '../board-data';

describe('Quantum rollout metadata', () => {
  it('recognizes the board identity without exposing an unfinished runtime picker', () => {
    expect(SCHEMA_SUPPORTED_BOARDS).toContain('quantum');
    expect(SUPPORTED_BOARDS).not.toContain('quantum');
  });

  it('does not invent board art calibration or supported angles', () => {
    expect(BOARD_IMAGE_DIMENSIONS.quantum).toEqual({});
    expect(ANGLES.quantum).toEqual([]);
    expect(getBoardAngleOptions('quantum', false)).toEqual([]);
    expect(getBoardAngleOptions('quantum', true)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { SUPPORTED_BOARDS as SCHEMA_SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { ANGLES, BOARD_IMAGE_DIMENSIONS, SUPPORTED_BOARDS, getBoardAngleOptions } from '../board-data';
import { getBoardCapabilities } from '../board-capabilities';

describe('fixed Quantum catalogue metadata', () => {
  it('offers the shipped immutable board without runtime hydration', () => {
    expect(SCHEMA_SUPPORTED_BOARDS).toContain('quantum');
    expect(SUPPORTED_BOARDS).toContain('quantum');
    expect(getBoardCapabilities('quantum')).toMatchObject({ catalogSource: 'bundled', angleOptionsSource: 'catalog' });
  });
  it('does not turn source-coordinate bounds into copied art or invented physical angles', () => {
    expect(BOARD_IMAGE_DIMENSIONS.quantum).toEqual({});
    expect(ANGLES.quantum).toEqual([]);
    expect(getBoardAngleOptions('quantum', false)).toEqual([]);
    expect(getBoardAngleOptions('quantum', true)).toEqual([]);
  });
});

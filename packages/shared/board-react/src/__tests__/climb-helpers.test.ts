import { describe, it, expect } from 'vitest';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import { toSaveClimbInput, isDuplicateClimbError, type SaveClimbOptions } from '../climb-helpers';

const options: SaveClimbOptions = {
  layout_id: 8,
  name: 'Test Climb',
  description: 'desc',
  is_draft: true,
  frames: 'p1234r12',
  frames_count: 1,
  frames_pace: 0,
  angle: 40,
};

describe('toSaveClimbInput', () => {
  it('maps snake_case options to the camelCase GraphQL input', () => {
    expect(toSaveClimbInput('kilter', options)).toEqual({
      boardType: 'kilter',
      layoutId: 8,
      sizeId: undefined,
      name: 'Test Climb',
      description: 'desc',
      isDraft: true,
      frames: 'p1234r12',
      framesCount: 1,
      framesPace: 0,
      angle: 40,
      characteristics: null,
      noMatch: undefined,
      anyFeet: undefined,
    });
  });

  it('carries the board size a Woods climb was painted on', () => {
    // Woods numbers each size's holds from its own origin, so the same frames
    // string means different holds on the 8x10 and the 12x12.
    const result = toSaveClimbInput('woods', { ...options, size_id: 2 });
    expect(result.sizeId).toBe(2);
  });

  it('forwards the rule booleans, including an explicit false', () => {
    // `false` and "omitted" are different on the wire: omitted preserves whatever
    // the row already has, false is how a rule gets turned back off.
    const enabled = toSaveClimbInput('woods', { ...options, no_match: true, any_feet: true });
    expect(enabled).toMatchObject({ noMatch: true, anyFeet: true });

    const cleared = toSaveClimbInput('woods', { ...options, no_match: false, any_feet: false });
    expect(cleared).toMatchObject({ noMatch: false, anyFeet: false });
  });

  it('leaves the rule booleans undefined when the caller says nothing about them', () => {
    const result = toSaveClimbInput('kilter', options);
    expect(result.noMatch).toBeUndefined();
    expect(result.anyFeet).toBeUndefined();
  });

  it('defaults a missing description to an empty string', () => {
    const result = toSaveClimbInput('tension', { ...options, description: '' });
    expect(result.description).toBe('');
  });

  it('passes through explicit characteristics', () => {
    const result = toSaveClimbInput('kilter', { ...options, characteristics: ['no_kickboard', 'campus'] });
    expect(result.characteristics).toEqual(['no_kickboard', 'campus']);
  });
});

describe('isDuplicateClimbError', () => {
  it('returns true for a GraphQLOperationError carrying CLIMB_IS_DUPLICATE', () => {
    const err = new GraphQLOperationError([
      { message: 'duplicate', extensions: { code: 'CLIMB_IS_DUPLICATE', existingClimbUuid: 'abc' } },
    ]);
    expect(isDuplicateClimbError(err)).toBe(true);
  });

  it('returns false for a GraphQLOperationError with a different code', () => {
    const err = new GraphQLOperationError([{ message: 'nope', extensions: { code: 'SOMETHING_ELSE' } }]);
    expect(isDuplicateClimbError(err)).toBe(false);
  });

  it('returns false for a plain Error', () => {
    expect(isDuplicateClimbError(new Error('CLIMB_IS_DUPLICATE'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isDuplicateClimbError(null)).toBe(false);
    expect(isDuplicateClimbError('CLIMB_IS_DUPLICATE')).toBe(false);
  });
});

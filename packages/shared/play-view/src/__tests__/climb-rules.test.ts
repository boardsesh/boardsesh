import { describe, it, expect } from 'vitest';
import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';
import { decodeClimbRules } from '../climb-rules';

const { NO_MATCH, CAMPUS, ANY_FEET, NO_KICKBOARD, METHOD_FOOTLESS } = CLIMB_CHARACTERISTICS;

describe('decodeClimbRules', () => {
  it('reads an empty array as the fully-default climb, not as unknown', () => {
    // The distinction the whole Woods rules line rests on: `[]` is a climb whose
    // rules were recorded and are all defaults.
    expect(decodeClimbRules([])).toEqual({ matching: 'allowed', feet: 'marked_holds_only' });
  });

  it.each([[null], [undefined]])('reads %s as unknown on BOTH rules', (characteristics) => {
    // The column is written whole, so an absent array says nothing about either
    // rule. Guessing the defaults would put a rule on screen nobody authored.
    expect(decodeClimbRules(characteristics)).toEqual({ matching: 'unknown', feet: 'unknown' });
  });

  it('reports no matching when the no_match token is present', () => {
    expect(decodeClimbRules([NO_MATCH])).toEqual({ matching: 'not_allowed', feet: 'marked_holds_only' });
  });

  it('reports any feet when the any_feet token is present', () => {
    expect(decodeClimbRules([ANY_FEET])).toEqual({ matching: 'allowed', feet: 'any_feet' });
  });

  it('reports no feet for a campus climb rather than "marked holds only"', () => {
    // Rendering a campus problem as "marked holds only" would describe feet the
    // setter forbade entirely.
    expect(decodeClimbRules([CAMPUS])).toEqual({ matching: 'allowed', feet: 'no_feet' });
  });

  it('decodes both rules together', () => {
    expect(decodeClimbRules([NO_MATCH, ANY_FEET])).toEqual({ matching: 'not_allowed', feet: 'any_feet' });
  });

  it('lets campus win over any_feet on a contradictory row', () => {
    // The editor keeps them exclusive, but a legacy or hand-written row need not
    // be — an ambiguous row may only ever under-promise.
    expect(decodeClimbRules([ANY_FEET, CAMPUS]).feet).toBe('no_feet');
    expect(decodeClimbRules([CAMPUS, ANY_FEET]).feet).toBe('no_feet');
  });

  it('ignores tokens that are not one of the two rules', () => {
    expect(decodeClimbRules([NO_KICKBOARD, METHOD_FOOTLESS])).toEqual({
      matching: 'allowed',
      feet: 'marked_holds_only',
    });
  });
});

// The text half of the colour-vision check.
//
// The rail beside this shows five board renders; a blind climber gets none of
// that, so this line is the whole feature for them and is worth pinning
// properly. Pure numbers, no renderer.
import { describe, expect, it } from 'vitest';
import { BOARD_FIELD_COLORS } from '../board-render-settings';
import { MIN_FIELD_CONTRAST, MIN_ROLE_PAIR_DELTA_E00, evaluateRoleSeparation } from '../cvd-role-verdict';

/** The CVD-safe quad the app ships for protanopia and deuteranopia alike. */
const SAFE_QUAD = { STARTING: '#0072b2', HAND: '#e69f00', FINISH: '#cc79a7', FOOT: '#f0e442' } as const;

describe('the thresholds are the ones every shipped palette is already validated against', () => {
  it('reuses 8 ΔE00 and 3:1, the bars cvd-palette-presets.test.ts asserts', () => {
    expect(MIN_ROLE_PAIR_DELTA_E00).toBe(8);
    expect(MIN_FIELD_CONTRAST).toBe(3);
  });
});

describe('a palette that clears every bar', () => {
  it('calls the CVD-safe quad clear — it passes all three dichromacies, not just its own', () => {
    expect(evaluateRoleSeparation(SAFE_QUAD)).toEqual({ kind: 'clear' });
  });

  it('calls a well-separated grey ramp clear — lightness alone can carry the four roles', () => {
    // Not a shipped palette (the app offers no greyscale one: it drops the very
    // channel these palettes exist to keep apart). It is here because the
    // verdict must not read "colour" as the only way roles can differ — a
    // climber who hand-picks four greys far enough apart has a working set.
    const greyRamp = { STARTING: '#f2f2f2', HAND: '#c0c0c0', FINISH: '#909090', FOOT: '#707070' } as const;
    expect(evaluateRoleSeparation(greyRamp)).toEqual({ kind: 'clear' });
  });

  it('reads a hex with no leading # the same way, like every other override read', () => {
    expect(evaluateRoleSeparation({ STARTING: '0072B2', HAND: 'E69F00', FINISH: 'cc79a7', FOOT: 'F0E442' })).toEqual({
      kind: 'clear',
    });
  });
});

describe('two roles that collapse into one another', () => {
  it('names the vision type and the closest failing pair', () => {
    // HAND and FINISH are a hair apart in hue; deutan flattens them completely.
    const verdict = evaluateRoleSeparation({
      STARTING: '#0072b2',
      HAND: '#e69f00',
      FINISH: '#e6a20a',
      FOOT: '#f0e442',
    });
    expect(verdict.kind).toBe('close');
    if (verdict.kind !== 'close') throw new Error('expected close');
    expect(verdict.vision).toBe('deuteranopia');
    expect(verdict.roles).toEqual(['HAND', 'FINISH']);
    expect(verdict.deltaE00).toBeLessThan(MIN_ROLE_PAIR_DELTA_E00);
  });

  it('catches the shipped Grasshopper-style quad under protanopia', () => {
    // The same failure cvd-palette-presets.test.ts pins as the reason the
    // colour-vision palettes exist at all.
    const verdict = evaluateRoleSeparation({
      STARTING: '#00FF00',
      HAND: '#4455FF',
      FINISH: '#FF00FF',
      FOOT: '#00FFFF',
    });
    expect(verdict.kind).toBe('close');
    if (verdict.kind !== 'close') throw new Error('expected close');
    expect(verdict.vision).toBe('protanopia');
    expect(verdict.roles).toEqual(['HAND', 'FINISH']);
    expect(verdict.deltaE00).toBeCloseTo(3.8, 1);
  });

  it('reports the WORST pair across all three vision types, not the first one found', () => {
    // Two separate failures: a mild tritan one and a severe deutan one. The
    // severe one is what a climber needs to hear about.
    const verdict = evaluateRoleSeparation({
      STARTING: '#0e9e77',
      HAND: '#e69f00',
      FINISH: '#e6a20a',
      FOOT: '#9acd32',
    });
    expect(verdict.kind).toBe('close');
    if (verdict.kind !== 'close') throw new Error('expected close');
    expect(verdict.roles).toEqual(['HAND', 'FINISH']);
  });
});

describe('a role that washes into the board', () => {
  it('reports the faintest role once every pair is distinct', () => {
    const verdict = evaluateRoleSeparation({
      STARTING: '#f2f2f2',
      HAND: '#c0c0c0',
      FINISH: '#909090',
      FOOT: '#4a4460',
    });
    expect(verdict.kind).toBe('faint');
    if (verdict.kind !== 'faint') throw new Error('expected faint');
    expect(verdict.role).toBe('FOOT');
    expect(verdict.contrastRatio).toBeLessThan(MIN_FIELD_CONTRAST);
  });

  it('is outranked by a pair collapse — two roles nobody can tell apart is the headline', () => {
    const verdict = evaluateRoleSeparation({
      STARTING: '#e69f00',
      HAND: '#e6a20a',
      FINISH: '#909090',
      FOOT: '#4a4460',
    });
    expect(verdict.kind).toBe('close');
  });

  it('measures against the dark play field by default, the one the presets are validated on', () => {
    const roles = { STARTING: '#f2f2f2', HAND: '#c0c0c0', FINISH: '#909090', FOOT: '#4a4460' } as const;
    expect(evaluateRoleSeparation(roles)).toEqual(evaluateRoleSeparation(roles, BOARD_FIELD_COLORS.dark));
  });
});

describe('a colour the oracle cannot read', () => {
  it('says nothing rather than guessing, for a malformed override', () => {
    expect(evaluateRoleSeparation({ STARTING: '#fff', HAND: '#c0c0c0', FINISH: '#909090', FOOT: '#707070' })).toEqual({
      kind: 'unknown',
    });
  });

  it('says nothing when a role has no colour at all', () => {
    expect(evaluateRoleSeparation({ STARTING: '#f2f2f2', HAND: '#c0c0c0', FINISH: '#909090' })).toEqual({
      kind: 'unknown',
    });
  });

  it('says nothing for an unreadable field colour', () => {
    expect(evaluateRoleSeparation(SAFE_QUAD, 'rebeccapurple')).toEqual({ kind: 'unknown' });
  });
});

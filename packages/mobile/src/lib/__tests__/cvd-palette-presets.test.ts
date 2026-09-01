import { describe, expect, it, vi } from 'vitest';
import { BOARD_FIELD_COLORS } from '../board-render-settings';
import { contrastRatioHex, deltaEHex, type CvdTransformKey } from '../color-contrast-oracle';
import {
  CVD_PALETTE_PRESETS,
  applyCvdPalette,
  matchingCvdPaletteId,
  type CvdPaletteId,
  type CvdPaletteRoleColors,
} from '../cvd-palette-presets';
import { HOLD_COLOR_OVERRIDE_ROLES, type HoldColorOverrideRole } from '../hold-color-overrides';

const FIELD = BOARD_FIELD_COLORS.dark;
const MIN_FIELD_CONTRAST = 3;
const MIN_ROLE_PAIR_DELTA_E00 = 8;

/** The CVD matrix each palette is validated against. */
const PALETTE_TRANSFORM: Record<CvdPaletteId, CvdTransformKey> = {
  protanopia: 'machado.protan',
  deuteranopia: 'machado.deutan',
  tritanopia: 'machado.tritan',
};

function rolePairs(): [HoldColorOverrideRole, HoldColorOverrideRole][] {
  const pairs: [HoldColorOverrideRole, HoldColorOverrideRole][] = [];
  for (let a = 0; a < HOLD_COLOR_OVERRIDE_ROLES.length; a += 1) {
    for (let b = a + 1; b < HOLD_COLOR_OVERRIDE_ROLES.length; b += 1) {
      pairs.push([HOLD_COLOR_OVERRIDE_ROLES[a], HOLD_COLOR_OVERRIDE_ROLES[b]]);
    }
  }
  return pairs;
}

function worstPairDeltaE(roles: CvdPaletteRoleColors, transform: CvdTransformKey | null) {
  let worst: { pair: string; dE00: number } | null = null;
  for (const [roleA, roleB] of rolePairs()) {
    const dE00 = deltaEHex(roles[roleA], roles[roleB], transform);
    if (worst === null || dE00 < worst.dE00) worst = { pair: `${roleA}/${roleB}`, dE00 };
  }
  if (!worst) throw new Error('no role pairs');
  return worst;
}

describe('CVD_PALETTE_PRESETS validation (every palette must clear both bars)', () => {
  for (const preset of CVD_PALETTE_PRESETS) {
    const transform = PALETTE_TRANSFORM[preset.id];

    it(`${preset.id}: every role clears ${MIN_FIELD_CONTRAST}:1 WCAG against the play field`, () => {
      for (const role of HOLD_COLOR_OVERRIDE_ROLES) {
        expect(contrastRatioHex(preset.roles[role], FIELD)).toBeGreaterThanOrEqual(MIN_FIELD_CONTRAST);
      }
    });

    it(`${preset.id}: every role pair clears ${MIN_ROLE_PAIR_DELTA_E00} ΔE00 apart under its CVD check`, () => {
      const worst = worstPairDeltaE(preset.roles, transform);
      expect(worst.dE00).toBeGreaterThanOrEqual(MIN_ROLE_PAIR_DELTA_E00);
    });
  }
});

// Pinned so a future hex tweak shows up as a diff here, not just a passing
// >=3 / >=8 inequality that could drift arbitrarily close to the line.
describe('CVD_PALETTE_PRESETS pinned numbers (a regression here is visible, not silent)', () => {
  it('protanopia (machado.protan)', () => {
    const preset = CVD_PALETTE_PRESETS.find((entry) => entry.id === 'protanopia')!;
    expect(preset.roles).toEqual({ STARTING: '#0072b2', HAND: '#e69f00', FINISH: '#cc79a7', FOOT: '#f0e442' });
    const contrasts = Object.fromEntries(
      HOLD_COLOR_OVERRIDE_ROLES.map((role) => [role, Number(contrastRatioHex(preset.roles[role], FIELD).toFixed(2))]),
    );
    expect(contrasts).toEqual({ STARTING: 3.52, HAND: 8.09, FINISH: 5.95, FOOT: 13.78 });
    expect(worstPairDeltaE(preset.roles, 'machado.protan').pair).toBe('STARTING/FINISH');
    expect(worstPairDeltaE(preset.roles, 'machado.protan').dE00).toBeCloseTo(12.2, 1);
  });

  it('deuteranopia (machado.deutan) — same quad as protanopia, so nobody has to choose', () => {
    const protan = CVD_PALETTE_PRESETS.find((entry) => entry.id === 'protanopia')!;
    const deutan = CVD_PALETTE_PRESETS.find((entry) => entry.id === 'deuteranopia')!;
    expect(deutan.roles).toEqual(protan.roles);
    expect(worstPairDeltaE(deutan.roles, 'machado.deutan').pair).toBe('HAND/FOOT');
    expect(worstPairDeltaE(deutan.roles, 'machado.deutan').dE00).toBeCloseTo(11.6, 1);
  });

  it('tritanopia (machado.tritan)', () => {
    const preset = CVD_PALETTE_PRESETS.find((entry) => entry.id === 'tritanopia')!;
    expect(preset.roles).toEqual({ STARTING: '#0e9e77', HAND: '#d95f02', FINISH: '#ca2270', FOOT: '#9acd32' });
    const contrasts = Object.fromEntries(
      HOLD_COLOR_OVERRIDE_ROLES.map((role) => [role, Number(contrastRatioHex(preset.roles[role], FIELD).toFixed(2))]),
    );
    expect(contrasts).toEqual({ STARTING: 5.36, HAND: 4.85, FINISH: 3.45, FOOT: 9.68 });
    expect(worstPairDeltaE(preset.roles, 'machado.tritan').pair).toBe('HAND/FINISH');
    expect(worstPairDeltaE(preset.roles, 'machado.tritan').dE00).toBeCloseTo(9.1, 1);
  });
});

describe('the reason these presets exist: the shipped default palette does not clear the bar', () => {
  it('Grasshopper HAND/FOOT fails the 8 ΔE00 protan check the presets above pass', () => {
    // Same literal hexes color-contrast-oracle.test.ts pins against the #2202
    // spike's published figure (3.8) for Grasshopper's shipped display colours.
    const grasshopperHand = '#4455FF';
    const grasshopperFoot = '#FF00FF';
    const dE00 = deltaEHex(grasshopperHand, grasshopperFoot, 'machado.protan');
    expect(dE00).toBeCloseTo(3.8, 1);
    expect(dE00).toBeLessThan(MIN_ROLE_PAIR_DELTA_E00);
  });
});

describe('applyCvdPalette', () => {
  it('writes all four role overrides verbatim, and writes nothing else', () => {
    // Colours only: role glyphs are their own switch on the same screen, and a
    // palette that flipped it would answer a question the climber did not ask.
    const setRoleOverride = vi.fn();
    applyCvdPalette('protanopia', { setRoleOverride });

    const preset = CVD_PALETTE_PRESETS.find((entry) => entry.id === 'protanopia')!;
    for (const role of HOLD_COLOR_OVERRIDE_ROLES) {
      expect(setRoleOverride).toHaveBeenCalledWith(role, preset.roles[role]);
    }
    expect(setRoleOverride).toHaveBeenCalledTimes(HOLD_COLOR_OVERRIDE_ROLES.length);
  });

  it('is a no-op for an unknown id', () => {
    const setRoleOverride = vi.fn();
    applyCvdPalette('not-a-palette' as CvdPaletteId, { setRoleOverride });
    expect(setRoleOverride).not.toHaveBeenCalled();
  });
});

describe('matchingCvdPaletteId', () => {
  it('matches when all four overrides equal one preset exactly', () => {
    const preset = CVD_PALETTE_PRESETS.find((entry) => entry.id === 'tritanopia')!;
    expect(matchingCvdPaletteId(preset.roles)).toBe('tritanopia');
  });

  it('matches case-insensitively and with or without a leading #, like every other override read', () => {
    expect(matchingCvdPaletteId({ STARTING: '0072B2', HAND: '#E69F00', FINISH: 'CC79A7', FOOT: '#f0e442' })).toBe(
      'protanopia',
    );
  });

  it('is custom when only some roles match a preset', () => {
    const preset = CVD_PALETTE_PRESETS.find((entry) => entry.id === 'tritanopia')!;
    expect(matchingCvdPaletteId({ STARTING: preset.roles.STARTING, HAND: preset.roles.HAND })).toBe('custom');
  });

  it('is custom when no role is overridden at all', () => {
    expect(matchingCvdPaletteId({})).toBe('custom');
  });

  it('is custom for a hex that matches no preset', () => {
    expect(matchingCvdPaletteId({ STARTING: '#123456', HAND: '#654321', FINISH: '#abcdef', FOOT: '#fedcba' })).toBe(
      'custom',
    );
  });
});

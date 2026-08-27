import { describe, expect, it } from 'vitest';
import { contrastRatioHex, deltaEHex, oklch, parseHex } from '../color-contrast-oracle';

/**
 * Pins this port against the numbers the #2202 spike's oracle
 * (`packages/mobile/scripts/spike/role-contrast.mjs` on
 * `spike/board-rendering-dark-2202`, `selftest` subcommand) published, using the
 * same literal hexes that oracle's `buildChecks()` computed from — so this file
 * needs no board-catalogue dependency to stay honest.
 *
 * The oracle's own tolerances: WCAG/ΔE00 figures were published to 2/1 decimals
 * respectively, so a `toBeCloseTo` at that precision reproduces "PASS(near)" as
 * well as "PASS(exact)". Two ΔE00 "tritan (simple matrix)" checks in the spike
 * are marked UNREPRODUCED by every tritan matrix it tried and are deliberately
 * not ported here — see that file's header for the full story.
 */

const FIELD = '#181225';
const GREY = '#3A3A3C';
const WOOD = '#6B4F33';
const LIGHT = '#FFFFFF';

describe('color-contrast-oracle WCAG contrast (vs spike selftest)', () => {
  it.each([
    ['grasshopper HAND #4455FF vs field', '#4455FF', FIELD, 3.46],
    ['tension HAND #4444FF vs field', '#4444FF', FIELD, 3.05],
    ['grasshopper STARTING #00DD00 vs field', '#00DD00', FIELD, 9.85],
    ['grasshopper FINISH #FF0000 vs field', '#FF0000', FIELD, 4.56],
    ['grasshopper FOOT #FF00FF vs field', '#FF00FF', FIELD, 5.81],
    ['kilter HAND #00FFFF vs field', '#00FFFF', FIELD, 14.54],
    ['kilter STARTING #00FF00 vs field', '#00FF00', FIELD, 13.28],
    ['kilter FINISH #FF00FF vs field', '#FF00FF', FIELD, 5.81],
    ['kilter FOOT #FFAA00 vs field', '#FFAA00', FIELD, 9.55],
    ['moonboard STARTING #44FF44 vs field', '#44FF44', FIELD, 13.57],
    ['moonboard FINISH #FF3333 vs field', '#FF3333', FIELD, 5.01],
    ['grasshopper HAND vs grey', '#4455FF', GREY, 2.16],
    ['grasshopper HAND vs plywood', '#4455FF', WOOD, 1.43],
    ['moonboard HAND #4444FF vs grey', '#4444FF', GREY, 1.9],
    ['moonboard HAND #4444FF vs plywood', '#4444FF', WOOD, 1.26],
    ['kilter HAND vs white', '#00FFFF', LIGHT, 1.25],
    ['grasshopper HAND vs white', '#4455FF', LIGHT, 5.26],
  ])('%s -> %f', (_name, hex, field, published) => {
    expect(contrastRatioHex(hex, field)).toBeCloseTo(published, 2);
  });
});

describe('color-contrast-oracle OkLab L (vs spike selftest, README "What the measurements said")', () => {
  it.each([
    ['grasshopper HAND #4455FF', '#4455FF', 0.551],
    ['grasshopper STARTING #00DD00', '#00DD00', 0.778],
    ['play field #181225', '#181225', 0.2],
  ])('%s -> L %f', (_name, hex, published) => {
    expect(oklch(parseHex(hex)).L).toBeCloseTo(published, 3);
  });
});

describe('color-contrast-oracle CVD ΔE00 (vs spike selftest)', () => {
  it.each([
    ['grasshopper HAND/FOOT Viénot protan', '#4455FF', '#FF00FF', 'vienot.protan' as const, 3.2],
    ['grasshopper HAND/FOOT Machado protan', '#4455FF', '#FF00FF', 'machado.protan' as const, 3.8],
    ['grasshopper HAND/FOOT Viénot deutan', '#4455FF', '#FF00FF', 'vienot.deutan' as const, 20.6],
    ['tension HAND/FOOT Viénot deutan', '#4444FF', '#FF00FF', 'vienot.deutan' as const, 24.3],
    ['grasshopper STARTING/FINISH Viénot deutan', '#00DD00', '#FF0000', 'vienot.deutan' as const, 12.6],
    ['kilter STARTING/FOOT Viénot deutan', '#00FF00', '#FFAA00', 'vienot.deutan' as const, 4.6],
    ['kilter STARTING/FOOT Viénot protan', '#00FF00', '#FFAA00', 'vienot.protan' as const, 14.6],
    ['kilter HAND/FOOT Viénot protan', '#00FFFF', '#FFAA00', 'vienot.protan' as const, 39.6],
    ['kilter HAND/FOOT Viénot deutan', '#00FFFF', '#FFAA00', 'vienot.deutan' as const, 48.9],
    ['kilter STARTING/HAND Viénot protan', '#00FF00', '#00FFFF', 'vienot.protan' as const, 38.7],
    ['kilter STARTING/HAND Viénot deutan', '#00FF00', '#00FFFF', 'vienot.deutan' as const, 48.5],
    ['equalL HAND/FOOT Viénot protan', '#7B96FF', '#FE00FE', 'vienot.protan' as const, 16.5],
    ['equalL HAND/FOOT Viénot deutan', '#7B96FF', '#FE00FE', 'vienot.deutan' as const, 1.3],
    ['equalL STARTING/FINISH Viénot deutan', '#00C000', '#FF6553', 'vienot.deutan' as const, 4.7],
  ])('%s -> %f', (_name, hexA, hexB, transform, published) => {
    // The spike's tolerance for ΔE00 was +/-0.4 (unrounded-linear-pipeline slack);
    // toBeCloseTo(published, 0) matches to the nearest whole unit, tighter than
    // that everywhere these checks land.
    expect(deltaEHex(hexA, hexB, transform)).toBeCloseTo(published, 0);
  });
});

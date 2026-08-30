import { describe, it, expect } from 'vitest';
import { BOARD_TYPES, LAYOUT_ORDER, getLayoutDisplayName, sortLayoutKeys } from '../layouts';

describe('getLayoutDisplayName', () => {
  it('names the Woods layout from the override, not from the Aurora tables', () => {
    // Woods is code-driven: `getLayout('woods', 1)` reads the generated layout
    // tables, which carry no Woods rows, so without the override every Woods
    // series on the profile charts would read "Woods (Layout 1)".
    expect(getLayoutDisplayName('woods', 1)).toBe('Woods Board');
  });

  it('still falls back for a layout no board knows about', () => {
    expect(getLayoutDisplayName('woods', 99)).toBe('Woods (Layout 99)');
  });

  it('keeps the Aurora and MoonBoard names it already had', () => {
    expect(getLayoutDisplayName('kilter', 1)).toBe('Kilter Original');
    expect(getLayoutDisplayName('moonboard', 2)).toBe('MoonBoard 2016');
  });

  it('names every code-driven Quantum Board model', () => {
    expect(getLayoutDisplayName('quantum', 9101)).toBe('Quantum Board XL');
    expect(getLayoutDisplayName('quantum', 9105)).toBe('Quantum Board Belay Board');
  });
});

describe('LAYOUT_ORDER', () => {
  it('places Woods after the MoonBoard layouts rather than alphabetically', () => {
    expect(LAYOUT_ORDER).toContain('woods-1');
    expect(LAYOUT_ORDER.indexOf('woods-1')).toBeGreaterThan(LAYOUT_ORDER.indexOf('moonboard-5'));
    expect(sortLayoutKeys(['woods-1', 'kilter-1', 'moonboard-1'])).toEqual(['kilter-1', 'moonboard-1', 'woods-1']);
  });

  it('sorts an unordered key after every ordered one', () => {
    expect(sortLayoutKeys(['decoy-2', 'woods-1'])).toEqual(['woods-1', 'decoy-2']);
  });

  it('includes Quantum Board after other code-driven board layouts', () => {
    expect(BOARD_TYPES).toContain('quantum');
    expect(LAYOUT_ORDER.indexOf('quantum-9101')).toBeGreaterThan(LAYOUT_ORDER.indexOf('woods-1'));
    expect(sortLayoutKeys(['quantum-9105', 'woods-1', 'quantum-9101'])).toEqual([
      'woods-1',
      'quantum-9101',
      'quantum-9105',
    ]);
  });
});

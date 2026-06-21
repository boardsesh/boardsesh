import { describe, it, expect } from 'vitest';
import { shiftLightness, buildHeroGradient } from '../playlist-gradient';
import { PLAYLIST_COLORS } from '../playlist-colors';

const HEX = /^#[0-9a-f]{6}$/i;

function channelSum(hex: string): number {
  const raw = hex.replace('#', '');
  return parseInt(raw.slice(0, 2), 16) + parseInt(raw.slice(2, 4), 16) + parseInt(raw.slice(4, 6), 16);
}

describe('shiftLightness', () => {
  it('returns a valid 6-digit hex', () => {
    expect(shiftLightness('#6D28D9', 14)).toMatch(HEX);
    expect(shiftLightness('#6D28D9', -20)).toMatch(HEX);
  });

  it('lifts toward white for a positive delta and deepens for a negative one', () => {
    const base = '#6D28D9';
    expect(channelSum(shiftLightness(base, 14))).toBeGreaterThan(channelSum(base));
    expect(channelSum(shiftLightness(base, -20))).toBeLessThan(channelSum(base));
  });

  it('clamps lightness at the extremes', () => {
    expect(shiftLightness('#ffffff', 30)).toBe('#ffffff');
    expect(shiftLightness('#000000', -30)).toBe('#000000');
  });

  it('expands 3-digit hex before shifting', () => {
    expect(shiftLightness('#fff', 0)).toBe('#ffffff');
  });

  it('returns non-hex input unchanged', () => {
    expect(shiftLightness('rebeccapurple', 14)).toBe('rebeccapurple');
    expect(shiftLightness('rgba(0,0,0,0.5)', -20)).toBe('rgba(0,0,0,0.5)');
  });
});

describe('buildHeroGradient', () => {
  it('builds a 3-stop gradient with the true colour in the middle', () => {
    const gradient = buildHeroGradient('#6D28D9');
    expect(gradient.colors).toHaveLength(3);
    expect(gradient.colors[1]).toBe('#6D28D9');
    expect(gradient.locations).toEqual([0, 0.55, 1]);
  });

  it('falls back to the brand violet for missing or invalid colours', () => {
    expect(buildHeroGradient(undefined).colors[1]).toBe(PLAYLIST_COLORS[0]);
    expect(buildHeroGradient('not-a-colour').colors[1]).toBe(PLAYLIST_COLORS[0]);
  });
});

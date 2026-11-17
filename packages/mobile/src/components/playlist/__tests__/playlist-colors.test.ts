import { describe, expect, it } from 'vitest';
import { brandColors } from '@boardsesh/velvet-tokens';

import { PLAYLIST_COLORS, normalizePlaylistColor } from '../playlist-colors';

describe('normalizePlaylistColor', () => {
  it('reads a playlist saved from the old violet swatch as today’s brand violet', () => {
    expect(normalizePlaylistColor('#6D28D9')).toBe(brandColors.primaryFill);
    // Any spelling the shared normaliser accepts: lowercase, no hash.
    expect(normalizePlaylistColor('#6d28d9')).toBe(brandColors.primaryFill);
    expect(normalizePlaylistColor('6D28D9')).toBe(brandColors.primaryFill);
  });

  it('keeps old brand violets the app never offered as a swatch: a climber may have picked them', () => {
    for (const picked of ['#7C3AED', '#5B21B6', '#A78BFA']) {
      expect(normalizePlaylistColor(picked), picked).toBe(picked);
    }
  });

  it('reads a playlist saved from the old amber spark swatch as today’s spark', () => {
    expect(normalizePlaylistColor('#FF8A3D')).toBe(brandColors.accent);
  });

  it('matches the current swatches, so the form shows the old pick as picked', () => {
    expect(PLAYLIST_COLORS).toContain(normalizePlaylistColor('#6D28D9'));
    expect(PLAYLIST_COLORS).toContain(normalizePlaylistColor('#FF8A3D'));
  });

  it('keeps every other colour, canonicalised, and still rejects a non-colour', () => {
    expect(normalizePlaylistColor('#2563eb')).toBe('#2563EB');
    expect(normalizePlaylistColor(brandColors.primaryFill)).toBe(brandColors.primaryFill);
    expect(normalizePlaylistColor('not-a-colour')).toBeNull();
    expect(normalizePlaylistColor(null)).toBeNull();
    expect(normalizePlaylistColor(undefined)).toBeNull();
  });
});

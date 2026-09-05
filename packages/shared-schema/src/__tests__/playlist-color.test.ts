// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vite-plus/test';
import { isValidPlaylistColor, normalizePlaylistColor } from '../utils';

describe('isValidPlaylistColor', () => {
  it('accepts only non-empty six-digit hex colours', () => {
    expect(isValidPlaylistColor('#A1b2C3')).toBe(true);
    expect(isValidPlaylistColor('#abc')).toBe(false);
    expect(isValidPlaylistColor('A1b2C3')).toBe(false);
    expect(isValidPlaylistColor('#A1b2C3ff')).toBe(false);
    expect(isValidPlaylistColor('')).toBe(false);
  });
});

describe('normalizePlaylistColor', () => {
  it('expands legacy shorthand and accepts upstream colours without a hash', () => {
    expect(normalizePlaylistColor('#aB3')).toBe('#AABB33');
    expect(normalizePlaylistColor('aB3')).toBe('#AABB33');
  });

  it('canonicalizes six-digit colours', () => {
    expect(normalizePlaylistColor('#A1b2C3')).toBe('#A1B2C3');
    expect(normalizePlaylistColor('A1b2C3')).toBe('#A1B2C3');
  });

  it('returns null for missing or invalid colours', () => {
    expect(normalizePlaylistColor(undefined)).toBeNull();
    expect(normalizePlaylistColor(null)).toBeNull();
    expect(normalizePlaylistColor('')).toBeNull();
    expect(normalizePlaylistColor('#abcd')).toBeNull();
    expect(normalizePlaylistColor('#A1b2C3ff')).toBeNull();
    expect(normalizePlaylistColor('not-a-colour')).toBeNull();
  });
});

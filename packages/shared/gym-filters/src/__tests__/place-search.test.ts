import { describe, expect, it } from 'vitest';
import type { PlaceSuggestion } from '@boardsesh/shared-schema';
import { isPlaceSearchQuery, placeSuggestionLabel } from '../place-search';

describe('place search shared by the directory and browser app', () => {
  it('matches the public API query bounds after trimming', () => {
    expect(isPlaceSearchQuery('  Atlanta  ')).toBe(true);
    expect(isPlaceSearchQuery(' ab ')).toBe(false);
    expect(isPlaceSearchQuery('a'.repeat(80))).toBe(true);
    expect(isPlaceSearchQuery('a'.repeat(81))).toBe(false);
    expect(isPlaceSearchQuery('   ')).toBe(false);
  });

  it('distinguishes cities by region and country without repeating identical names', () => {
    expect(
      placeSuggestionLabel({ name: 'Atlanta', region: 'Georgia', country: 'United States' } as PlaceSuggestion),
    ).toBe('Atlanta, Georgia, United States');
    expect(placeSuggestionLabel({ name: 'Singapore', region: '', country: 'Singapore' } as PlaceSuggestion)).toBe(
      'Singapore',
    );
  });
});

import { describe, it, expect } from 'vite-plus/test';
import { gymIsIndexableVenue, type IndexableVenueCandidate } from '../gym-index-eligibility';

function candidate(overrides: Partial<IndexableVenueCandidate> = {}): IndexableVenueCandidate {
  return { isPublic: true, latitude: 48.1351, longitude: 11.582, ...overrides };
}

describe('gymIsIndexableVenue', () => {
  it('accepts a public gym with a pin', () => {
    expect(gymIsIndexableVenue(candidate())).toBe(true);
  });

  it('rejects a public gym with no pin', () => {
    expect(gymIsIndexableVenue(candidate({ latitude: null, longitude: null }))).toBe(false);
  });

  it('rejects a gym missing either half of the pair', () => {
    expect(gymIsIndexableVenue(candidate({ longitude: null }))).toBe(false);
    expect(gymIsIndexableVenue(candidate({ latitude: null }))).toBe(false);
  });

  it('rejects a gym that never had the fields at all', () => {
    expect(gymIsIndexableVenue({ isPublic: true })).toBe(false);
  });

  it('rejects a private gym even with a pin', () => {
    expect(gymIsIndexableVenue(candidate({ isPublic: false }))).toBe(false);
  });

  // Zero is a real coordinate on both axes, and this predicate counts presence —
  // the same thing the 4,468 / 2,848 / 1,620 production measurement counted.
  // A Null Island row is a broken geocode on a real venue, not a home wall.
  it('treats zero as a coordinate, not as absent', () => {
    expect(gymIsIndexableVenue(candidate({ latitude: 0, longitude: 0 }))).toBe(true);
  });

  it('rejects a non-finite coordinate', () => {
    expect(gymIsIndexableVenue(candidate({ latitude: Number.NaN }))).toBe(false);
    expect(gymIsIndexableVenue(candidate({ latitude: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(gymIsIndexableVenue(candidate({ longitude: Number.NEGATIVE_INFINITY }))).toBe(false);
  });
});

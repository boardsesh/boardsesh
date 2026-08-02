import { describe, it, expect } from 'vitest';
import {
  isSameBoardLocation,
  findBlockingDuplicate,
  DUPLICATE_BOARD_RADIUS_METERS,
} from '../graphql/resolvers/social/board-duplicates';

// Pure — no DB. The rule under test is "same config AND same place", which is
// what lets a climber own the same board configuration at two different gyms
// (#4166) while a genuine double-submit is still caught.

const NOWHERE = { latitude: null, longitude: null, locationName: null };

// ~111 m north of the first point (1 degree of latitude ≈ 111.32 km).
const GYM_A = { latitude: 52.37, longitude: 4.89, locationName: 'Klimmuur' };
const GYM_A_NEARBY = { latitude: 52.371, longitude: 4.89, locationName: 'Klimmuur' };
// Roughly 2 km away — a different building.
const GYM_B = { latitude: 52.388, longitude: 4.89, locationName: 'Boulder Space' };

describe('isSameBoardLocation', () => {
  describe('when both sides have coordinates', () => {
    it('treats boards within the radius as the same place', () => {
      expect(isSameBoardLocation(GYM_A, GYM_A_NEARBY)).toBe(true);
    });

    it('treats boards beyond the radius as different places', () => {
      expect(isSameBoardLocation(GYM_A, GYM_B)).toBe(false);
    });

    it('ignores the location name when coordinates are available', () => {
      // Same spot, different label — still one place. The reverse (same label,
      // far apart) is covered by the GYM_A/GYM_B case above.
      expect(isSameBoardLocation(GYM_A, { ...GYM_A_NEARBY, locationName: 'Something else' })).toBe(true);
    });

    it('uses a radius the resolver and gym matching agree on', () => {
      expect(DUPLICATE_BOARD_RADIUS_METERS).toBe(150);
    });
  });

  describe('when only names are available', () => {
    it('matches the same name case- and whitespace-insensitively', () => {
      expect(
        isSameBoardLocation(
          { latitude: null, longitude: null, locationName: 'Boulder Space' },
          { latitude: null, longitude: null, locationName: '  boulder space  ' },
        ),
      ).toBe(true);
    });

    it('treats different names as different places', () => {
      expect(
        isSameBoardLocation(
          { latitude: null, longitude: null, locationName: 'Boulder Space' },
          { latitude: null, longitude: null, locationName: 'Klimmuur' },
        ),
      ).toBe(false);
    });

    it('treats a blank name as no name at all', () => {
      // Both sides are effectively placeless, so they fall through to the
      // placeless tier and count as the same place.
      expect(
        isSameBoardLocation(
          { latitude: null, longitude: null, locationName: '   ' },
          { latitude: null, longitude: null, locationName: '' },
        ),
      ).toBe(true);
    });

    it('treats a blank name against a real one as different', () => {
      expect(
        isSameBoardLocation(
          { latitude: null, longitude: null, locationName: '   ' },
          { latitude: null, longitude: null, locationName: 'Klimmuur' },
        ),
      ).toBe(false);
    });
  });

  it('treats two placeless boards as the same place', () => {
    // Nothing distinguishes them, and this is the shape a double-submit takes.
    expect(isSameBoardLocation(NOWHERE, NOWHERE)).toBe(true);
  });

  it('treats a placed board and a placeless one as different', () => {
    // The permissive reading: never silently block a board that says where it is
    // against one that doesn't.
    expect(isSameBoardLocation(GYM_A, NOWHERE)).toBe(false);
    expect(isSameBoardLocation(NOWHERE, GYM_A)).toBe(false);
  });

  it('treats coordinates-only against name-only as different', () => {
    expect(
      isSameBoardLocation(
        { latitude: 52.37, longitude: 4.89, locationName: null },
        { latitude: null, longitude: null, locationName: 'Klimmuur' },
      ),
    ).toBe(false);
  });
});

describe('findBlockingDuplicate', () => {
  it('matches set ids regardless of stored order', () => {
    // The stored order is whatever the board was created with; the client sends
    // a canonical order. A raw SQL string compare called these different, which
    // let a near-duplicate through the guard.
    const candidates = [{ ...GYM_A, setIds: '25,26,27,24' }];
    expect(findBlockingDuplicate(candidates, { ...GYM_A, setIds: '24,25,26,27' })).toBe(candidates[0]);
  });

  it('tolerates whitespace and repeats in set ids', () => {
    const candidates = [{ ...GYM_A, setIds: ' 26, 24 ,25,24 ' }];
    expect(findBlockingDuplicate(candidates, { ...GYM_A, setIds: '24,25,26' })).toBe(candidates[0]);
  });

  it('does not block a different set of holds at the same place', () => {
    const candidates = [{ ...GYM_A, setIds: '24,25' }];
    expect(findBlockingDuplicate(candidates, { ...GYM_A, setIds: '24,25,26' })).toBeUndefined();
  });

  it('does not block the same config at a different place', () => {
    // The reported bug: a second MoonBoard 2024 at a new gym.
    const candidates = [{ ...GYM_A, setIds: '24,25,26' }];
    expect(findBlockingDuplicate(candidates, { ...GYM_B, setIds: '24,25,26' })).toBeUndefined();
  });

  it('picks the matching candidate out of several', () => {
    const candidates = [
      { ...GYM_B, setIds: '24,25,26' },
      { ...GYM_A, setIds: '24,25,26' },
    ];
    expect(findBlockingDuplicate(candidates, { ...GYM_A, setIds: '24,25,26' })).toBe(candidates[1]);
  });

  it('returns undefined when the owner has no boards of this config', () => {
    expect(findBlockingDuplicate([], { ...GYM_A, setIds: '24,25,26' })).toBeUndefined();
  });
});

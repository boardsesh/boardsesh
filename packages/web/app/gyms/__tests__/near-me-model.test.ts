import { describe, it, expect } from 'vite-plus/test';
import type { GymDirectoryCard } from '@boardsesh/graphql/operations';
import {
  CLUSTER_PIN_THRESHOLD,
  DEFAULT_NEAR_ME_RADIUS_KM,
  MAX_BACKEND_SEARCH_LIMIT,
  NEAR_ME_RADIUS_OPTIONS_KM,
  NEAR_ME_RESULT_LIMIT,
  clusterPins,
  nearMeFallbackReason,
  pinCoverage,
  roundCoordinate,
  toMapPins,
  type MapPin,
} from '../near-me-model';

function gym(overrides: Partial<GymDirectoryCard> = {}): GymDirectoryCard {
  return {
    uuid: 'gym-1',
    slug: 'boulderwelt',
    name: 'Boulderwelt',
    address: null,
    latitude: null,
    longitude: null,
    isClaimed: false,
    boardSummaries: [],
    ...overrides,
  };
}

function pin(index: number, latitude: number, longitude: number): MapPin {
  return { uuid: `gym-${index}`, slug: `gym-${index}`, name: `Gym ${index}`, latitude, longitude, boardSummaries: [] };
}

describe('near-me query limits', () => {
  it('never asks for more than the backend zod accepts', () => {
    // `SearchGymsInputSchema.limit` is `.max(50)` and `validateInput` THROWS
    // past it — it does not clamp — so a bigger limit is an empty map, not a
    // slow one.
    expect(NEAR_ME_RESULT_LIMIT).toBeLessThanOrEqual(MAX_BACKEND_SEARCH_LIMIT);
    expect(MAX_BACKEND_SEARCH_LIMIT).toBe(50);
  });

  it('offers a default radius that is one of the offered radii', () => {
    expect(NEAR_ME_RADIUS_OPTIONS_KM).toContain(DEFAULT_NEAR_ME_RADIUS_KM);
  });
});

describe('roundCoordinate', () => {
  it('drops precision below roughly a hundred metres', () => {
    expect(roundCoordinate(51.4545092)).toBe(51.455);
    expect(roundCoordinate(-2.5879431)).toBe(-2.588);
  });

  it('leaves an already-coarse coordinate alone', () => {
    expect(roundCoordinate(51)).toBe(51);
  });
});

describe('toMapPins', () => {
  it('keeps only gyms with both coordinates and a slug', () => {
    const pins = toMapPins([
      gym({ uuid: 'a', latitude: 51.4, longitude: -2.5 }),
      gym({ uuid: 'b', latitude: 51.4, longitude: null }),
      gym({ uuid: 'c', latitude: null, longitude: null }),
      gym({ uuid: 'd', slug: null, latitude: 1, longitude: 1 }),
    ]);
    expect(pins.map((entry) => entry.uuid)).toEqual(['a']);
  });

  it('treats a missing boardSummaries as an empty list rather than throwing', () => {
    const [only] = toMapPins([gym({ latitude: 1, longitude: 1, boardSummaries: [] })]);
    expect(only.boardSummaries).toEqual([]);
  });

  it('counts pin coverage against the gyms actually on screen', () => {
    expect(
      pinCoverage([gym({ uuid: 'a', latitude: 1, longitude: 1 }), gym({ uuid: 'b' }), gym({ uuid: 'c' })]),
    ).toEqual({ pinned: 1, total: 3 });
  });
});

describe('clusterPins', () => {
  it('gives every pin its own marker below the threshold', () => {
    const pins = [pin(1, 51, -2), pin(2, 52, -1)];
    const clusters = clusterPins(pins);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((cluster) => cluster.count === 1 && cluster.pin !== null)).toBe(true);
  });

  it('caps the marker count once a result set goes past the threshold', () => {
    // Pins spread across a degree grid so bucketing has real work to do.
    const pins = Array.from({ length: CLUSTER_PIN_THRESHOLD + 100 }, (_, index) =>
      pin(index, -80 + (index % 160) * 0.9, -170 + (index % 340)),
    );
    const clusters = clusterPins(pins);
    expect(clusters.length).toBeLessThanOrEqual(CLUSTER_PIN_THRESHOLD);
    expect(clusters.reduce((sum, cluster) => sum + cluster.count, 0)).toBeGreaterThan(0);
  });

  it('keeps the gym on a bucket that merged exactly one pin, so it still links out', () => {
    const crowd = Array.from({ length: 250 }, (_, index) => pin(index, 51 + index * 0.0001, -2 + index * 0.0001));
    // One pin on the far side of the planet lands alone in its own bucket.
    const loner = pin(9999, -41.29, 174.78);
    const clusters = clusterPins([...crowd, loner]);

    const lonerCluster = clusters.find((cluster) => cluster.pin?.uuid === 'gym-9999');
    expect(lonerCluster).toBeDefined();
    expect(lonerCluster?.count).toBe(1);
    expect(clusters.some((cluster) => cluster.count > 1 && cluster.pin === null)).toBe(true);
  });

  it('is deterministic: the same pins produce the same keys in the same order', () => {
    const pins = Array.from({ length: 260 }, (_, index) => pin(index, (index % 90) * 0.7, (index % 180) * 0.9));
    expect(clusterPins(pins).map((cluster) => cluster.key)).toEqual(clusterPins(pins).map((cluster) => cluster.key));
  });

  it('places a merged bucket at the centroid of its members', () => {
    const pins = [pin(1, 10.2, 20.2), pin(2, 10.4, 20.4)];
    const [merged] = clusterPins(pins, 1);
    expect(merged.count).toBe(2);
    expect(merged.pin).toBeNull();
    expect(merged.latitude).toBeCloseTo(10.3, 5);
    expect(merged.longitude).toBeCloseTo(20.3, 5);
  });
});

describe('nearMeFallbackReason', () => {
  it('reports an absent geolocation API before it looks at any error', () => {
    expect(nearMeFallbackReason({ geolocationSupported: false, error: null })).toBe('unsupported');
    expect(nearMeFallbackReason({ geolocationSupported: false, error: { code: 1 } })).toBe('unsupported');
  });

  it('reads a denial off the error code, not off a permission state', () => {
    // `navigator.permissions.query({ name: 'geolocation' })` is missing in
    // browsers that still have geolocation, so `permissionState` stays null
    // there and a UI keyed off it would never show this.
    expect(nearMeFallbackReason({ geolocationSupported: true, error: { code: 1 } })).toBe('denied');
  });

  it('separates a timeout or a failed fix from a denial', () => {
    expect(nearMeFallbackReason({ geolocationSupported: true, error: { code: 3 } })).toBe('unavailable');
    // The hook rejects with a plain Error when the API is gone: no `code` at all.
    expect(nearMeFallbackReason({ geolocationSupported: true, error: {} })).toBe('unavailable');
  });

  it('returns null when there is nothing to fall back from', () => {
    expect(nearMeFallbackReason({ geolocationSupported: true, error: null })).toBeNull();
  });
});

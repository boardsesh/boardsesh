import type { GymDirectoryCard } from '@boardsesh/graphql/operations';
import type { GymBoardSummary } from '@boardsesh/shared-schema';

/**
 * The pure model behind the directory's map and its "near me" mode (#4380).
 *
 * Everything here is a plain function over plain data so the parts that are
 * easy to get quietly wrong — how many pins a viewport is allowed to render,
 * what "the browser said no" actually means, how much coordinate precision
 * leaves the client — are decided in one testable place rather than inside a
 * Leaflet effect nobody can assert on.
 */

/**
 * Radius choices, in km.
 *
 * Four, not a slider: the backend's radius is a hard `ST_DWithin` cutoff, so
 * every value is a separate query, and a slider would fire one per pixel. 25 km
 * is the default because it is roughly "gyms I would actually drive to".
 */
export const NEAR_ME_RADIUS_OPTIONS_KM = [10, 25, 50, 100] as const;
export type NearMeRadiusKm = (typeof NEAR_ME_RADIUS_OPTIONS_KM)[number];

export const DEFAULT_NEAR_ME_RADIUS_KM: NearMeRadiusKm = 25;

/**
 * What `SearchGymsInputSchema.limit` accepts — `z.number().int().min(1).max(50)`.
 *
 * `validateInput` THROWS on 51; it does not clamp. So a "just ask for 200 and
 * slice" near-me query is not a slow query, it is a GraphQL error and an empty
 * map. Pinned here next to the value that has to respect it, with a test that
 * fails if the near-me limit ever drifts past it.
 */
export const MAX_BACKEND_SEARCH_LIMIT = 50;

/** One page of near-me results. Never paginated: "near me" is one answer. */
export const NEAR_ME_RESULT_LIMIT = MAX_BACKEND_SEARCH_LIMIT;

/**
 * Decimal places kept on a coordinate before it leaves the browser.
 *
 * Three is ~110 m — far finer than a 10 km radius needs and coarse enough that
 * the value stops being "where this person is standing". Applied to the query
 * variables and to nothing else: coordinates never reach an analytics payload
 * in any shape, rounded or not.
 */
export const COORDINATE_DECIMALS = 3;

export function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** A gym that can actually be drawn on the map: it has a pin and a link. */
export type MapPin = {
  uuid: string;
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  boardSummaries: GymBoardSummary[];
};

/**
 * The subset of a result set that has somewhere to go on the map.
 *
 * ~63% of gyms have a lat/lng (DB-06), so this always throws some away. That is
 * the number the map's pill is honest about — it is not a bug to fix by
 * inventing pins.
 */
export function toMapPins(gyms: readonly GymDirectoryCard[]): MapPin[] {
  const pins: MapPin[] = [];
  for (const gym of gyms) {
    if (typeof gym.latitude !== 'number' || typeof gym.longitude !== 'number') continue;
    if (!gym.slug) continue;
    pins.push({
      uuid: gym.uuid,
      slug: gym.slug,
      name: gym.name,
      latitude: gym.latitude,
      longitude: gym.longitude,
      boardSummaries: gym.boardSummaries ?? [],
    });
  }
  return pins;
}

/** How many of the gyms on screen have a pin — the pill's two numbers. */
export function pinCoverage(gyms: readonly GymDirectoryCard[]): { pinned: number; total: number } {
  return { pinned: toMapPins(gyms).length, total: gyms.length };
}

/**
 * Above this many pins, buckets replace individual markers.
 *
 * A page renders 24 gyms and a near-me search at most 50, so this is a ceiling
 * the current surfaces never touch — deliberately. It exists so that raising
 * either number, or reusing this map for a bounds query later, cannot put an
 * unbounded number of DOM nodes in one viewport.
 */
export const CLUSTER_PIN_THRESHOLD = 200;

/**
 * Grid cell sizes tried in order, in degrees, until the bucket count fits under
 * the threshold. A deterministic grid rather than a clustering dependency:
 * markercluster is 60 kB for a case we have never hit, and a grid is a pure
 * function with a stable answer for a given input.
 */
const CLUSTER_CELL_DEGREES = [1, 2, 5, 10, 20, 45] as const;

export type PinCluster = {
  /** Stable across renders for the same input, so markers are not rebuilt. */
  key: string;
  latitude: number;
  longitude: number;
  count: number;
  /**
   * The gym, when the bucket holds exactly ONE — so a single-pin bucket keeps
   * its link and its popup instead of degrading into an anonymous "1". Null
   * only for a bucket that genuinely merged several gyms.
   */
  pin: MapPin | null;
};

function bucketPins(pins: readonly MapPin[], cellDegrees: number): PinCluster[] {
  const buckets = new Map<string, MapPin[]>();
  for (const pin of pins) {
    const key = `${Math.floor(pin.latitude / cellDegrees)}:${Math.floor(pin.longitude / cellDegrees)}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.push(pin);
    } else {
      buckets.set(key, [pin]);
    }
  }

  return [...buckets.entries()]
    .map(([key, members]) => {
      const latitude = members.reduce((sum, member) => sum + member.latitude, 0) / members.length;
      const longitude = members.reduce((sum, member) => sum + member.longitude, 0) / members.length;
      return {
        key: `cluster-${cellDegrees}-${key}`,
        latitude,
        longitude,
        count: members.length,
        pin: members.length === 1 ? members[0] : null,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * The markers to draw for a result set.
 *
 * Under the threshold every pin is its own marker (`count: 1`, `pin` set), so
 * the renderer has one code path and the common case is not a special case.
 * Over it, pins collapse into grid buckets, coarsening the grid until the
 * marker count fits — and if even the coarsest grid does not (which would take
 * pins on most of the planet), the list is truncated deterministically rather
 * than rendered unbounded.
 */
export function clusterPins(pins: readonly MapPin[], threshold = CLUSTER_PIN_THRESHOLD): PinCluster[] {
  if (pins.length <= threshold) {
    return pins.map((pin) => ({
      key: `pin-${pin.uuid}`,
      latitude: pin.latitude,
      longitude: pin.longitude,
      count: 1,
      pin,
    }));
  }

  for (const cellDegrees of CLUSTER_CELL_DEGREES) {
    const buckets = bucketPins(pins, cellDegrees);
    if (buckets.length <= threshold) {
      return buckets;
    }
  }

  return bucketPins(pins, CLUSTER_CELL_DEGREES[CLUSTER_CELL_DEGREES.length - 1]).slice(0, threshold);
}

/**
 * Why near-me is unavailable, or `null` when it is available.
 *
 * Branches on the ERROR CODE and on the API being absent, never on
 * `permissionState`: `navigator.permissions.query({ name: 'geolocation' })` is
 * not implemented everywhere (Safari historically, and every browser with the
 * Permissions API missing entirely), so `useGeolocation` leaves that field
 * `null` and a UI keyed off it would sit in "we don't know" forever on the
 * browsers most likely to need the fallback.
 */
export type NearMeFallbackReason = 'unsupported' | 'denied' | 'unavailable';

export function nearMeFallbackReason(input: {
  geolocationSupported: boolean;
  /** `GeolocationPositionError` in the browser; a plain `Error` has no `code`. */
  error: { code?: number } | null;
}): NearMeFallbackReason | null {
  if (!input.geolocationSupported) {
    return 'unsupported';
  }
  if (!input.error) {
    return null;
  }
  // 1 === GeolocationPositionError.PERMISSION_DENIED. Read off the constant on
  // the instance where there is one, but never REQUIRE it: the hook rejects
  // with a plain Error when the API is missing, and that has no code at all.
  return input.error.code === 1 ? 'denied' : 'unavailable';
}

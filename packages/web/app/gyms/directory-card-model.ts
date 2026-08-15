import type { GymBoardSummary } from '@boardsesh/shared-schema';
import { BOARD_TYPE_LABELS } from '@boardsesh/board-constants';
import { distanceKm } from './directory-facets';

/** One board chip: a board type and the angle that wall is set at. */
export type BoardChip = {
  /** Stable React key. */
  key: string;
  boardType: string;
  /** Degrees. `0` means the gym never recorded one — render the bare board name. */
  angle: number;
};

const BOARD_TYPE_ORDER = Object.keys(BOARD_TYPE_LABELS);

/**
 * Collapse `boardSummaries` into the chips a card renders.
 *
 * A gym with four Kilter walls all set at 40° is one chip, not four: the card
 * answers "what can I climb on here", and repeating the same chip four times
 * answers nothing while pushing the useful chips off the row. Distinct angles
 * stay distinct — a 40° and a 50° Kilter are genuinely different sessions.
 */
export function boardChips(summaries: readonly GymBoardSummary[] | null | undefined): BoardChip[] {
  if (!summaries || summaries.length === 0) {
    return [];
  }

  const unique = new Map<string, BoardChip>();
  for (const summary of summaries) {
    const boardType = summary.boardType;
    const angle = Number.isFinite(summary.angle) ? Math.round(summary.angle) : 0;
    const key = `${boardType}-${angle}`;
    if (!unique.has(key)) {
      unique.set(key, { key, boardType, angle });
    }
  }

  return [...unique.values()].sort((left, right) => {
    const leftRank = BOARD_TYPE_ORDER.indexOf(left.boardType);
    const rightRank = BOARD_TYPE_ORDER.indexOf(right.boardType);
    // Unknown board types sort last rather than to the front on `-1`.
    const leftOrder = leftRank === -1 ? BOARD_TYPE_ORDER.length : leftRank;
    const rightOrder = rightRank === -1 ? BOARD_TYPE_ORDER.length : rightRank;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.angle - right.angle;
  });
}

/** Where a card's location line comes from, or `null` when there is nothing true to say. */
export type CardLocation = { kind: 'address'; address: string } | { kind: 'distance'; km: number } | null;

export type CardLocationInput = {
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

/**
 * The card's location line.
 *
 * The gym table has a free-text `address` (populated for ~24% of rows) and a
 * lat/lng pin (~63%). It has NO city, region or country column. So there are
 * exactly three honest outcomes: the address the gym typed, a distance from an
 * origin the request supplied, or nothing at all. Reverse-geocoding a pin into
 * "Berlin, Germany" would invent a locality for a row that never stored one,
 * and a wrong city on a gym card is worse than no line.
 */
export function cardLocation(
  gym: CardLocationInput,
  origin: { latitude: number; longitude: number } | null,
): CardLocation {
  const address = gym.address?.trim();
  if (address) {
    return { kind: 'address', address };
  }

  if (origin && typeof gym.latitude === 'number' && typeof gym.longitude === 'number') {
    return {
      kind: 'distance',
      km: distanceKm(origin, { latitude: gym.latitude, longitude: gym.longitude }),
    };
  }

  return null;
}

/**
 * The distance to show ALONGSIDE the location line, or null.
 *
 * Additive to `cardLocation` rather than a change to it: an address is the more
 * useful line and keeps winning it, but once somebody has shared a location
 * "how far is that" is the question the whole near-me mode exists to answer,
 * and a card that answers it for pinned-but-addressless gyms only would look
 * arbitrary. Returns null when the location line is ALREADY the distance, so
 * the same fact never renders twice.
 */
export function distanceChipKm(
  gym: CardLocationInput,
  origin: { latitude: number; longitude: number } | null,
  location: CardLocation,
): number | null {
  if (!origin || location?.kind !== 'address') return null;
  if (typeof gym.latitude !== 'number' || typeof gym.longitude !== 'number') return null;
  return distanceKm(origin, { latitude: gym.latitude, longitude: gym.longitude });
}

/**
 * Round a distance for display: whole km once you're far enough away that a
 * decimal is noise, one decimal when you're close enough to walk.
 */
export function roundDistanceKm(km: number): number {
  return km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
}

/**
 * One `Intl.NumberFormat` per locale, shared by every card on the page.
 *
 * A page renders 24 cards and each one wants a formatter. Constructing one per
 * card is 24 ICU lookups, and ~76% of them are dead work because the card shows
 * an address rather than a distance. Four locales ship, so this map is bounded
 * at four entries and never needs eviction.
 */
const numberFormatCache = new Map<string, Intl.NumberFormat>();

export function numberFormatFor(locale: string): Intl.NumberFormat {
  const cached = numberFormatCache.get(locale);
  if (cached) return cached;
  const created = new Intl.NumberFormat(locale);
  numberFormatCache.set(locale, created);
  return created;
}

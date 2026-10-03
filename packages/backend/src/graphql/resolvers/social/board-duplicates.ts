import { distanceMeters } from '@boardsesh/db/queries';

// ============================================
// createBoard duplicate detection
// ============================================
//
// A board's *configuration* (board type, layout, size, hold sets) does not
// identify a physical board. The same MoonBoard 2024 Standard config exists at
// every gym that owns one, so an owner legitimately has two of them — see #4166,
// where a climber tried for a week to add a second one at a new gym and the app
// silently activated their existing board instead.
//
// What identifies a board is config AND place. This module decides "are these
// the same physical board?" so `createBoard` can block the genuine accident
// (submitting the same board twice) without blocking the legitimate case.
//
// Kept pure and DB-free — the caller supplies the candidate rows — so it is
// unit-testable without postgres, and portable: `distanceMeters` is a JS
// Haversine, matching the no-PostGIS approach in `gym-matching.ts`.

/**
 * Two boards this close together, with the same config, are treated as the same
 * physical board. Shares a value with `AUTO_GYM_MATCH_RADIUS_METERS` so "same
 * place" means the same thing here as it does for gym matching.
 *
 * Two boards in one large gym can sit inside this radius and still be distinct;
 * those users get the confirmation prompt and continue, which is exactly what
 * the `allowDuplicateConfig` opt-in is for.
 */
export const DUPLICATE_BOARD_RADIUS_METERS = 150;

export type BoardLocation = {
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
};

function isAsciiWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f';
}

/**
 * Canonical decimal set membership for comparing persisted board configs.
 * Stored rows can predate input validation, so normalize decimal tokens without
 * converting arbitrarily long values through Number or BigInt. Preserve the
 * original database text; this key is only for equality checks.
 *
 * Whitespace around a token is tolerated for legacy rows, but whitespace inside
 * a token, empty tokens, and non-decimal members have no canonical membership.
 */
export function canonicalSetIdMembership(setIds: string): string | undefined {
  const normalizedSetIds = new Set<string>();
  let tokenStart = 0;

  for (let index = 0; index <= setIds.length; index += 1) {
    if (index < setIds.length && setIds[index] !== ',') continue;

    let tokenBegin = tokenStart;
    let tokenEnd = index;
    while (tokenBegin < tokenEnd && isAsciiWhitespace(setIds[tokenBegin])) tokenBegin += 1;
    while (tokenEnd > tokenBegin && isAsciiWhitespace(setIds[tokenEnd - 1])) tokenEnd -= 1;

    if (tokenBegin === tokenEnd) return undefined;

    let firstSignificantDigit = tokenBegin;
    for (let digitIndex = tokenBegin; digitIndex < tokenEnd; digitIndex += 1) {
      const character = setIds[digitIndex];
      if (character < '0' || character > '9') return undefined;
      if (character === '0' && firstSignificantDigit === digitIndex && digitIndex < tokenEnd - 1) {
        firstSignificantDigit += 1;
      }
    }

    normalizedSetIds.add(setIds.slice(firstSignificantDigit, tokenEnd));
    tokenStart = index + 1;
  }

  return [...normalizedSetIds]
    .sort((firstSetId, secondSetId) => {
      // Leading zeros are already stripped, so length then lexical order is numeric order without BigInt.
      const lengthDifference = firstSetId.length - secondSetId.length;
      if (lengthDifference !== 0) return lengthDifference;
      if (firstSetId < secondSetId) return -1;
      if (firstSetId > secondSetId) return 1;
      return 0;
    })
    .join(',');
}

function hasCoordinates(location: BoardLocation): boolean {
  return location.latitude != null && location.longitude != null;
}

function normalisedLocationName(location: BoardLocation): string | null {
  const trimmed = location.locationName?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Whether two boards sit in the same place, most-precise signal first.
 *
 * Coordinates win when both sides have them. Failing that, a matching typed
 * location name counts — most boards never get coordinates, because the field
 * lives behind "More options" and can only be filled by "Use my location",
 * which requires standing at the wall.
 *
 * Two boards with no location at all are treated as the SAME place: there is no
 * evidence they differ, and the common accident this guard exists to catch (a
 * double submit) produces exactly that shape. The user can still override.
 *
 * A placed board and a placeless one are treated as DIFFERENT. That is the
 * permissive reading, chosen deliberately: silently blocking a real board is
 * the failure this issue is about, and the prompt is still available on every
 * tier that does match.
 */
export function isSameBoardLocation(first: BoardLocation, second: BoardLocation): boolean {
  if (hasCoordinates(first) && hasCoordinates(second)) {
    return (
      distanceMeters(
        { latitude: first.latitude!, longitude: first.longitude! },
        { latitude: second.latitude!, longitude: second.longitude! },
      ) <= DUPLICATE_BOARD_RADIUS_METERS
    );
  }

  const firstName = normalisedLocationName(first);
  const secondName = normalisedLocationName(second);
  if (firstName != null && secondName != null) {
    return firstName === secondName;
  }

  const firstPlaced = hasCoordinates(first) || firstName != null;
  const secondPlaced = hasCoordinates(second) || secondName != null;
  return !firstPlaced && !secondPlaced;
}

/**
 * The already-owned board that should block this create, or undefined.
 *
 * Callers pass candidates already narrowed in SQL to the same owner, board type,
 * layout and size. Set-id equality is decided HERE rather than in the query,
 * because persisted text can be reordered or legacy-padded. Compare canonical
 * decimal membership on both sides, and never match malformed values just
 * because both lack a canonical key. Raw stored set IDs are not rewritten.
 *
 * Angle is deliberately not compared — one wall runs at many angles, so it can
 * never distinguish two boards.
 */
export function findBlockingDuplicate<Candidate extends BoardLocation & { setIds: string }>(
  candidates: Candidate[],
  incoming: BoardLocation & { setIds: string },
): Candidate | undefined {
  const incomingSetMembership = canonicalSetIdMembership(incoming.setIds);
  if (incomingSetMembership === undefined) return undefined;

  return candidates.find((candidate) => {
    const candidateSetMembership = canonicalSetIdMembership(candidate.setIds);
    return (
      candidateSetMembership !== undefined &&
      candidateSetMembership === incomingSetMembership &&
      isSameBoardLocation(candidate, incoming)
    );
  });
}

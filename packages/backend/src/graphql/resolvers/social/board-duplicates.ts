import { normaliseSetIds } from '@boardsesh/board-config';
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
 * because the stored value is whatever order the board was created with:
 * `'25,26,27,24'` and `'24,25,26,27'` are the same physical board, but a SQL
 * `eq()` calls them different. `normaliseSetIds` is the same helper the mobile
 * builder uses, so both ends now agree.
 *
 * Angle is deliberately not compared — one wall runs at many angles, so it can
 * never distinguish two boards.
 */
export function findBlockingDuplicate<Candidate extends BoardLocation & { setIds: string }>(
  candidates: Candidate[],
  incoming: BoardLocation & { setIds: string },
): Candidate | undefined {
  const incomingSetIds = normaliseSetIds(incoming.setIds);
  return candidates.find(
    (candidate) => normaliseSetIds(candidate.setIds) === incomingSetIds && isSameBoardLocation(candidate, incoming),
  );
}

// The pure half of "Add your gym" (`NewGymStep`): what a valid gym is, what is
// sent to `createGym`, which listed gyms are still asked about, and the rows
// the page draws. Pure, so each rule is a table test.

import type {
  CreateGymInput,
  FindSimilarGymsInput,
  GymDuplicateCheckInput,
  PlaceSuggestion,
  SimilarGym,
} from '@boardsesh/shared-schema';
import type { GymLocationSource } from '@boardsesh/analytics';
import type { Coords } from '../../../lib/use-device-location';
import { formatDistance } from '../use-board-item-copy';
import { distanceBetweenMeters } from '../../gym-directory/gym-pick-rows';
import { groupedCellPosition, type GroupedCellPosition } from '../../gym-page/gym-page-view-model';

/** The server's limits on a new gym (`CreateGymInputSchema`). */
export const GYM_NAME_MAX_LENGTH = 100;
export const GYM_ADDRESS_MAX_LENGTH = 300;
/** The most gyms one `CONFIRMED_SEPARATE` may name (the server refuses more). */
export const MAX_ACKNOWLEDGED_GYM_UUIDS = 50;
/** The shortest name worth asking "is it one of these?" about. */
export const MIN_SIMILAR_LOOKUP_NAME_LENGTH = 2;

/** Where the pin is, and how it got there (for `Gym Created`'s `locationSource`). */
export type GymPin = Coords & { source: GymLocationSource };

/** The name as it would be saved, or null when it can't be (empty, or over 100 characters). */
export function savableGymName(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= GYM_NAME_MAX_LENGTH ? trimmed : null;
}

/** Save needs a name and a pin; nothing else. */
/**
 * A pin that can be saved. A picked town is only where to start looking (its
 * centre is rarely the gym), so it counts once the climber has moved the map
 * under the dot, which makes it a `map` pin.
 */
export function isSavablePin(pin: GymPin | null): pin is GymPin {
  return pin !== null && pin.source !== 'town';
}

/** Save needs a name and a savable pin; nothing else. */
export function canSaveGym(nameText: string, pin: GymPin | null): boolean {
  return savableGymName(nameText) !== null && isSavablePin(pin);
}

/**
 * Coordinates rounded to about 11 m: the similar-gyms lookup is keyed on them,
 * and a pin nudged a metre is the same question.
 */
function roundedCoordinate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The "is it one of these?" lookup for a name and a pin, or null while the name
 * is too short to match anything. Without a pin the server matches by name alone.
 */
export function similarGymsLookupInput(nameText: string, pin: Coords | null): FindSimilarGymsInput | null {
  const name = nameText.trim();
  if (name.length < MIN_SIMILAR_LOOKUP_NAME_LENGTH || name.length > GYM_NAME_MAX_LENGTH) return null;
  if (!pin) return { name };
  return { name, latitude: roundedCoordinate(pin.latitude), longitude: roundedCoordinate(pin.longitude) };
}

/**
 * The gyms the climber has said are not theirs, with `newlyDismissed` added as
 * the most recent. A gym dismissed again moves to the end, and only the most
 * recent 50 are kept: they are the ones the next check could name again.
 */
export function acknowledgeGyms(acknowledged: readonly string[], newlyDismissed: readonly string[]): string[] {
  const fresh = new Set(newlyDismissed);
  const kept = acknowledged.filter((uuid) => !fresh.has(uuid));
  return [...kept, ...fresh].slice(-MAX_ACKNOWLEDGED_GYM_UUIDS);
}

/** How far the pin may move before a "not my gym" no longer answers the question. */
export const ACKNOWLEDGEMENT_RADIUS_METERS = 150;

/**
 * The gyms the climber said are not theirs, and the question they answered:
 * the name (normalized) and the pin as they were then. A different gym asked
 * about under another name, or 3 km away, is a different question.
 */
export type GymAcknowledgement = { uuids: readonly string[]; name: string; pin: Coords | null };

/** A name as the "not my gym" answers compare it: trimmed, lower case, single spaces. */
export function normalizedGymName(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

/**
 * The gyms still dismissed for this name and pin: none once the name has
 * changed, the pin has moved more than 150 m from where they were dismissed,
 * or a pin was added or taken away since.
 */
export function acknowledgedFor(
  acknowledgement: GymAcknowledgement | null,
  nameText: string,
  pin: Coords | null,
): readonly string[] {
  if (!acknowledgement) return [];
  if (normalizedGymName(nameText) !== acknowledgement.name) return [];
  if ((acknowledgement.pin === null) !== (pin === null)) return [];
  if (acknowledgement.pin && pin && distanceBetweenMeters(acknowledgement.pin, pin) > ACKNOWLEDGEMENT_RADIUS_METERS) {
    return [];
  }
  return acknowledgement.uuids;
}

/**
 * `newlyDismissed` added to the answers that still hold for this name and pin.
 * The place they answer stays where the first of them was given, so a run of
 * small moves can't carry them away from it.
 */
export function acknowledgeAt(
  acknowledgement: GymAcknowledgement | null,
  nameText: string,
  pin: Coords | null,
  newlyDismissed: readonly string[],
): GymAcknowledgement {
  const stillHeld = acknowledgedFor(acknowledgement, nameText, pin);
  const anchor = acknowledgement && stillHeld.length > 0 ? acknowledgement.pin : pin;
  return {
    uuids: acknowledgeGyms(stillHeld, newlyDismissed),
    name: normalizedGymName(nameText),
    pin: anchor ? { latitude: anchor.latitude, longitude: anchor.longitude } : null,
  };
}

/**
 * The duplicate check a save sends: refuse on any similar gym, or, once the
 * climber has said some are not theirs, refuse only on the others.
 */
export function duplicateCheckFor(acknowledged: readonly string[]): GymDuplicateCheckInput {
  return acknowledged.length > 0
    ? { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: [...acknowledged] }
    : { mode: 'REJECT_IF_FOUND' };
}

/** What `createGym` is sent. A public, listed gym; the address only when one was given. */
export function buildCreateGymInput({
  name,
  pin,
  address,
  acknowledged,
}: {
  name: string;
  pin: Coords;
  address: string;
  acknowledged: readonly string[];
}): CreateGymInput {
  const trimmedAddress = address.trim().slice(0, GYM_ADDRESS_MAX_LENGTH);
  return {
    name: name.trim(),
    latitude: pin.latitude,
    longitude: pin.longitude,
    ...(trimmedAddress ? { address: trimmedAddress } : {}),
    isPublic: true,
    isListed: true,
    duplicateCheck: duplicateCheckFor(acknowledged),
  };
}

/**
 * The listed gyms still asked about: a save's refusal when there is one (the
 * server's word), else the lookup's, less any the climber said are not theirs.
 */
export function similarGymsToAsk(
  lookup: readonly SimilarGym[] | undefined,
  refused: readonly SimilarGym[] | null,
  acknowledged: readonly string[],
): SimilarGym[] {
  const dismissed = new Set(acknowledged);
  return (refused ?? lookup ?? []).filter((gym) => !dismissed.has(gym.uuid));
}

/** "350 m · Street 1": how far from the pin the listed gym is, then its address, either alone, or null. */
export function similarGymSubtitle(gym: SimilarGym): string | null {
  const parts = [
    gym.distanceMeters != null ? formatDistance(gym.distanceMeters) : null,
    gym.address?.trim() || null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export type NewGymRow =
  | { kind: 'sectionHeader'; key: string; label: string }
  /** A town suggested for the search text: a tap moves the map there. */
  | { kind: 'place'; key: string; place: PlaceSuggestion; position: GroupedCellPosition }
  | { kind: 'placesAttribution'; key: string; label: string }
  /** Where the pin is, and "Use my location". */
  | { kind: 'pin'; key: string }
  /** "Is it one of these?" over the listed gyms. */
  | { kind: 'similarIntro'; key: string; label: string }
  | { kind: 'similarGym'; key: string; gym: SimilarGym; subtitle: string | null; position: GroupedCellPosition }
  /** "No, add a new gym". */
  | { kind: 'addNew'; key: string }
  | { kind: 'address'; key: string }
  /** A save that failed, or the gym cap reached. */
  | { kind: 'notice'; key: string; label: string };

export const ADDRESS_ROW_KEY = 'address';
export const SIMILAR_HEADER_KEY = 'similar:header';

export function buildNewGymRows({
  places,
  similar,
  notice,
  labels,
}: {
  places: { suggestions: readonly PlaceSuggestion[]; label: string; attribution: string | null };
  similar: readonly SimilarGym[];
  /** Why the last save didn't go through, or null. */
  notice: string | null;
  labels: { similarTitle: string; similarBody: string };
}): NewGymRow[] {
  const rows: NewGymRow[] = [];
  if (places.suggestions.length > 0) {
    rows.push({ kind: 'sectionHeader', key: 'places:header', label: places.label });
    places.suggestions.forEach((place, index) => {
      rows.push({
        kind: 'place',
        key: `place:${place.id}`,
        place,
        position: groupedCellPosition(index, places.suggestions.length),
      });
    });
    if (places.attribution)
      rows.push({ kind: 'placesAttribution', key: 'places:attribution', label: places.attribution });
  }
  rows.push({ kind: 'pin', key: 'pin' });
  if (similar.length > 0) {
    rows.push({ kind: 'sectionHeader', key: SIMILAR_HEADER_KEY, label: labels.similarTitle });
    rows.push({ kind: 'similarIntro', key: 'similar:intro', label: labels.similarBody });
    similar.forEach((gym, index) => {
      rows.push({
        kind: 'similarGym',
        key: `similar:${gym.uuid}`,
        gym,
        subtitle: similarGymSubtitle(gym),
        position: groupedCellPosition(index, similar.length),
      });
    });
    rows.push({ kind: 'addNew', key: 'similar:add-new' });
  }
  rows.push({ kind: 'address', key: ADDRESS_ROW_KEY });
  if (notice) rows.push({ kind: 'notice', key: 'notice', label: notice });
  return rows;
}

/** A pin this close to the device fix is "at your location". */
const AT_CLIMBER_METERS = 25;

/**
 * What the line under the map says about the pin. The screen turns each kind
 * into its copy:
 * - map drawn: nothing yet (`needed`), zoomed out too far to mean a place
 *   (`zoomIn`), at the climber or this far from them (`atYou`, `fromYou`),
 *   near the town or address searched (`nearPlace`), or a spot on the map with
 *   no fix to measure from (`set`);
 * - no map (a browser, a broken native map): nothing yet (`fallbackNeeded`),
 *   or where the gym will go (`fallbackYou`, `fallbackPlace`).
 */
export type PinCaption =
  | { kind: 'needed' }
  | { kind: 'zoomIn' }
  | { kind: 'atYou' }
  | { kind: 'fromYou'; distance: string }
  | { kind: 'nearPlace'; place: string }
  | { kind: 'set' }
  | { kind: 'fallbackNeeded' }
  | { kind: 'fallbackYou' }
  | { kind: 'fallbackPlace'; place: string };

export function pinCaptionFor({
  pin,
  mapAvailable,
  zoomedOut,
  deviceCoords,
  placeLabel,
}: {
  pin: GymPin | null;
  mapAvailable: boolean;
  zoomedOut: boolean;
  deviceCoords: Coords | null;
  /** The town picked or the address searched, for a pin that came from one. */
  placeLabel: string | null;
}): PinCaption {
  if (!mapAvailable) {
    if (!pin) return { kind: 'fallbackNeeded' };
    if (pin.source === 'device') return { kind: 'fallbackYou' };
    // Without a map a town can't be narrowed down to the gym: only a fix or an address places it.
    if (pin.source === 'town') return { kind: 'fallbackNeeded' };
    return placeLabel ? { kind: 'fallbackPlace', place: placeLabel } : { kind: 'fallbackNeeded' };
  }
  if (!pin) return zoomedOut ? { kind: 'zoomIn' } : { kind: 'needed' };
  if ((pin.source === 'town' || pin.source === 'address') && placeLabel)
    return { kind: 'nearPlace', place: placeLabel };
  if (deviceCoords) {
    const meters = distanceBetweenMeters(deviceCoords, pin);
    return meters < AT_CLIMBER_METERS ? { kind: 'atYou' } : { kind: 'fromYou', distance: formatDistance(meters) };
  }
  return { kind: 'set' };
}

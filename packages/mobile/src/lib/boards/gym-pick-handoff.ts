// The builders' gym row (Edit board, Set up, a spray wall's details): which gym
// the board sits in, so it lands on the map under that gym instead of as a lone
// pin. Before #4166 mobile never set `gymUuid` at all and a board's only tie to
// a place was a free-text location name.
//
// The row pushes `/boards/gym-picker` (the gym step in pick mode) inside the
// board picker's stack. It used to open a searchable list in a sheet, which on
// top of the Boards sheet was a sheet on a sheet
// (docs/mobile/mobile-sheets-vs-routes.md). The route hands the answer back to
// the form that pushed it through this channel, addressed to that form
// (lib/addressed-handoff.ts), so a second form mounted under it never takes it.
//
// There is deliberately no "create a gym" form behind "My gym isn't listed": it
// hands the climber back to the location field, and the server's auto-gym path
// applies the nearby-name dedup guards before minting one.

import { createAddressedHandoff } from '../addressed-handoff';

/** A gym as the picker hands it back and both builders hold it. */
export type PickedGym = {
  uuid: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
};

/** What the climber chose on the gym picker. */
export type GymPick =
  /** This gym. */
  | { kind: 'gym'; gym: PickedGym }
  /** "Not at a gym": clear the link. */
  | { kind: 'none' }
  /** "My gym isn't listed": clear the link and say where the board is instead. */
  | { kind: 'not_listed' };

const gymPickHandoff = createAddressedHandoff<GymPick>();

let handoffCounter = 0;

/** A fresh address for one mounted form. */
export function createGymPickHandoffId(): string {
  handoffCounter += 1;
  return `gym-pick-${handoffCounter}`;
}

export function emitGymPick(handoffId: string, pick: GymPick): void {
  gymPickHandoff.emit(handoffId, pick);
}

/** Listens for the picks handed back to `handoffId` only. Returns the unsubscribe. */
export function subscribeToGymPicks(handoffId: string, listener: (pick: GymPick) => void): () => void {
  return gymPickHandoff.subscribe(handoffId, listener);
}

export type GymPickerHref = {
  pathname: '/boards/gym-picker';
  params: Record<string, string>;
};

export type GymPickerContext = {
  /** The pushing form's address (`createGymPickHandoffId`). */
  handoffId: string;
  /** The gym the board is in now, ticked on the list. */
  currentGymUuid: string | null;
  /** Where the board is, when known: the map starts there instead of on the device's fix. */
  boardCoords: { latitude: number; longitude: number } | null;
  /**
   * Whether the board shows on the map at all (it is public). "Not at a gym"
   * promised a pin of its own even on a private wall, which never gets one
   * (#5960).
   */
  showsOnMap: boolean;
};

/** The gym picker, opened by a builder's gym row. */
export function gymPickerHref({ handoffId, currentGymUuid, boardCoords, showsOnMap }: GymPickerContext): GymPickerHref {
  const params: Record<string, string> = { handoffId, showsOnMap: showsOnMap ? '1' : '0' };
  if (currentGymUuid) params.gymUuid = currentGymUuid;
  if (boardCoords) {
    params.latitude = String(boardCoords.latitude);
    params.longitude = String(boardCoords.longitude);
  }
  return { pathname: '/boards/gym-picker', params };
}

function readCoordinate(value: string | undefined, limit: number): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

/** The picker's params as `gymPickerHref` wrote them, read defensively (a deep link can carry anything). */
export function readGymPickerParams(params: {
  handoffId?: string;
  gymUuid?: string;
  latitude?: string;
  longitude?: string;
  showsOnMap?: string;
}): GymPickerContext {
  const latitude = readCoordinate(params.latitude, 90);
  const longitude = readCoordinate(params.longitude, 180);
  return {
    handoffId: params.handoffId ?? '',
    currentGymUuid: params.gymUuid ? params.gymUuid : null,
    boardCoords: latitude !== null && longitude !== null ? { latitude, longitude } : null,
    showsOnMap: params.showsOnMap !== '0',
  };
}

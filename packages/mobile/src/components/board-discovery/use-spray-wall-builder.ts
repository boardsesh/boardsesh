// The meta half of `use-board-builder.ts`, for a wall (epic #5346, SW-09).
//
// A catalogue board is a CHOICE — board → layout → size → sets, each level
// resetting the ones below it — and `useBoardBuilder` is mostly that cascade. A
// spray wall has none of it: its layout and its size are allocated by the server
// when the wall is created, and its holds come from a photograph. So this hook
// is the other half: what the wall is called, who can see it, where it is, and
// the angle its owner measured.
//
// Deliberately a separate hook rather than a flag on `useBoardBuilder`. Threading
// "no cascade" through that one would put a spray branch in every `selectLayout`
// / `selectSize` / `toggleSet` callback and in `buildCreateInput`, for a board
// type that can never reach any of them. The FIELDS are shared — both builders
// satisfy `BoardIdentityBuilder` and `BoardVisibilityBuilder`, and both drive the
// same `BoardMetaFields` components — which is where the duplication that
// matters would otherwise live.

import { useCallback, useRef, useState } from 'react';
import type { CreateSprayWallInput } from '@boardsesh/graphql/generated/graphql';
import type { BoardGymSelection } from './BoardMetaFields';

/**
 * The angle a wall opens at.
 *
 * Typed by the owner with a tape measure or a phone level, so there is no
 * catalogue list to pick from — `ANGLES[boardName]` does not exist for spray and
 * would be wrong if it did. 40° is the commonest home-wall build and the app's
 * default angle everywhere else.
 */
export const DEFAULT_SPRAY_ANGLE = 40;

/** What a wall's angle may be. A wall past vertical-to-roof is not a wall. */
export const MIN_SPRAY_ANGLE = 0;
export const MAX_SPRAY_ANGLE = 70;

/** Longest a wall's name may be, matching the board name column. */
const MAX_NAME_LENGTH = 100;

export type SprayWallBuilderSeed = {
  name?: string;
  angle?: number;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  locationName?: string;
};

/** True when `value` is an angle a wall can actually be built at. */
export function isValidSprayAngle(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= MIN_SPRAY_ANGLE && value <= MAX_SPRAY_ANGLE;
}

/**
 * Parse what the owner typed into the angle field.
 *
 * Returns null for anything that is not a usable angle, which is what disables
 * the step's primary action — rather than silently clamping, which would create
 * a wall at an angle nobody chose and, because the angle is frozen once a
 * version is published, would be permanent.
 */
export function parseSprayAngle(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return isValidSprayAngle(parsed) ? parsed : null;
}

/**
 * The name / visibility / location / gym / angle state behind the add-a-wall
 * flow's first step.
 *
 * Pure of any rendering, like `useBoardBuilder`, so the stepper can be unit
 * tested without a renderer.
 */
export function useSprayWallBuilder(seed?: SprayWallBuilderSeed | null) {
  const [name, setName] = useState(seed?.name ?? '');
  const [angleText, setAngleText] = useState(String(seed?.angle ?? DEFAULT_SPRAY_ANGLE));
  // A wall is somebody's home, so every visibility default is inverted from a
  // catalogue board's: private, not listed, and — once a location is stamped at
  // all — hidden. The same inversion the `createSprayWall` resolver applies
  // server-side (`docs/spray-walls.md`, "the two fields it never takes").
  const [isPublic, setIsPublic] = useState(seed?.isPublic ?? false);
  const [isUnlisted, setIsUnlisted] = useState(seed?.isUnlisted ?? false);
  const [hideLocation, setHideLocation] = useState(seed?.hideLocation ?? true);
  const [locationName, setLocationName] = useState(seed?.locationName ?? '');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [selectedGym, setSelectedGymState] = useState<{ uuid: string; name: string } | null>(null);

  /**
   * Pick (or clear) the wall's gym, back-filling the location name the way
   * `useBoardBuilder` does — only while the field is blank or still holds the
   * name this function last put there, so anything typed by hand survives
   * switching gyms.
   */
  const autoFilledLocationRef = useRef<string | null>(null);
  const setSelectedGym = useCallback((gym: BoardGymSelection | null) => {
    setSelectedGymState(gym ? { uuid: gym.uuid, name: gym.name } : null);
    if (!gym) return;
    if (gym.latitude != null && gym.longitude != null) {
      setCoords({ latitude: gym.latitude, longitude: gym.longitude });
    } else {
      setCoords(null);
    }
    setLocationName((previous) => {
      const isOurs = previous.trim().length === 0 || previous === autoFilledLocationRef.current;
      return isOurs ? gym.name : previous;
    });
    autoFilledLocationRef.current = gym.name;
  }, []);

  const angle = parseSprayAngle(angleText);
  const canCreate = name.trim().length > 0 && angle != null;

  /**
   * The validated `createSprayWallInput`, or null while the step is incomplete.
   *
   * `hasLeds` and `isAngleAdjustable` are absent on purpose: they are not in the
   * input schema at all, because the resolver writes both as false. A wall has
   * no controller to talk to and its stats are keyed by an angle that never
   * moves.
   */
  const buildCreateInput = useCallback((): CreateSprayWallInput | null => {
    const trimmedName = name.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmedName.length === 0 || angle == null) return null;
    return {
      name: trimmedName,
      angle,
      isPublic,
      isUnlisted,
      hideLocation,
      locationName: locationName.trim() || undefined,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      gymUuid: selectedGym?.uuid,
    };
  }, [name, angle, isPublic, isUnlisted, hideLocation, locationName, coords, selectedGym]);

  return {
    name,
    setName,
    angleText,
    setAngleText,
    angle,
    isPublic,
    setIsPublic,
    isUnlisted,
    setIsUnlisted,
    hideLocation,
    setHideLocation,
    locationName,
    setLocationName,
    coords,
    setCoords,
    selectedGym,
    setSelectedGym,
    canCreate,
    buildCreateInput,
  };
}

export type SprayWallBuilder = ReturnType<typeof useSprayWallBuilder>;

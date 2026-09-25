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

import { useCallback, useMemo, useRef, useState } from 'react';
import { SPRAY_ANGLES } from '@boardsesh/board-config';
import type { CreateSprayWallInput } from '@boardsesh/graphql/generated/graphql';
import type { BoardGymSelection } from './BoardMetaFields';

/**
 * The angle a wall opens at.
 *
 * 40° is the commonest home-wall build and the app's default angle everywhere
 * else. Fixed for the wall's life once a version publishes, because stats are
 * keyed by angle.
 */
export const DEFAULT_SPRAY_ANGLE = 40;

/**
 * The angles a wall may be built at: the shared list, not a range of our own.
 *
 * `CreateSprayWallInputSchema` validates against `SPRAY_ANGLES` — 0 to 70 in
 * five-degree steps — so a client that accepted every integer in between would
 * let a climber type 37, walk the whole photo and corner flow, and only meet the
 * refusal at the upload, with the wall already created. Offering the real list is
 * what makes that unreachable rather than merely unlikely.
 */
export const SPRAY_ANGLE_OPTIONS: readonly number[] = SPRAY_ANGLES;

/** Longest a wall's name may be, matching the board name column. */
const MAX_NAME_LENGTH = 100;

/** True when `value` is one of the angles the server will actually accept. */
export function isValidSprayAngle(value: number): boolean {
  return SPRAY_ANGLE_OPTIONS.includes(value);
}

export type SprayWallBuilderSeed = {
  name?: string;
  angle?: number;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  locationName?: string;
};

/**
 * The name / visibility / location / gym / angle state behind the add-a-wall
 * flow's first step.
 *
 * Pure of any rendering, like `useBoardBuilder`, so the stepper can be unit
 * tested without a renderer.
 */
export function useSprayWallBuilder(seed?: SprayWallBuilderSeed | null) {
  const [name, setName] = useState(seed?.name ?? '');
  // A number the picker snaps, not free text: `SPRAY_ANGLE_OPTIONS` is the whole
  // set of legal answers, so there is no invalid state to validate out of.
  const [angle, setAngle] = useState<number>(
    seed?.angle != null && isValidSprayAngle(seed.angle) ? seed.angle : DEFAULT_SPRAY_ANGLE,
  );
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

  const canCreate = name.trim().length > 0 && isValidSprayAngle(angle);

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
    if (trimmedName.length === 0 || !isValidSprayAngle(angle)) return null;
    return {
      name: trimmedName,
      angle,
      // The climber's choice, sent at creation so the SERVER holds it (#5513).
      //
      // The row exists from here on — the photo handler authorises against it —
      // but it has no version, no photo and no holds, so `createSprayWall` keeps
      // the board private and parks this pair on the wall until the first
      // publish applies it. It used to be forced false here and applied from
      // React state after the publish, which a climber who closed the app and
      // resumed the wall never got: the resumed builder's defaults said private.
      //
      // `pendingVisibility` below still drives an `updateSprayWall` after the
      // publish. Against a backend that applies the pair itself that write is a
      // no-op; against one that predates it, the wall was created with these
      // flags directly and the write re-states them.
      isPublic,
      isUnlisted,
      hideLocation,
      locationName: locationName.trim() || undefined,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      gymUuid: selectedGym?.uuid,
    };
  }, [name, angle, isPublic, isUnlisted, hideLocation, locationName, coords, selectedGym]);

  /**
   * The visibility the climber asked for, to be applied once the wall has
   * something worth seeing. Null when they left it private, which is the
   * default and needs no second write.
   */
  const pendingVisibility = useCallback(
    (): { isPublic: boolean; isUnlisted: boolean } | null => (isPublic || isUnlisted ? { isPublic, isUnlisted } : null),
    [isPublic, isUnlisted],
  );

  // Memoised because the screen puts `builder` in `useCallback` dep arrays (the
  // upload and the publish both read several fields at once), and a fresh object
  // literal per render would rebuild those callbacks on every commit — including
  // every `UPLOAD_PROGRESS` tick. The mobile performance checklist in CLAUDE.md
  // asks for this of any hook whose return value lands in a dep array.
  return useMemo(
    () => ({
      name,
      setName,
      angle,
      setAngle,
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
      pendingVisibility,
    }),
    [
      name,
      angle,
      isPublic,
      isUnlisted,
      hideLocation,
      locationName,
      coords,
      selectedGym,
      setSelectedGym,
      canCreate,
      buildCreateInput,
      pendingVisibility,
    ],
  );
}

export type SprayWallBuilder = ReturnType<typeof useSprayWallBuilder>;

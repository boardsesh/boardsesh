// The details half of `use-board-builder.ts`, for a wall (epic #5346, SW-09).
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
import type { SprayWallDetailsUpdate } from '../../lib/spray/use-create-spray-wall';
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
export const SPRAY_WALL_NAME_MAX_LENGTH = 100;

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

/** Everything the details step edits, as the wall on the server holds it. */
export type SprayWallDetails = {
  name: string;
  angle: number;
  isPublic: boolean;
  isUnlisted: boolean;
  hideLocation: boolean;
  locationName: string;
  coords: { latitude: number; longitude: number } | null;
  gym: { uuid: string; name: string } | null;
};

/**
 * What the server said about a wall, for `hydrate`. A field left out is one the
 * read did not carry: the builder keeps its own value and takes THAT as what
 * the server holds — right for the create response, which answers with fewer
 * fields than were sent.
 */
export type SprayWallDetailsSeed = Partial<SprayWallDetails>;

/** The location name as the server stores it: trimmed, and empty is no name. */
function normalisedLocationName(value: string): string | null {
  return value.trim() || null;
}

function sameCoords(
  left: { latitude: number; longitude: number } | null,
  right: { latitude: number; longitude: number } | null,
): boolean {
  if (left == null || right == null) return left === right;
  return left.latitude === right.latitude && left.longitude === right.longitude;
}

/**
 * The name / visibility / location / gym / angle state behind the add-a-wall
 * flow's details step.
 *
 * The wall is CREATED before the climber sees that step (the photo upload needs
 * a wall they own), with whatever this holds then: the default name, 40° and
 * link-only sharing pending publication. So the step edits an existing wall. `hydrate` records what
 * the server holds, and `buildDetailsUpdate` sends only what changed since.
 * After a save the screen hydrates again from the server's ANSWER, never from
 * what it sent: the server may clamp a choice (a visibility policy).
 *
 * Pure of any rendering, like `useBoardBuilder`, so the stepper can be unit
 * tested without a renderer.
 */
export function useSprayWallBuilder(
  seed?: SprayWallBuilderSeed | null,
  options?: {
    /**
     * The name a wall gets when nobody types one ("Marco's Spray wall"). Shown
     * as the name until the climber edits it or a wall is hydrated, so a value
     * that arrives late (the profile query) still lands.
     */
    defaultName?: string;
  },
) {
  // Null until somebody (the climber, or `hydrate`) sets a name: until then the
  // name IS the default, whenever that arrives.
  const [typedName, setTypedName] = useState<string | null>(seed?.name ?? null);
  const name = typedName ?? options?.defaultName ?? '';
  const setName = useCallback((next: string) => setTypedName(next), []);
  // A number the picker snaps, not free text: `SPRAY_ANGLE_OPTIONS` is the whole
  // set of legal answers, so there is no invalid state to validate out of.
  const [angle, setAngle] = useState<number>(
    seed?.angle != null && isValidSprayAngle(seed.angle) ? seed.angle : DEFAULT_SPRAY_ANGLE,
  );
  // New walls default to link-only sharing with their location hidden.
  // Saved visibility choices take precedence when editing or resuming a wall.
  const [isPublic, setIsPublic] = useState(seed?.isPublic ?? false);
  const [isUnlisted, setIsUnlisted] = useState(seed?.isUnlisted ?? true);
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
   * What the server holds, as of the last `hydrate`. Starts as
   * the constructor's own values, which is what a wall created from an untouched
   * builder holds.
   */
  const baselineRef = useRef<SprayWallDetails>({
    name: name.trim().slice(0, SPRAY_WALL_NAME_MAX_LENGTH),
    angle,
    isPublic,
    isUnlisted,
    hideLocation,
    locationName,
    coords,
    gym: selectedGym,
  });

  /** The fields as they stand, in the server's terms (trimmed name). */
  const snapshot = useCallback(
    (): SprayWallDetails => ({
      name: name.trim().slice(0, SPRAY_WALL_NAME_MAX_LENGTH),
      angle,
      isPublic,
      isUnlisted,
      hideLocation,
      locationName,
      coords,
      gym: selectedGym,
    }),
    [name, angle, isPublic, isUnlisted, hideLocation, locationName, coords, selectedGym],
  );
  // Read by `hydrate`, which is stable on purpose: the screen
  // calls them from resume callbacks that effects depend on, and a callback
  // that changed on every keystroke would restart those effects.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  /**
   * Take on the wall as the server holds it, and remember that as the baseline
   * `buildDetailsUpdate` diffs against. Fields the seed leaves out keep this
   * builder's value, which becomes their baseline too.
   */
  const hydrate = useCallback((wallSeed: SprayWallDetailsSeed) => {
    const current = snapshotRef.current();
    // An angle the slider cannot show is not shown (the builder keeps its own),
    // but it IS what the server holds, so it stays the baseline and Save writes
    // the angle on screen.
    const seededAngle = wallSeed.angle;
    const next: SprayWallDetails = {
      name: wallSeed.name ?? current.name,
      angle: seededAngle != null && isValidSprayAngle(seededAngle) ? seededAngle : current.angle,
      isPublic: wallSeed.isPublic ?? current.isPublic,
      isUnlisted: wallSeed.isUnlisted ?? current.isUnlisted,
      hideLocation: wallSeed.hideLocation ?? current.hideLocation,
      locationName: wallSeed.locationName ?? current.locationName,
      coords: wallSeed.coords !== undefined ? wallSeed.coords : current.coords,
      gym: wallSeed.gym !== undefined ? wallSeed.gym : current.gym,
    };
    setTypedName(next.name);
    setAngle(next.angle);
    setIsPublic(next.isPublic);
    setIsUnlisted(next.isUnlisted);
    setHideLocation(next.hideLocation);
    setLocationName(next.locationName);
    setCoords(next.coords);
    setSelectedGymState(next.gym);
    // A location name that is the gym's own was filled from the gym, so a
    // later gym change may replace it, as it would have in this sitting.
    autoFilledLocationRef.current = next.gym && next.locationName === next.gym.name ? next.gym.name : null;
    baselineRef.current = seededAngle != null ? { ...next, angle: seededAngle } : next;
  }, []);

  /**
   * The `updateSprayWall` fields that differ from what the server holds, or
   * null when nothing does — the details step then publishes without a write.
   * The visibility pair goes together: the two flags are one three-way choice.
   */
  const buildDetailsUpdate = useCallback((): SprayWallDetailsUpdate | null => {
    const current = snapshot();
    const base = baselineRef.current;
    const update: SprayWallDetailsUpdate = {};
    if (current.name !== base.name) update.name = current.name;
    if (current.angle !== base.angle) update.angle = current.angle;
    const gymUuid = current.gym?.uuid ?? null;
    if (gymUuid !== (base.gym?.uuid ?? null)) update.gymUuid = gymUuid;
    const location = normalisedLocationName(current.locationName);
    if (location !== normalisedLocationName(base.locationName)) update.locationName = location;
    if (!sameCoords(current.coords, base.coords)) {
      update.latitude = current.coords?.latitude ?? null;
      update.longitude = current.coords?.longitude ?? null;
    }
    if (current.hideLocation !== base.hideLocation) update.hideLocation = current.hideLocation;
    if (current.isPublic !== base.isPublic || current.isUnlisted !== base.isUnlisted) {
      update.isPublic = current.isPublic;
      update.isUnlisted = current.isUnlisted;
    }
    return Object.keys(update).length > 0 ? update : null;
  }, [snapshot]);

  /**
   * The validated `createSprayWallInput`, or null while the step is incomplete.
   *
   * `hasLeds` and `isAngleAdjustable` are absent on purpose: they are not in the
   * input schema at all, because the resolver writes both as false. A wall has
   * no controller to talk to and its stats are keyed by an angle that never
   * moves.
   */
  const buildCreateInput = useCallback((): CreateSprayWallInput | null => {
    const trimmedName = name.trim().slice(0, SPRAY_WALL_NAME_MAX_LENGTH);
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
   * something worth seeing. Null when they chose private, which needs no
   * second write.
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
      hydrate,
      buildDetailsUpdate,
    }),
    [
      name,
      setName,
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
      hydrate,
      buildDetailsUpdate,
    ],
  );
}

export type SprayWallBuilder = ReturnType<typeof useSprayWallBuilder>;

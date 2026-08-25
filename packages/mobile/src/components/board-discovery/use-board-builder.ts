import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardName, CreateBoardInput, UpdateBoardInput } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS, ANGLES, normaliseSetIds } from '@boardsesh/board-config';
import {
  getBoardLayouts,
  getBoardSizesForLayoutId,
  getBoardSetsForLayoutAndSize,
  getDefaultBoardSizeForLayout,
} from '../../lib/custom-board-options';
import { defaultAngle } from '../../lib/boards/default-angle';
import { cleanLayoutName } from './board-builder-labels';

/**
 * A board to pre-fill the builder with. The config fields (board/layout/size/
 * sets) drive the cascade and, when their VALUES change, re-seed it (see
 * `seedKey`). The optional meta fields pre-fill the "More options" form when
 * EDITING an existing board; they're seeded once via the `useState` initializers
 * (never re-seeded), so a render can't wipe the user's edits. The create flow
 * and the Popular-config seed omit them and fall back to the home-board defaults.
 */
export type BoardBuilderSeed = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  /** Comma-separated set ids. */
  setIds: string;
  angle?: number;
  // Meta (edit only):
  name?: string;
  isOwned?: boolean;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  isAngleAdjustable?: boolean;
  hasLeds?: boolean;
  locationName?: string;
  latitude?: number | null;
  longitude?: number | null;
  serialNumber?: string;
  /** Advertised BLE name of the Rogue workout timer paired to this board. */
  timerName?: string;
  /** The gym this board is already linked to (edit only). */
  gymUuid?: string | null;
  gymName?: string | null;
};

function parseSetIds(setIds: string): number[] {
  return setIds.split(',').map(Number).filter(Number.isFinite);
}

/**
 * The cascading board-config state machine behind the create-board builder
 * (board → layout → size → sets → angle), plus the optional "more options" meta
 * (name, ownership, visibility, location, serial). Pure of any rendering, so it
 * can drive a full screen and be unit-tested directly. Picking a size
 * auto-selects all of that size's sets, which is why the per-set toggles can
 * stay hidden behind Advanced for the 99% case.
 */
export function useBoardBuilder(seed?: BoardBuilderSeed | null) {
  const initialBoard = seed?.boardName ?? SUPPORTED_BOARDS[0];
  const [boardName, setBoardName] = useState<BoardName>(initialBoard);
  const [layoutId, setLayoutId] = useState<number | null>(seed?.layoutId ?? null);
  const [sizeId, setSizeId] = useState<number | null>(seed?.sizeId ?? null);
  const [setIds, setSetIds] = useState<number[]>(seed ? parseSetIds(seed.setIds) : []);
  const [angle, setAngle] = useState<number>(seed?.angle ?? defaultAngle(initialBoard));
  // Meta seeds (edit) run once here — NOT in the re-seed effect — so re-renders
  // can't clobber edits. Create / Popular omit them, so the home-board defaults apply.
  const [name, setName] = useState(seed?.name ?? '');

  // "More options" / advanced. Owned + public default to the home-board case.
  const [isOwned, setIsOwned] = useState(seed?.isOwned ?? true);
  const [isPublic, setIsPublic] = useState(seed?.isPublic ?? true);
  const [isUnlisted, setIsUnlisted] = useState(seed?.isUnlisted ?? false);
  const [hideLocation, setHideLocation] = useState(seed?.hideLocation ?? false);
  // Most home boards with a kicker tilt are adjustable; default on.
  const [isAngleAdjustable, setIsAngleAdjustable] = useState(seed?.isAngleAdjustable ?? true);
  // Nearly every Kilter/Tension wall ships with a light kit; default on so the
  // common case needs no thought. Turning it off is what unlocks the no-LED
  // "active climb" flow (#4585).
  const [hasLeds, setHasLeds] = useState(seed?.hasLeds ?? true);
  const [locationName, setLocationName] = useState(seed?.locationName ?? '');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(
    seed?.latitude != null && seed?.longitude != null ? { latitude: seed.latitude, longitude: seed.longitude } : null,
  );
  const [serialNumber, setSerialNumber] = useState(seed?.serialNumber ?? '');
  const [timerName, setTimerName] = useState(seed?.timerName ?? '');
  // The gym this board sits in. Picking one is what gets the board onto the map
  // under a gym rather than as a lone pin (#4166).
  const [selectedGym, setSelectedGymState] = useState<{ uuid: string; name: string } | null>(
    seed?.gymUuid && seed?.gymName ? { uuid: seed.gymUuid, name: seed.gymName } : null,
  );

  // Re-seed when the seed's VALUES change (opened from a different Popular
  // config). Keyed on the serialized seed, not its object identity, so an
  // unmemoised seed prop can't cause an infinite re-seed→render loop. Read
  // through a ref so the effect deps stay just the key.
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const seedKey = seed ? `${seed.boardName}:${seed.layoutId}:${seed.sizeId}:${seed.setIds}:${seed.angle ?? ''}` : '';
  useEffect(() => {
    const current = seedRef.current;
    if (!current) return;
    setBoardName(current.boardName);
    setLayoutId(current.layoutId);
    setSizeId(current.sizeId);
    setSetIds(parseSetIds(current.setIds));
    setAngle(current.angle ?? defaultAngle(current.boardName));
  }, [seedKey]);

  const layouts = useMemo(() => getBoardLayouts(boardName), [boardName]);
  const sizes = useMemo(
    () => (layoutId != null ? getBoardSizesForLayoutId(boardName, layoutId) : []),
    [boardName, layoutId],
  );
  const sets = useMemo(
    () => (layoutId != null && sizeId != null ? getBoardSetsForLayoutAndSize(boardName, layoutId, sizeId) : []),
    [boardName, layoutId, sizeId],
  );
  const angles = ANGLES[boardName] ?? [];
  const rawLayoutName = layouts.find((layout) => layout.id === layoutId)?.name ?? boardName;

  // Each level resets everything below it so the cascade stays consistent.
  // Stable across renders (deps are only the levels above) so memoised chip
  // rows don't re-render when an unrelated field — e.g. the dragged angle —
  // changes.
  const selectBoard = useCallback((next: BoardName) => {
    setBoardName(next);
    setLayoutId(null);
    setSizeId(null);
    setSetIds([]);
    setAngle(defaultAngle(next));
  }, []);
  const selectLayout = useCallback(
    (next: number) => {
      setLayoutId(next);
      const defaultSize = getDefaultBoardSizeForLayout(boardName, next);
      setSizeId(defaultSize);
      setSetIds(
        defaultSize != null ? getBoardSetsForLayoutAndSize(boardName, next, defaultSize).map((set) => set.id) : [],
      );
    },
    [boardName],
  );
  const selectSize = useCallback(
    (next: number) => {
      // Pre-select every set for the size — the common case (a "Full Ride" owner
      // has them all), and why the set toggles live behind Advanced.
      setSizeId(next);
      setSetIds(layoutId != null ? getBoardSetsForLayoutAndSize(boardName, layoutId, next).map((set) => set.id) : []);
    },
    [boardName, layoutId],
  );
  const toggleSet = useCallback(
    (id: number) => setSetIds((prev) => (prev.includes(id) ? prev.filter((set) => set !== id) : [...prev, id])),
    [],
  );

  const canCreate = layoutId != null && sizeId != null && setIds.length > 0;

  /**
   * Pick (or clear) the board's gym. Stamping the gym's own coordinates onto the
   * board is what lets the server's proximity check pass for a gym the user
   * doesn't run, and it's the more accurate value anyway.
   *
   * The location name is back-filled from the gym only when it's blank or still
   * holds the name this function last put there. Guarding on "blank" alone made
   * the back-fill sticky: pick gym A, switch to gym B, and the board ends up
   * linked to B but labelled A. Anything the user typed themselves is left alone.
   */
  const autoFilledLocationRef = useRef<string | null>(null);
  const setSelectedGym = useCallback(
    (gym: { uuid: string; name: string; latitude?: number | null; longitude?: number | null } | null) => {
      setSelectedGymState(gym ? { uuid: gym.uuid, name: gym.name } : null);
      if (!gym) return;
      if (gym.latitude != null && gym.longitude != null) {
        setCoords({ latitude: gym.latitude, longitude: gym.longitude });
      } else {
        // A gym with no coordinates can't vouch for the previous gym's, and a
        // stale pair would aim the server's proximity check at the wrong place.
        setCoords(null);
      }
      setLocationName((previous) => {
        const isOurs = previous.trim().length === 0 || previous === autoFilledLocationRef.current;
        return isOurs ? gym.name : previous;
      });
      autoFilledLocationRef.current = gym.name;
    },
    [],
  );

  /**
   * The validated CreateBoardInput, or null when the config is incomplete.
   * `fallbackName` (e.g. an auto-generated "Marco's Kilter Original 12×12") is
   * used when the user left the name blank; defaults to the cleaned layout name.
   */
  const buildCreateInput = (fallbackName?: string): CreateBoardInput | null => {
    if (layoutId == null || sizeId == null || setIds.length === 0) return null;
    return {
      boardType: boardName,
      layoutId,
      sizeId,
      // Canonical order so a re-ticked set matches an existing owned board.
      setIds: normaliseSetIds(setIds.join(',')),
      name: name.trim() || fallbackName?.trim() || cleanLayoutName(rawLayoutName, boardName),
      angle,
      isOwned,
      isPublic,
      isUnlisted,
      hideLocation,
      isAngleAdjustable,
      hasLeds,
      serialNumber: serialNumber.trim() || undefined,
      timerName: timerName.trim() || undefined,
      locationName: locationName.trim() || undefined,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      gymUuid: selectedGym?.uuid,
    };
  };

  /**
   * The validated UpdateBoardInput for `boardUuid`, or null when the config is
   * incomplete. Name/angle/visibility/location/serial are always editable.
   *
   * The config (layout/size/sets) is sent only when it is both unlocked and
   * genuinely different from `currentConfig`. `lockedConfig` means the viewer may
   * not change it at all. The unchanged case matters just as much: the form is
   * seeded with the board's own config, so every save used to resend it, the
   * server saw "config fields present" and ran its duplicate-config guard against
   * a config that never moved — which is how renaming one of two same-config
   * boards ended up rejected for colliding with its sibling. Set ids are compared
   * normalised, since the stored order is whatever the board was created with.
   *
   * Emptied location/serial are sent as `null` so editing them to blank clears
   * the stored value (vs `buildCreateInput`, which has nothing to clear).
   */
  const buildUpdateInput = (
    boardUuid: string,
    options?: {
      lockedConfig?: boolean;
      fallbackName?: string;
      /** The board's stored config, so an unchanged config is left out of the input. */
      currentConfig?: { layoutId: number; sizeId: number; setIds: string };
    },
  ): UpdateBoardInput | null => {
    if (layoutId == null || sizeId == null || setIds.length === 0) return null;
    const input: UpdateBoardInput = {
      boardUuid,
      name: name.trim() || options?.fallbackName?.trim() || cleanLayoutName(rawLayoutName, boardName),
      angle,
      isOwned,
      isPublic,
      isUnlisted,
      hideLocation,
      isAngleAdjustable,
      hasLeds,
      // null (not undefined) so emptying a previously-set field clears it on the
      // server — undefined would leave the old value in place (see UpdateBoardInput).
      serialNumber: serialNumber.trim() || null,
      timerName: timerName.trim() || null,
      locationName: locationName.trim() || null,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
    };
    const nextSetIds = normaliseSetIds(setIds.join(','));
    const currentConfig = options?.currentConfig;
    const configUnchanged =
      currentConfig != null &&
      currentConfig.layoutId === layoutId &&
      currentConfig.sizeId === sizeId &&
      normaliseSetIds(currentConfig.setIds) === nextSetIds;
    if (!options?.lockedConfig && !configUnchanged) {
      input.layoutId = layoutId;
      input.sizeId = sizeId;
      input.setIds = nextSetIds;
    }
    return input;
  };

  return {
    // config
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
    // meta
    name,
    isOwned,
    isPublic,
    isUnlisted,
    hideLocation,
    isAngleAdjustable,
    hasLeds,
    locationName,
    coords,
    serialNumber,
    timerName,
    selectedGym,
    // derived
    layouts,
    sizes,
    sets,
    angles,
    rawLayoutName,
    canCreate,
    // actions
    selectBoard,
    selectLayout,
    selectSize,
    toggleSet,
    setAngle,
    setName,
    setIsOwned,
    setIsPublic,
    setIsUnlisted,
    setHideLocation,
    setIsAngleAdjustable,
    setHasLeds,
    setLocationName,
    setCoords,
    setSerialNumber,
    setTimerName,
    setSelectedGym,
    buildCreateInput,
    buildUpdateInput,
  };
}

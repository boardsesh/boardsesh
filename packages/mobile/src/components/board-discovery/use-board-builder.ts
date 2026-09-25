import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardName, CreateBoardInput, UpdateBoardInput } from '@boardsesh/shared-schema';
import {
  SUPPORTED_BOARDS,
  ANGLES,
  normaliseSetIds,
  getBoardLayouts,
  getBoardSizesForLayoutId,
  getBoardSetsForLayoutAndSize,
  getDefaultBoardSizeForLayout,
} from '@boardsesh/board-config';
import { defaultAngle } from '../../lib/boards/default-angle';
import type { BoardConfigPreset } from '../../lib/boards/board-config-preset';
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

export type BoardBuilderOptions = {
  /**
   * The setup to preselect for a board type, when the builder should open with
   * one chosen instead of waiting for a layout tap (#5654, "My own board"). It
   * seeds the first board type when there is no `seed`, and every board type
   * the climber switches to afterwards.
   *
   * A new identity is how late data reaches the builder: while nothing is
   * preselected for the current type and the climber has not tapped a layout,
   * size or set, it is asked again, so a popular list that lands after the
   * first frame still preselects the setup. Once a preset is on screen or the
   * climber has picked something, a new identity changes nothing.
   */
  preset?: (boardName: BoardName) => BoardConfigPreset | null;
};

function sameSetup(preset: BoardConfigPreset, layoutId: number | null, sizeId: number | null, setIds: number[]) {
  if (preset.layoutId !== layoutId || preset.sizeId !== sizeId) return false;
  return normaliseSetIds(preset.setIds.join(',')) === normaliseSetIds(setIds.join(','));
}

/**
 * The cascading board-config state machine behind the create-board builder
 * (board → layout → size → sets → angle), plus the optional "more options" meta
 * (name, ownership, visibility, location, serial). Pure of any rendering, so it
 * can drive a full screen and be unit-tested directly. Picking a size
 * auto-selects all of that size's sets, which is why the per-set toggles can
 * stay hidden behind Advanced for the 99% case.
 */
export function useBoardBuilder(seed?: BoardBuilderSeed | null, options?: BoardBuilderOptions) {
  const initialBoard = seed?.boardName ?? SUPPORTED_BOARDS[0];
  // A seed is the climber's own choice (a Popular card, the board being
  // edited), so it always wins over a preset.
  const [initialPreset] = useState(() => (seed ? null : (options?.preset?.(initialBoard) ?? null)));
  const presetRef = useRef(options?.preset);
  presetRef.current = options?.preset;
  // The preset on screen for the current board type, or null when that type
  // opened with nothing chosen. Compared against the selection to say whether
  // a board was saved exactly as preset (`presetKept`).
  const [appliedPreset, setAppliedPreset] = useState<BoardConfigPreset | null>(initialPreset);
  // True once the climber taps a layout, size or set chip. A board-type tap
  // clears it, because that resets everything below it. While false, late
  // preset data may still fill an empty cascade.
  const setupTouchedRef = useRef(false);
  const [boardName, setBoardName] = useState<BoardName>(initialBoard);
  const [layoutId, setLayoutId] = useState<number | null>(seed?.layoutId ?? initialPreset?.layoutId ?? null);
  const [sizeId, setSizeId] = useState<number | null>(seed?.sizeId ?? initialPreset?.sizeId ?? null);
  const [setIds, setSetIds] = useState<number[]>(seed ? parseSetIds(seed.setIds) : (initialPreset?.setIds ?? []));
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

  // Late preset data (#5654). The popular list the preset reads is usually
  // cached from the picker, but not always, and a first frame without it opens
  // on an empty cascade. When it lands, fill that cascade, but only while it is
  // still empty and untouched: never move a setup the climber is looking at or
  // has picked. The board type and the applied preset are read through refs so
  // the only trigger is the preset (the popular list) changing: a type switch
  // already applies that type's preset in `selectBoard`, so the effect has
  // nothing to add when the type changes.
  const boardNameRef = useRef(boardName);
  boardNameRef.current = boardName;
  const appliedPresetRef = useRef(appliedPreset);
  appliedPresetRef.current = appliedPreset;
  const presetOption = options?.preset;
  useEffect(() => {
    if (seedRef.current || setupTouchedRef.current || appliedPresetRef.current) return;
    const latePreset = presetOption?.(boardNameRef.current) ?? null;
    if (!latePreset) return;
    setLayoutId(latePreset.layoutId);
    setSizeId(latePreset.sizeId);
    setSetIds(latePreset.setIds);
    setAppliedPreset(latePreset);
  }, [presetOption]);

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
  // changes. With a preset, "resets" means "moves to that type's preset", so a
  // climber switching from Kilter to Tension still has a working Save.
  const selectBoard = useCallback((next: BoardName) => {
    const preset = presetRef.current?.(next) ?? null;
    setupTouchedRef.current = false;
    setBoardName(next);
    setLayoutId(preset?.layoutId ?? null);
    setSizeId(preset?.sizeId ?? null);
    setSetIds(preset?.setIds ?? []);
    setAppliedPreset(preset);
    setAngle(defaultAngle(next));
  }, []);
  const selectLayout = useCallback(
    (next: number) => {
      setupTouchedRef.current = true;
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
      setupTouchedRef.current = true;
      setSizeId(next);
      setSetIds(layoutId != null ? getBoardSetsForLayoutAndSize(boardName, layoutId, next).map((set) => set.id) : []);
    },
    [boardName, layoutId],
  );
  const toggleSet = useCallback((id: number) => {
    setupTouchedRef.current = true;
    setSetIds((prev) => (prev.includes(id) ? prev.filter((set) => set !== id) : [...prev, id]));
  }, []);

  const canCreate = layoutId != null && sizeId != null && setIds.length > 0;
  // The selection is exactly the preset the builder chose for this board type:
  // a board saved like this was never changed below the board-type chips.
  const presetKept = appliedPreset != null && sameSetup(appliedPreset, layoutId, sizeId, setIds);

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
    presetKept,
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

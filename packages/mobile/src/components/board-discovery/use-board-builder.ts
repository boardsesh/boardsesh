import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardName, CreateBoardInput, UpdateBoardInput } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS, ANGLES, normaliseSetIds } from '@boardsesh/board-config';
import {
  getBoardLayouts,
  getBoardSizesForLayoutId,
  getBoardSetsForLayoutAndSize,
  getDefaultBoardSizeForLayout,
} from '../../lib/custom-board-options';
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
  locationName?: string;
  latitude?: number | null;
  longitude?: number | null;
  serialNumber?: string;
};

function defaultAngle(boardName: BoardName): number {
  const angles = ANGLES[boardName] ?? [];
  return angles.includes(40) ? 40 : (angles[0] ?? 0);
}

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
  const [locationName, setLocationName] = useState(seed?.locationName ?? '');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(
    seed?.latitude != null && seed?.longitude != null ? { latitude: seed.latitude, longitude: seed.longitude } : null,
  );
  const [serialNumber, setSerialNumber] = useState(seed?.serialNumber ?? '');

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
      serialNumber: serialNumber.trim() || undefined,
      locationName: locationName.trim() || undefined,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
    };
  };

  /**
   * The validated UpdateBoardInput for `boardUuid`, or null when the config is
   * incomplete. Name/angle/visibility/location/serial are always editable. The
   * config (layout/size/sets) is sent only when `lockedConfig` is false — the
   * server rejects config changes on boards that already have ticks, and an
   * unchanged config would still trip its duplicate-config guard, so we omit it.
   * Emptied location/serial are sent as `null` so editing them to blank clears
   * the stored value (vs `buildCreateInput`, which has nothing to clear).
   */
  const buildUpdateInput = (
    boardUuid: string,
    options?: { lockedConfig?: boolean; fallbackName?: string },
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
      // null (not undefined) so emptying a previously-set field clears it on the
      // server — undefined would leave the old value in place (see UpdateBoardInput).
      serialNumber: serialNumber.trim() || null,
      locationName: locationName.trim() || null,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
    };
    if (!options?.lockedConfig) {
      input.layoutId = layoutId;
      input.sizeId = sizeId;
      input.setIds = normaliseSetIds(setIds.join(','));
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
    locationName,
    coords,
    serialNumber,
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
    setLocationName,
    setCoords,
    setSerialNumber,
    buildCreateInput,
    buildUpdateInput,
  };
}

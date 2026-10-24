import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGradesForBoard, toBoardName } from '@boardsesh/board-config';
import { randomUUID } from 'expo-crypto';
import {
  buildWorkoutRun,
  generateStagedPlan,
  planFromBlocks,
  type GeneratorGradeScale,
  type StagedSlot,
  type WorkoutBlockSpec,
  type WorkoutPlan,
  type WorkoutRun,
  type WorkoutStage,
} from '@boardsesh/playlist-generator';
import { MAX_SYNCED_QUEUE_ITEMS, type ClimbQueueItem } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../../providers/toast-provider';
import { screenshotModeRandom } from '../../../lib/screenshot-mode';
import { useSearchGradeSourceActive } from '../../../lib/graphql/hooks/search-grade-source';
import { fetchGradePool } from './select-climbs-for-plan';
import {
  buildPoolsReusing,
  fetchFilters,
  filtersSignature,
  refreshSlotInState,
  reshufflePools,
  NO_AVOIDED_CLIMBS,
  selectItemsFromPools,
  type FetchGradePool,
  type PreviewFetchContext,
  type PreviewItem,
  type PreviewSlot,
  type WorkoutPreviewData,
} from './workout-preview-pool';
import { hasWorkoutBlocks, type GeneratorSelection, type WorkoutBlock } from './workout-blocks';

const DEBOUNCE_MS = 300;

export type WorkoutPreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export type UseWorkoutPreviewResult = {
  status: WorkoutPreviewStatus;
  items: PreviewItem[];
  /** Rows currently regenerating (show a spinner, disable the refresh button). */
  refreshingUuids: ReadonlySet<string>;
  /** Slots the generator planned — for the `SessionQueueGenerated.failedCount` delta. */
  plannedCount: number;
  /** Actual generated slot plan, before climb-pool shortfalls remove rows from the preview. Each slot names its stage. */
  plannedSlots: readonly StagedSlot[];
  /** The stages those slots belong to, in run order. Empty while no preview is current. */
  plannedStages: readonly WorkoutStage[];
  regenerate: () => void;
  /** Pick new climbs for the same plan from the pools already fetched. No network. */
  shuffle: () => void;
  refreshSlot: (itemUuid: string) => void;
  /**
   * The current preview as a queue, plus which workout stage each item belongs
   * to (the hand-off on Start). Empty items and a null run while the preview on
   * screen is not the one the current settings describe.
   */
  toStagedQueueItems: () => StagedQueueItems;
};

export type StagedQueueItems = {
  items: ClimbQueueItem[];
  /** Null when there is nothing to queue. */
  run: WorkoutRun | null;
};

const EMPTY_STAGED_QUEUE_ITEMS: StagedQueueItems = { items: [], run: null };

/** Stage ids are uuids so a stage added mid-session can never collide with one already in the run. */
const makeStageId = () => randomUUID();

/** A planned slot, with the filters its stage's climbs are fetched with. */
type FilteredStagedSlot = StagedSlot & Pick<PreviewSlot, 'filters'>;

/**
 * Stamps every slot with the filters its stage's climbs can be fetched with, so
 * the pools can key and fetch by them. The run keeps the stage's own filters.
 */
function withStageFilters(
  slots: readonly StagedSlot[],
  workoutPlan: WorkoutPlan,
  isAuthenticated: boolean,
): FilteredStagedSlot[] {
  const filtersByStageId = new Map(
    workoutPlan.stages.map((stage) => [stage.id, fetchFilters(stage.filters, isAuthenticated)]),
  );
  return slots.map((slot) => ({ ...slot, filters: filtersByStageId.get(slot.stageId) }));
}

/** Each slot's place within its own stage, by slot index: 0 for the stage's first slot. */
function positionsInStage(slots: readonly StagedSlot[]): Map<number, number> {
  const countByStageId = new Map<string, number>();
  const positionBySlotIndex = new Map<number, number>();
  for (const slot of slots) {
    const position = countByStageId.get(slot.stageId) ?? 0;
    countByStageId.set(slot.stageId, position + 1);
    positionBySlotIndex.set(slot.index, position);
  }
  return positionBySlotIndex;
}

/**
 * Names a block with the settings that shape its slots, and its filters: equal
 * names plan the same climbs, so a rebuild keeps their rows. A 4x4's rounds or
 * a rest length are not in it, so changing one keeps the climbs.
 */
function blockRowKey(block: WorkoutBlock): string {
  return `${block.id}|${getBlockSlotKey(block)}`;
}

/**
 * The rows a rebuild can keep: for each new slot, the row the same slot of the
 * same unchanged block showed before (`selectItemsFromPools` checks it still fits).
 */
function keptRowsFor(
  plan: readonly StagedSlot[],
  rowKeyByStageId: ReadonlyMap<string, string>,
  previousPlan: readonly StagedSlot[],
  previousRowKeyByStageId: ReadonlyMap<string, string>,
  previousItems: readonly PreviewItem[],
): Array<ClimbQueueItem | undefined> {
  const previousPositions = positionsInStage(previousPlan);
  const previousByRowSlot = new Map<string, ClimbQueueItem>();
  for (const { slot, item } of previousItems) {
    const rowKey = slot.stageId === undefined ? undefined : previousRowKeyByStageId.get(slot.stageId);
    const position = previousPositions.get(slot.index);
    if (rowKey !== undefined && position !== undefined) previousByRowSlot.set(`${rowKey}#${position}`, item);
  }
  const positions = positionsInStage(plan);
  return plan.map((slot) => {
    const rowKey = rowKeyByStageId.get(slot.stageId);
    const position = positions.get(slot.index);
    return rowKey === undefined || position === undefined ? undefined : previousByRowSlot.get(`${rowKey}#${position}`);
  });
}

type UseWorkoutPreviewDeps = {
  /** Injectable fetcher (tests pass a fake; production defaults to the GraphQL one). */
  fetchPool?: FetchGradePool;
  /** Injectable grade scale (tests bypass board-config). */
  grades?: GeneratorGradeScale;
};

export type UseWorkoutPreviewOptions = {
  isAuthenticated: boolean;
  /**
   * Climbs the preview should pass over while the pools have others: the live
   * queue, when a block is added mid-session. Read when the preview is built or
   * shuffled, never subscribed to, so a queue change does not rebuild it.
   */
  getAvoidedClimbUuids?: () => ReadonlySet<string>;
};

const EMPTY_DATA = (): WorkoutPreviewData => ({ items: [], pools: new Map(), usedUuids: new Set() });
const EMPTY_STAGES: readonly WorkoutStage[] = [];

// The settings that change a block's slots: equal keys plan the same grades.
// The filter copies inside a workout block's options are left out: the block's
// own `filters` are the ones its climbs are fetched with.
function getBlockSlotSettingsKey(block: WorkoutBlockSpec): string {
  if (block.kind === 'warmUp') return `warmUp:${block.warmUpType}`;
  const { options } = block;
  const commonKey = `${options.type}:${options.targetGrade}`;

  switch (options.type) {
    case 'volume':
      return `${commonKey}:${options.mainSetClimbs}:${options.mainSetVariability}`;
    case 'pyramid':
      return `${commonKey}:${options.numberOfSteps}:${options.climbsPerStep}`;
    case 'ladder':
      // ':down' only when hardest first, so every existing key stays as it was.
      return `${commonKey}:${options.numberOfSteps}:${options.climbsPerStep}${options.descending === true ? ':down' : ''}`;
    case 'gradeFocus':
    case 'onTheMinute':
    case 'limitBouldering':
      return `${commonKey}:${options.numberOfClimbs}`;
    case 'fourByFour':
      return `${commonKey}:${options.climbsPerRound}`;
  }
}

// Every setting of a block. Past the slot settings, a timed block's rounds and
// rests shape the queue and the run Start hands over, so they rebuild the
// preview too; `blockRowKey` leaves them out, so its rows survive the rebuild.
function getBlockSettingsKey(block: WorkoutBlockSpec): string {
  const slotKey = getBlockSlotSettingsKey(block);
  if (block.kind === 'warmUp') return slotKey;
  const { options } = block;

  switch (options.type) {
    case 'volume':
    case 'pyramid':
    case 'ladder':
    case 'gradeFocus':
      return slotKey;
    case 'onTheMinute':
      return `${slotKey}:${options.intervalSeconds}`;
    case 'fourByFour':
      return `${slotKey}:${options.rounds}:${options.restBetweenClimbsSeconds}:${options.restBetweenRoundsSeconds}`;
    case 'limitBouldering':
      return `${slotKey}:${options.restSeconds}`;
  }
}

function getBlockGenerationKey(block: WorkoutBlock): string {
  return `${getBlockSettingsKey(block)}/${filtersSignature(block.filters)}`;
}

/** A block's slot settings and filters: what its rows' climbs depend on. */
export function getBlockSlotKey(block: WorkoutBlock): string {
  return `${getBlockSlotSettingsKey(block)}/${filtersSignature(block.filters)}`;
}

function getSelectionGenerationKey(selection: GeneratorSelection): string {
  if (!hasWorkoutBlocks(selection)) return 'off';
  // Every block in run order: adding, removing or moving one, or changing its
  // filters, rebuilds the preview.
  return selection.blocks.map(getBlockGenerationKey).join('+');
}

function getBoardGenerationKey(board: UserBoard | null): string {
  return board ? `${board.boardType}:${board.layoutId}:${board.sizeId}:${board.setIds}:${board.angle}` : 'none';
}

/** Empty with the preference off, so the keys are what they were before the grade source existed. */
function gradeSourceKeySuffix(boardseshGrades: boolean): string {
  return boardseshGrades ? '|boardsesh-grades' : '';
}

function getPreviewGenerationKey(
  selection: GeneratorSelection,
  board: UserBoard | null,
  isAuthenticated: boolean,
  boardseshGrades: boolean,
): string {
  const authKey = isAuthenticated ? 'authenticated' : 'anonymous';
  return `${getSelectionGenerationKey(selection)}|${getBoardGenerationKey(board)}|${authKey}${gradeSourceKeySuffix(boardseshGrades)}`;
}

/**
 * Owns the live workout preview: a debounced rebuild whenever the workout type /
 * target grade / filters change, plus per-row regeneration. All mutable
 * bookkeeping (pools, used-climb set) lives in a ref; only `items`/`status`/
 * `refreshingUuids` drive render. Stale builds are dropped via a monotonic
 * generation token; rapid same-row refreshes are de-duped via an in-flight set.
 */
export function useWorkoutPreview(
  selection: GeneratorSelection,
  board: UserBoard | null,
  options: UseWorkoutPreviewOptions,
  deps?: UseWorkoutPreviewDeps,
): UseWorkoutPreviewResult {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const [status, setStatus] = useState<WorkoutPreviewStatus>('idle');
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [refreshingUuids, setRefreshingUuids] = useState<ReadonlySet<string>>(() => new Set());
  const [plannedCount, setPlannedCount] = useState(0);
  const [plannedSlots, setPlannedSlots] = useState<readonly StagedSlot[]>([]);
  const [plannedStages, setPlannedStages] = useState<readonly WorkoutStage[]>(EMPTY_STAGES);
  const [committedPreviewKey, setCommittedPreviewKeyState] = useState<string | null>(null);
  const [committedBoardKey, setCommittedBoardKey] = useState<string | null>(null);

  // Mutable source of truth the async callbacks read/write without re-rendering.
  const dataRef = useRef<WorkoutPreviewData>(EMPTY_DATA());
  // The committed plan, for a shuffle to re-fill without regenerating it. Its
  // slots carry their stage id; `workoutPlanRef` is the stage list they came from.
  const planRef = useRef<readonly FilteredStagedSlot[]>([]);
  // What the committed preview was built from, so a rebuild on the same board
  // and sign-in can reuse its pools and keep the rows of blocks that did not
  // change: the board and auth it was fetched for, and each stage's block.
  const committedFetchKeyRef = useRef<string | null>(null);
  const rowKeyByStageIdRef = useRef<ReadonlyMap<string, string>>(new Map());
  const workoutPlanRef = useRef<WorkoutPlan | null>(null);
  // Monotonic token: a build/clear only commits if it's still the latest.
  const genTokenRef = useRef(0);
  const committedPreviewKeyRef = useRef<string | null>(null);
  // Rows with a refresh fetch in flight (guards double-tap races).
  const inFlightSlotsRef = useRef<Set<string>>(new Set());
  const toastRef = useRef({ showToast, t });
  toastRef.current = { showToast, t };

  // Latest inputs behind refs so the public callbacks stay referentially stable
  // (empty deps) and never re-trigger the debounce effect by identity.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const boardRef = useRef(board);
  boardRef.current = board;
  const isAuthRef = useRef(options.isAuthenticated);
  isAuthRef.current = options.isAuthenticated;
  const boardseshGrades = useSearchGradeSourceActive();
  const boardseshGradesRef = useRef(boardseshGrades);
  boardseshGradesRef.current = boardseshGrades;
  const getAvoidedClimbUuidsRef = useRef(options.getAvoidedClimbUuids);
  getAvoidedClimbUuidsRef.current = options.getAvoidedClimbUuids;
  const fetchPoolRef = useRef<FetchGradePool>(deps?.fetchPool ?? fetchGradePool);
  fetchPoolRef.current = deps?.fetchPool ?? fetchGradePool;
  const gradesOverrideRef = useRef(deps?.grades);
  gradesOverrideRef.current = deps?.grades;

  const setCommittedPreviewKey = useCallback((nextPreviewKey: string | null, nextBoardKey: string | null = null) => {
    committedPreviewKeyRef.current = nextPreviewKey;
    setCommittedPreviewKeyState(nextPreviewKey);
    setCommittedBoardKey(nextBoardKey);
  }, []);

  const buildCtx = useCallback((): PreviewFetchContext | null => {
    const currentBoard = boardRef.current;
    const currentSelection = selectionRef.current;
    if (!currentBoard || !hasWorkoutBlocks(currentSelection)) return null;
    // No filters here: each fetch takes the filters of the slot it fills.
    return { board: currentBoard, isAuthenticated: isAuthRef.current, boardseshGrades: boardseshGradesRef.current };
  }, []);

  const resolveGrades = useCallback((targetBoard: UserBoard): GeneratorGradeScale | null => {
    if (gradesOverrideRef.current) return gradesOverrideRef.current;
    const boardName = toBoardName(targetBoard.boardType);
    if (!boardName) return null;
    return getGradesForBoard(boardName);
  }, []);

  const clearPreview = useCallback(
    (nextStatus: WorkoutPreviewStatus) => {
      genTokenRef.current++; // invalidate any in-flight build
      dataRef.current = EMPTY_DATA();
      planRef.current = [];
      workoutPlanRef.current = null;
      committedFetchKeyRef.current = null;
      setCommittedPreviewKey(null);
      setItems([]);
      setPlannedCount(0);
      setPlannedSlots([]);
      setPlannedStages(EMPTY_STAGES);
      setStatus(nextStatus);
    },
    [setCommittedPreviewKey],
  );

  // `reuse`: keep the pools and untouched blocks' rows the committed preview
  // already has, when it was built on the same board and sign-in. The live
  // rebuild after an edit reuses; an explicit regenerate starts fresh.
  const rebuild = useCallback(
    async (reuse: boolean) => {
      const currentSelection = selectionRef.current;
      const currentBoard = boardRef.current;
      if (!hasWorkoutBlocks(currentSelection) || !currentBoard) {
        clearPreview('idle');
        return;
      }
      const grades = resolveGrades(currentBoard);
      if (!grades || grades.length === 0) {
        clearPreview('idle');
        return;
      }

      const nextPreviewKey = getPreviewGenerationKey(
        currentSelection,
        currentBoard,
        isAuthRef.current,
        boardseshGradesRef.current,
      );
      const nextBoardKey = getBoardGenerationKey(currentBoard);
      const fetchKey = `${nextBoardKey}|${isAuthRef.current ? 'authenticated' : 'anonymous'}${gradeSourceKeySuffix(boardseshGradesRef.current)}`;
      const canReuse = reuse && committedFetchKeyRef.current === fetchKey;
      // Read now: a refresh landing during the fetch below must not change what this build keeps.
      const previous = {
        data: dataRef.current,
        plan: planRef.current,
        rowKeyByStageId: rowKeyByStageIdRef.current,
      };
      const token = ++genTokenRef.current;
      setStatus('loading'); // keep prior items mounted so the list doesn't jump
      try {
        // One stage per block, warm-ups included, each carrying its block's
        // filters. The pools below are fetched once per grade and filter set:
        // blocks with equal filters share them, a block with its own filters gets
        // its own, and one climb never fills two slots across any of them.
        const workoutPlan = planFromBlocks(currentSelection.blocks, makeStageId);
        // Start can never queue more than the party backend's setQueue accepts.
        const plan = withStageFilters(
          generateStagedPlan(workoutPlan, grades).slice(0, MAX_SYNCED_QUEUE_ITEMS),
          workoutPlan,
          isAuthRef.current,
        );
        // planFromBlocks makes one stage per block, in block order.
        const rowKeyByStageId = new Map(
          workoutPlan.stages.map((stage, position) => [stage.id, blockRowKey(currentSelection.blocks[position])]),
        );
        const ctx = buildCtx();
        if (!ctx || token !== genTokenRef.current) return; // selection/board changed underneath
        if (plan.length === 0) {
          dataRef.current = EMPTY_DATA();
          planRef.current = [];
          workoutPlanRef.current = null;
          committedFetchKeyRef.current = null;
          setCommittedPreviewKey(nextPreviewKey, nextBoardKey);
          setItems([]);
          setPlannedCount(0);
          setPlannedSlots([]);
          setPlannedStages(EMPTY_STAGES);
          setStatus('ready');
          return;
        }
        const { pools, poolDemands } = await buildPoolsReusing(
          plan,
          ctx,
          fetchPoolRef.current,
          canReuse ? previous.data : undefined,
        );
        if (token !== genTokenRef.current) return; // superseded by a newer build
        const avoided = getAvoidedClimbUuidsRef.current?.() ?? NO_AVOIDED_CLIMBS;
        const keptItems = canReuse
          ? keptRowsFor(plan, rowKeyByStageId, previous.plan, previous.rowKeyByStageId, previous.data.items)
          : [];
        const { items: nextItems, usedUuids } = selectItemsFromPools(plan, pools, avoided, keptItems);
        dataRef.current = { items: nextItems, pools, usedUuids, poolDemands };
        planRef.current = plan;
        workoutPlanRef.current = workoutPlan;
        committedFetchKeyRef.current = fetchKey;
        rowKeyByStageIdRef.current = rowKeyByStageId;
        setCommittedPreviewKey(nextPreviewKey, nextBoardKey);
        setItems(nextItems);
        setPlannedCount(plan.length);
        setPlannedSlots(plan);
        // The queue cap can cut a late stage off entirely; it gets no heading.
        const stageIdsWithSlots = new Set(plan.map((slot) => slot.stageId));
        setPlannedStages(workoutPlan.stages.filter((stage) => stageIdsWithSlots.has(stage.id)));
        setStatus('ready');
      } catch {
        if (token !== genTokenRef.current) return;
        setStatus('error'); // leave previous items in place
        toastRef.current.showToast(toastRef.current.t('mobile.session.preWorkoutPreviewError'), 'error');
      }
    },
    [buildCtx, clearPreview, resolveGrades],
  );
  const regenerate = useCallback(() => rebuild(false), [rebuild]);
  const rebuildForEdit = useCallback(() => rebuild(true), [rebuild]);

  const refreshSlot = useCallback(
    async (itemUuid: string) => {
      if (inFlightSlotsRef.current.size > 0) return; // serialize row refreshes to avoid whole-state overwrite races
      const ctx = buildCtx();
      if (!ctx) return;
      const token = genTokenRef.current;
      inFlightSlotsRef.current.add(itemUuid);
      setRefreshingUuids((prev) => new Set(prev).add(itemUuid));
      try {
        // Read at tap time, like a build: climbs queued since the preview was built
        // are passed over too.
        const avoided = getAvoidedClimbUuidsRef.current?.() ?? NO_AVOIDED_CLIMBS;
        const result = await refreshSlotInState(dataRef.current, itemUuid, ctx, fetchPoolRef.current, avoided);
        if (token !== genTokenRef.current) return;
        if (result.changed) {
          dataRef.current = result.state;
          setItems(result.state.items);
        }
      } catch {
        // Best-effort: leave the old climb in place; the spinner clears below.
        toastRef.current.showToast(toastRef.current.t('mobile.queue.actionFailed'), 'error');
      } finally {
        inFlightSlotsRef.current.delete(itemUuid);
        setRefreshingUuids((prev) => {
          const next = new Set(prev);
          next.delete(itemUuid);
          return next;
        });
      }
    },
    [buildCtx],
  );

  const shuffle = useCallback(() => {
    // A row refresh writes the whole state when it lands; let it finish first.
    if (inFlightSlotsRef.current.size > 0) return;
    // Only reshuffle the preview on screen. During a debounce or rebuild the
    // committed plan belongs to the previous settings.
    const currentPreviewKey = getPreviewGenerationKey(
      selectionRef.current,
      boardRef.current,
      isAuthRef.current,
      boardseshGradesRef.current,
    );
    if (committedPreviewKeyRef.current !== currentPreviewKey || planRef.current.length === 0) return;
    const pools = reshufflePools(dataRef.current.pools, screenshotModeRandom());
    const avoided = getAvoidedClimbUuidsRef.current?.() ?? NO_AVOIDED_CLIMBS;
    const { items: nextItems, usedUuids } = selectItemsFromPools(planRef.current, pools, avoided);
    dataRef.current = { items: nextItems, pools, usedUuids, poolDemands: dataRef.current.poolDemands };
    setItems(nextItems);
  }, []);

  const toStagedQueueItems = useCallback((): StagedQueueItems => {
    const currentPreviewKey = getPreviewGenerationKey(
      selectionRef.current,
      boardRef.current,
      isAuthRef.current,
      boardseshGradesRef.current,
    );
    if (committedPreviewKeyRef.current !== currentPreviewKey) return EMPTY_STAGED_QUEUE_ITEMS;
    const previews = dataRef.current.items;
    const workoutPlan = workoutPlanRef.current;
    if (previews.length === 0 || !workoutPlan) return EMPTY_STAGED_QUEUE_ITEMS;
    // Rows keep their slot through a row refresh (same uuid, new climb) and a
    // shuffle (new uuids, same plan), so a slot's index always finds its stage.
    const stageIdBySlotIndex = new Map(planRef.current.map((slot) => [slot.index, slot.stageId]));
    const entries: Array<{ uuid: string; stageId: string }> = [];
    for (const preview of previews) {
      const stageId = stageIdBySlotIndex.get(preview.slot.index);
      if (stageId !== undefined) entries.push({ uuid: preview.item.uuid, stageId });
    }
    return { items: previews.map((preview) => preview.item), run: buildWorkoutRun(entries, workoutPlan) };
  }, []);

  // Debounced live rebuild. `off`/no-board clears immediately; a real change
  // schedules a rebuild and supersedes any pending one via the cleared timer.
  const generationKey = useMemo(() => getSelectionGenerationKey(selection), [selection]);
  const authKey = options.isAuthenticated ? 'authenticated' : 'anonymous';
  const boardKey = getBoardGenerationKey(board);
  const currentPreviewKey = useMemo(
    () => getPreviewGenerationKey(selection, board, options.isAuthenticated, boardseshGrades),
    [selection, board, options.isAuthenticated, boardseshGrades],
  );

  useEffect(() => {
    if (generationKey === 'off' || boardKey === 'none') {
      void rebuildForEdit(); // synchronous clear to idle (reads refs)
      return undefined;
    }
    genTokenRef.current++; // mark existing preview/row refreshes stale during the debounce window
    setStatus('loading');
    const handle = setTimeout(() => void rebuildForEdit(), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [generationKey, boardKey, authKey, boardseshGrades, rebuildForEdit]);

  const regenerateVoid = useCallback(() => void regenerate(), [regenerate]);
  const refreshSlotVoid = useCallback((itemUuid: string) => void refreshSlot(itemUuid), [refreshSlot]);

  return useMemo(() => {
    const hasActivePreviewRequest = generationKey !== 'off' && boardKey !== 'none';
    const isCommittedPreviewCurrent = committedPreviewKey === currentPreviewKey;
    let exposedStatus = status;
    if (hasActivePreviewRequest && !isCommittedPreviewCurrent) {
      exposedStatus = status === 'error' ? 'error' : 'loading';
    }
    return {
      status: hasActivePreviewRequest ? exposedStatus : 'idle',
      // Rows may stay mounted while filters rebuild on the same board. A board
      // switch must hide them synchronously: row artwork and stats already use
      // the new board, before the debounce effect can replace the old climbs.
      items: hasActivePreviewRequest && committedBoardKey === boardKey ? items : [],
      refreshingUuids,
      plannedCount: hasActivePreviewRequest && isCommittedPreviewCurrent ? plannedCount : 0,
      plannedSlots: hasActivePreviewRequest && isCommittedPreviewCurrent ? plannedSlots : [],
      // Kept while a rebuild runs, like `items`, so the stage headings over the
      // rows still on screen keep their names.
      plannedStages: hasActivePreviewRequest && committedBoardKey === boardKey ? plannedStages : EMPTY_STAGES,
      regenerate: regenerateVoid,
      shuffle,
      refreshSlot: refreshSlotVoid,
      toStagedQueueItems,
    };
  }, [
    generationKey,
    boardKey,
    committedPreviewKey,
    committedBoardKey,
    currentPreviewKey,
    status,
    items,
    refreshingUuids,
    plannedCount,
    plannedSlots,
    plannedStages,
    regenerateVoid,
    shuffle,
    refreshSlotVoid,
    toStagedQueueItems,
  ]);
}

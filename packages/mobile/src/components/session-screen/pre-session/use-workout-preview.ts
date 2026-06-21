import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGradesForBoard, toBoardName } from '@boardsesh/board-config';
import { generateWorkoutPlan, type GeneratorGradeScale, type PlannedClimbSlot } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../../providers/toast-provider';
import { fetchGradePool } from './select-climbs-for-plan';
import {
  buildPools,
  refreshSlotInState,
  selectItemsFromPools,
  type FetchGradePool,
  type PreviewFetchContext,
  type PreviewItem,
  type WorkoutPreviewData,
} from './workout-preview-pool';
import type { GeneratorSelection } from './GeneratorPickerCard';

const DEBOUNCE_MS = 300;

export type WorkoutPreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export type UseWorkoutPreviewResult = {
  status: WorkoutPreviewStatus;
  items: PreviewItem[];
  /** Rows currently regenerating (show a spinner, disable the refresh button). */
  refreshingUuids: ReadonlySet<string>;
  /** Slots the generator planned — for the `SessionQueueGenerated.failedCount` delta. */
  plannedCount: number;
  /** Actual generated slot plan, before climb-pool shortfalls remove rows from the preview. */
  plannedSlots: readonly PlannedClimbSlot[];
  regenerate: () => void;
  refreshSlot: (itemUuid: string) => void;
  /** The current preview as a plain queue (the hand-off to `setQueue` on Start). */
  toQueueItems: () => ClimbQueueItem[];
};

type UseWorkoutPreviewDeps = {
  /** Injectable fetcher (tests pass a fake; production defaults to the GraphQL one). */
  fetchPool?: FetchGradePool;
  /** Injectable grade scale (tests bypass board-config). */
  grades?: GeneratorGradeScale;
};

const EMPTY_DATA = (): WorkoutPreviewData => ({ items: [], pools: new Map(), usedUuids: new Set() });

function getSelectionGenerationKey(selection: GeneratorSelection): string {
  if (selection.type !== 'on') return 'off';

  const { options } = selection;
  const commonKey = [
    options.type,
    options.warmUp,
    options.targetGrade,
    options.minAscents,
    options.minRating,
    options.onlyTallClimbs,
    options.onlyWideClimbs,
    options.climbBias,
  ].join(':');

  switch (options.type) {
    case 'volume':
      return `${commonKey}:${options.mainSetClimbs}:${options.mainSetVariability}`;
    case 'pyramid':
    case 'ladder':
      return `${commonKey}:${options.numberOfSteps}:${options.climbsPerStep}`;
    case 'gradeFocus':
      return `${commonKey}:${options.numberOfClimbs}`;
  }
}

function getBoardGenerationKey(board: UserBoard | null): string {
  return board ? `${board.boardType}:${board.layoutId}:${board.sizeId}:${board.setIds}:${board.angle}` : 'none';
}

function getPreviewGenerationKey(
  selection: GeneratorSelection,
  board: UserBoard | null,
  isAuthenticated: boolean,
): string {
  const authKey = isAuthenticated ? 'authenticated' : 'anonymous';
  return `${getSelectionGenerationKey(selection)}|${getBoardGenerationKey(board)}|${authKey}`;
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
  options: { isAuthenticated: boolean },
  deps?: UseWorkoutPreviewDeps,
): UseWorkoutPreviewResult {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const [status, setStatus] = useState<WorkoutPreviewStatus>('idle');
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [refreshingUuids, setRefreshingUuids] = useState<ReadonlySet<string>>(() => new Set());
  const [plannedCount, setPlannedCount] = useState(0);
  const [plannedSlots, setPlannedSlots] = useState<readonly PlannedClimbSlot[]>([]);
  const [committedPreviewKey, setCommittedPreviewKeyState] = useState<string | null>(null);

  // Mutable source of truth the async callbacks read/write without re-rendering.
  const dataRef = useRef<WorkoutPreviewData>(EMPTY_DATA());
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
  const fetchPoolRef = useRef<FetchGradePool>(deps?.fetchPool ?? fetchGradePool);
  fetchPoolRef.current = deps?.fetchPool ?? fetchGradePool;
  const gradesOverrideRef = useRef(deps?.grades);
  gradesOverrideRef.current = deps?.grades;

  const setCommittedPreviewKey = useCallback((nextPreviewKey: string | null) => {
    committedPreviewKeyRef.current = nextPreviewKey;
    setCommittedPreviewKeyState(nextPreviewKey);
  }, []);

  const buildCtx = useCallback((): PreviewFetchContext | null => {
    const currentBoard = boardRef.current;
    const currentSelection = selectionRef.current;
    if (!currentBoard || currentSelection.type !== 'on') return null;
    const { minAscents, minRating, onlyTallClimbs, onlyWideClimbs, climbBias } = currentSelection.options;
    return {
      board: currentBoard,
      isAuthenticated: isAuthRef.current,
      filters: { minAscents, minRating, onlyTallClimbs, onlyWideClimbs, climbBias },
    };
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
      setCommittedPreviewKey(null);
      setItems([]);
      setPlannedCount(0);
      setPlannedSlots([]);
      setStatus(nextStatus);
    },
    [setCommittedPreviewKey],
  );

  const regenerate = useCallback(async () => {
    const currentSelection = selectionRef.current;
    const currentBoard = boardRef.current;
    if (currentSelection.type !== 'on' || !currentBoard) {
      clearPreview('idle');
      return;
    }
    const grades = resolveGrades(currentBoard);
    if (!grades || grades.length === 0) {
      clearPreview('idle');
      return;
    }

    const nextPreviewKey = getPreviewGenerationKey(currentSelection, currentBoard, isAuthRef.current);
    const token = ++genTokenRef.current;
    setStatus('loading'); // keep prior items mounted so the list doesn't jump
    try {
      const plan = generateWorkoutPlan(currentSelection.options, grades);
      const ctx = buildCtx();
      if (!ctx || token !== genTokenRef.current) return; // selection/board changed underneath
      if (plan.length === 0) {
        dataRef.current = EMPTY_DATA();
        setCommittedPreviewKey(nextPreviewKey);
        setItems([]);
        setPlannedCount(0);
        setPlannedSlots([]);
        setStatus('ready');
        return;
      }
      const pools = await buildPools(plan, ctx, fetchPoolRef.current);
      if (token !== genTokenRef.current) return; // superseded by a newer build
      const { items: nextItems, usedUuids } = selectItemsFromPools(plan, pools);
      dataRef.current = { items: nextItems, pools, usedUuids };
      setCommittedPreviewKey(nextPreviewKey);
      setItems(nextItems);
      setPlannedCount(plan.length);
      setPlannedSlots(plan);
      setStatus('ready');
    } catch {
      if (token !== genTokenRef.current) return;
      setStatus('error'); // leave previous items in place
      toastRef.current.showToast(toastRef.current.t('mobile.session.preWorkoutPreviewError'), 'error');
    }
  }, [buildCtx, clearPreview, resolveGrades]);

  const refreshSlot = useCallback(
    async (itemUuid: string) => {
      if (inFlightSlotsRef.current.size > 0) return; // serialize row refreshes to avoid whole-state overwrite races
      const ctx = buildCtx();
      if (!ctx) return;
      const token = genTokenRef.current;
      inFlightSlotsRef.current.add(itemUuid);
      setRefreshingUuids((prev) => new Set(prev).add(itemUuid));
      try {
        const result = await refreshSlotInState(dataRef.current, itemUuid, ctx, fetchPoolRef.current);
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

  const toQueueItems = useCallback(() => {
    const currentPreviewKey = getPreviewGenerationKey(selectionRef.current, boardRef.current, isAuthRef.current);
    if (committedPreviewKeyRef.current !== currentPreviewKey) return [];
    return dataRef.current.items.map((preview) => preview.item);
  }, []);

  // Debounced live rebuild. `off`/no-board clears immediately; a real change
  // schedules a rebuild and supersedes any pending one via the cleared timer.
  const generationKey = useMemo(() => getSelectionGenerationKey(selection), [selection]);
  const authKey = options.isAuthenticated ? 'authenticated' : 'anonymous';
  const boardKey = getBoardGenerationKey(board);
  const currentPreviewKey = useMemo(
    () => getPreviewGenerationKey(selection, board, options.isAuthenticated),
    [selection, board, options.isAuthenticated],
  );

  useEffect(() => {
    if (generationKey === 'off' || boardKey === 'none') {
      void regenerate(); // synchronous clear to idle (reads refs)
      return undefined;
    }
    genTokenRef.current++; // mark existing preview/row refreshes stale during the debounce window
    setStatus('loading');
    const handle = setTimeout(() => void regenerate(), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [generationKey, boardKey, authKey, regenerate]);

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
      items: hasActivePreviewRequest ? items : [],
      refreshingUuids,
      plannedCount: hasActivePreviewRequest && isCommittedPreviewCurrent ? plannedCount : 0,
      plannedSlots: hasActivePreviewRequest && isCommittedPreviewCurrent ? plannedSlots : [],
      regenerate: regenerateVoid,
      refreshSlot: refreshSlotVoid,
      toQueueItems,
    };
  }, [
    generationKey,
    boardKey,
    committedPreviewKey,
    currentPreviewKey,
    status,
    items,
    refreshingUuids,
    plannedCount,
    plannedSlots,
    regenerateVoid,
    refreshSlotVoid,
    toQueueItems,
  ]);
}

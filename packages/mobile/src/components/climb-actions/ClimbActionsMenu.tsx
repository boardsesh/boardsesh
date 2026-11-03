import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { buildPlayDrawerMenuRows, type ClimbMenuGroups } from '../play-drawer/play-drawer-menu-rows';
import {
  boardConfigsMatch,
  useDrawerHost,
  type BoardConfig,
  type ClimbActionsTarget,
} from '../../providers/drawer-host-provider';
import { useQueueData, useActiveClimbUuid } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { useClimbModerationEnabled } from '../../providers/feature-flags-provider';
import { useSprayWallIsArchived } from '../../lib/spray/use-spray-wall-archive';
import { useIsClimbFavorited } from '../../hooks/use-is-climb-favorited';
import { reportHandledError } from '../../lib/error-reporting';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import { usePrivacyScopedState } from '../../hooks/use-privacy-scoped-state';
import { getClimbActionPresenters, openPresentedClimbAction } from './climb-action-presenters';
import { buildClimbMenuItems } from './climb-menu-items';
import { useClimbActions, type ClimbActionId } from './use-climb-actions';

const LIST_GROUPS: ClimbMenuGroups = [
  ['playNext', 'queue', 'replayFromHere'],
  ['playlist', 'favorite', 'tick', 'editEntry', 'share'],
  ['betaVideo', 'edit', 'fork', 'openInApp'],
  ['report', 'delete'],
];
const ALL_BUTTONS_HIDDEN = {
  playNext: true,
  tick: true,
  favorite: true,
  share: true,
  queue: true,
  mirror: true,
  angle: true,
};

type Selection = { target: ClimbActionsTarget; id: ClimbActionId; nonce: number; credentialGeneration: number };

/**
 * The queue and board state a row's menu reads. It changes on every crew queue
 * edit, so it lives in a store, not in a context value: each row subscribes to
 * the one boolean it needs (is this climb on the wall, can this slot be
 * replayed, is this the stored board), and re-renders only when that flips.
 */
type MenuQueueState = {
  activeClimbUuid: string | null | undefined;
  replayableSlots: ReadonlySet<string>;
  activeBoardConfig: BoardConfig | null;
};
type MenuQueueStore = {
  getState: () => MenuQueueState;
  setState: (next: MenuQueueState) => void;
  subscribe: (listener: () => void) => () => void;
};

function createMenuQueueStore(initial: MenuQueueState): MenuQueueStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (next) => {
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The stable half: who is looking, and the one command entry point. */
type MenuRuntime = {
  currentUserId: string | null;
  isAuthenticated: boolean;
  execute: (target: ClimbActionsTarget, id: ClimbActionId) => void;
  queueStore: MenuQueueStore;
};
const MenuRuntimeContext = createContext<MenuRuntime | null>(null);

const EMPTY_SLOTS: ReadonlySet<string> = new Set<string>();
const subscribeToNothing = () => () => undefined;

function useMenuQueueFlag(store: MenuQueueStore | undefined, select: (state: MenuQueueState) => boolean): boolean {
  return useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    () => (store ? select(store.getState()) : false),
    () => false,
  );
}

/** One command host for all row menus: scrolling starts no per-climb requests. */
export function ClimbMenusProvider({
  currentUserId,
  isAuthenticated,
  activeBoardConfig = null,
  children,
}: {
  currentUserId: string | null;
  isAuthenticated: boolean;
  /** The stored active board: a menu on another board can't read its favourite. */
  activeBoardConfig?: BoardConfig | null;
  children: ReactNode;
}) {
  const [selection, setSelection] = usePrivacyScopedState<Selection>(null);
  const nonce = useRef(0);
  const activeClimbUuid = useActiveClimbUuid();
  // The rows `findReplayFromHereItem` replays from: History, in now-slot mode
  // only. Subscribed to the mode itself, so turning it off or on redraws the
  // menus without waiting for a queue edit. Indexed once, not scanned per row.
  const { queue, currentClimbQueueItem, nowSlotMode = false } = useQueueData();
  const replayableSlots = useMemo(() => {
    if (!nowSlotMode) return EMPTY_SLOTS;
    const currentIndex = queue.findIndex((item) => item.uuid === currentClimbQueueItem?.uuid);
    if (currentIndex <= 0) return EMPTY_SLOTS;
    return new Set(queue.slice(0, currentIndex).map((item) => item.uuid));
  }, [queue, currentClimbQueueItem, nowSlotMode]);
  const queueState = useMemo<MenuQueueState>(
    () => ({ activeClimbUuid, replayableSlots, activeBoardConfig }),
    [activeClimbUuid, replayableSlots, activeBoardConfig],
  );
  const [queueStore] = useState(() => createMenuQueueStore(queueState));
  // Before paint, so a row never draws a menu one queue state behind.
  useLayoutEffect(() => queueStore.setState(queueState), [queueStore, queueState]);
  const execute = useCallback(
    (target: ClimbActionsTarget, id: ClimbActionId) => {
      nonce.current += 1;
      setSelection({ target, id, nonce: nonce.current, credentialGeneration: getCredentialGeneration() });
    },
    [setSelection],
  );
  const complete = useCallback(() => setSelection(null), [setSelection]);
  const runtime = useMemo(
    () => ({ currentUserId, isAuthenticated, execute, queueStore }),
    [currentUserId, isAuthenticated, execute, queueStore],
  );
  return (
    <MenuRuntimeContext.Provider value={runtime}>
      {children}
      {selection ? (
        <ClimbActionExecutor
          key={selection.nonce}
          selection={selection}
          currentUserId={currentUserId}
          isAuthenticated={isAuthenticated}
          onComplete={complete}
        />
      ) : null}
    </MenuRuntimeContext.Provider>
  );
}

function ClimbActionExecutor({
  selection,
  currentUserId,
  isAuthenticated,
  onComplete,
}: {
  selection: Selection;
  currentUserId: string | null;
  isAuthenticated: boolean;
  onComplete: () => void;
}) {
  const [target, setTarget] = useState<ClimbActionsTarget | null>(
    selection.target.resolveClimb ? null : selection.target,
  );
  useEffect(() => {
    const resolve = selection.target.resolveClimb;
    if (!resolve) return;
    let active = true;
    void resolve()
      .then((climb) => {
        if (!active || selection.credentialGeneration !== getCredentialGeneration()) return;
        if (climb) setTarget({ ...selection.target, climb });
        else onComplete();
      })
      .catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'climb-menu', op: 'resolve' } });
        if (active) onComplete();
      });
    return () => {
      active = false;
    };
  }, [selection, onComplete]);
  return target ? (
    <ClimbActionRunner
      selection={selection}
      target={target}
      currentUserId={currentUserId}
      isAuthenticated={isAuthenticated}
      onComplete={onComplete}
    />
  ) : null;
}

function ClimbActionRunner({
  selection,
  target,
  currentUserId,
  isAuthenticated,
  onComplete,
}: {
  selection: Selection;
  target: ClimbActionsTarget;
  currentUserId: string | null;
  isAuthenticated: boolean;
  onComplete: () => void;
}) {
  const { openAddToPlaylist } = useDrawerHost();
  // Only a menu opened inside `/play` (it carries the route's dismiss waiter)
  // hands its sheets to the player. A modal route that hosts its own playlist
  // sheet (the moderation feed) gets Add to playlist there; anything else
  // presents from the root as it always did.
  const presenters = target.dismissPlayerAndWait ? getClimbActionPresenters() : null;
  const selectPlaylist = useCallback(() => {
    if (presenters) openPresentedClimbAction(presenters, 'playlist', target);
    else if (target.openPlaylistInRoute) target.openPlaylistInRoute(target.climb, target.boardConfig);
    else openAddToPlaylist(target.climb, target.boardConfig);
    onComplete();
  }, [openAddToPlaylist, target, onComplete, presenters]);
  const items = useClimbActions({
    ...target,
    currentUserId,
    isAuthenticated,
    onSelectPlaylist: selectPlaylist,
    onAfterAction: onComplete,
    resolveFavoriteOnAction: true,
    onTick: presenters ? () => openPresentedClimbAction(presenters, 'tick', target) : undefined,
    onAddBetaVideo: presenters ? () => openPresentedClimbAction(presenters, 'beta', target) : undefined,
    onReportClimb: presenters ? () => openPresentedClimbAction(presenters, 'report', target) : undefined,
  });
  const executed = useRef(false);
  useEffect(() => {
    if (executed.current) return;
    executed.current = true;
    if (selection.credentialGeneration !== getCredentialGeneration()) {
      onComplete();
      return;
    }
    const action = items.find((item) => item.id === selection.id);
    if (action) action.run();
    else onComplete();
  }, [items, selection.id, selection.credentialGeneration, onComplete]);
  return null;
}

export function useClimbMenu(target: ClimbActionsTarget | null) {
  const runtime = useContext(MenuRuntimeContext);
  const { t } = useTranslation('climbs');
  const { actionColors } = useTheme();
  const moderationEnabled = useClimbModerationEnabled();
  const wallArchived = useSprayWallIsArchived(target?.boardConfig.boardName, target?.boardConfig.layoutId ?? null);
  const favorited = useIsClimbFavorited(target?.climb.uuid ?? '');
  const queueStore = runtime?.queueStore;
  const climbUuid = target?.climb.uuid;
  const queueItemUuid = target?.queueItemUuid;
  const board = target?.boardConfig ?? null;
  const isActiveClimb = useMenuQueueFlag(queueStore, (state) => !!climbUuid && state.activeClimbUuid === climbUuid);
  const canReplay = useMenuQueueFlag(
    queueStore,
    (state) => !!queueItemUuid && state.replayableSlots.has(queueItemUuid),
  );
  const onActiveBoard = useMenuQueueFlag(queueStore, (state) => boardConfigsMatch(board, state.activeBoardConfig));
  const currentUserId = runtime?.currentUserId ?? null;
  const isAuthenticated = runtime?.isAuthenticated ?? false;
  const execute = runtime?.execute;
  const rows = useMemo(() => {
    if (!target || !execute) return [];
    const items = buildClimbMenuItems(
      { ...target, currentUserId, isAuthenticated },
      {
        t,
        actionColors,
        activeClimbUuid: isActiveClimb ? target.climb.uuid : null,
        wallArchived,
        moderationEnabled,
        isFavorited: onActiveBoard && favorited,
        canReplay,
      },
      (id) => execute(target, id),
    );
    return buildPlayDrawerMenuRows(items, {
      hidden: ALL_BUTTONS_HIDDEN,
      boardMismatch: false,
      isActiveClimb,
      groups: LIST_GROUPS,
    });
  }, [
    target,
    execute,
    currentUserId,
    isAuthenticated,
    t,
    actionColors,
    isActiveClimb,
    wallArchived,
    moderationEnabled,
    onActiveBoard,
    favorited,
    canReplay,
  ]);
  const onSelectIndex = useCallback(
    (index: number) => {
      const row = rows[index];
      if (row && !row.disabled) row.run();
    },
    [rows],
  );
  const accessibilityActions = useMemo(
    () => rows.filter((row) => !row.disabled).map((row) => ({ name: row.id, label: row.label })),
    [rows],
  );
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const onAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    const row = latestRows.current.find((item) => item.id === event.nativeEvent.actionName);
    if (row && !row.disabled) row.run();
  }, []);
  const menuKey = `${getCredentialGeneration()}|${currentUserId}|${climbUuid}|${board?.boardName}|${board?.layoutId}|${board?.sizeId}|${board?.setIds}|${board?.angle}|${queueItemUuid}|${rows.map((row) => `${row.id}:${row.disabled}`).join(',')}`;
  return { rows, onSelectIndex, menuKey, accessibilityActions, onAccessibilityAction };
}

export { ClimbMenu } from './ClimbMenu';

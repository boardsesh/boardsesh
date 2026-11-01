import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { buildPlayDrawerMenuRows, type ClimbMenuGroups } from '../play-drawer/play-drawer-menu-rows';
import { boardConfigsMatch, useDrawerHost, type ClimbActionsTarget } from '../../providers/drawer-host-provider';
import { useQueueActions, useQueueData, useActiveClimbUuid } from '../../providers/queue-provider';
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
  ['preview', 'playNext', 'queue', 'replayFromHere'],
  ['playlist', 'favorite', 'tick', 'editEntry', 'share'],
  ['betaVideo', 'edit', 'fork', 'openInApp'],
  ['report', 'delete'],
];
const ALL_BUTTONS_HIDDEN = { tick: true, favorite: true, share: true, queue: true, mirror: true, angle: true };

type Selection = { target: ClimbActionsTarget; id: ClimbActionId; nonce: number; credentialGeneration: number };
type MenuRuntime = {
  currentUserId: string | null;
  isAuthenticated: boolean;
  activeClimbUuid: string | null | undefined;
  replayableSlots: ReadonlySet<string>;
  execute: (target: ClimbActionsTarget, id: ClimbActionId) => void;
};
const MenuRuntimeContext = createContext<MenuRuntime | null>(null);

/** One command host for all row menus: scrolling starts no per-climb requests. */
export function ClimbMenusProvider({
  currentUserId,
  isAuthenticated,
  children,
}: {
  currentUserId: string | null;
  isAuthenticated: boolean;
  children: ReactNode;
}) {
  const [selection, setSelection] = usePrivacyScopedState<Selection>(null);
  const nonce = useRef(0);
  const activeClimbUuid = useActiveClimbUuid();
  const { queue, currentClimbQueueItem } = useQueueData();
  const { findReplayFromHereItem } = useQueueActions();
  const replayableSlots = useMemo(() => {
    const currentIndex = queue.findIndex((item) => item.uuid === currentClimbQueueItem?.uuid);
    // Check the queue mode once, then index History once instead of scanning per row.
    if (currentIndex <= 0 || !findReplayFromHereItem(queue[0].uuid)) return new Set<string>();
    return new Set(queue.slice(0, currentIndex).map((item) => item.uuid));
  }, [queue, currentClimbQueueItem, findReplayFromHereItem]);
  const execute = useCallback(
    (target: ClimbActionsTarget, id: ClimbActionId) => {
      nonce.current += 1;
      setSelection({ target, id, nonce: nonce.current, credentialGeneration: getCredentialGeneration() });
    },
    [setSelection],
  );
  const complete = useCallback(() => setSelection(null), [setSelection]);
  const runtime = useMemo(
    () => ({ currentUserId, isAuthenticated, activeClimbUuid, replayableSlots, execute }),
    [currentUserId, isAuthenticated, activeClimbUuid, replayableSlots, execute],
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
  const presenters = getClimbActionPresenters();
  const selectPlaylist = useCallback(() => {
    if (presenters) openPresentedClimbAction(presenters, 'playlist', target);
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
  const { boardConfig: activeBoardConfig } = useDrawerHost();
  const rows = useMemo(() => {
    if (!target || !runtime) return [];
    const items = buildClimbMenuItems(
      {
        ...target,
        currentUserId: runtime.currentUserId,
        isAuthenticated: runtime.isAuthenticated,
        onSelectPlaylist: () => {},
      },
      {
        t,
        actionColors,
        activeClimbUuid: runtime.activeClimbUuid,
        wallArchived,
        moderationEnabled,
        isFavorited: boardConfigsMatch(target.boardConfig, activeBoardConfig) && favorited,
        canReplay: !!target.queueItemUuid && runtime.replayableSlots.has(target.queueItemUuid),
      },
      (id) => runtime.execute(target, id),
    );
    return buildPlayDrawerMenuRows(items, {
      hidden: ALL_BUTTONS_HIDDEN,
      boardMismatch: false,
      isActiveClimb: target.climb.uuid === runtime.activeClimbUuid,
      groups: LIST_GROUPS,
    });
  }, [target, runtime, t, actionColors, wallArchived, moderationEnabled, activeBoardConfig, favorited]);
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
  const board = target?.boardConfig;
  const menuKey = `${getCredentialGeneration()}|${runtime?.currentUserId}|${target?.climb.uuid}|${board?.boardName}|${board?.layoutId}|${board?.sizeId}|${board?.setIds}|${board?.angle}|${target?.queueItemUuid}|${rows.map((row) => `${row.id}:${row.disabled}`).join(',')}`;
  return { rows, onSelectIndex, menuKey, accessibilityActions, onAccessibilityAction };
}

export { ClimbMenu } from './ClimbMenu';

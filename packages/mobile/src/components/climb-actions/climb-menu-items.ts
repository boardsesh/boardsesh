import type { TFunction } from 'i18next';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { getBoardCapabilities, toAuroraBoardName } from '@boardsesh/board-config';
import { canEditClimb } from '@boardsesh/create-climb-react';
import type { useTheme } from '../../providers/theme-provider';
import { ownClimbIsReportable } from '../play-drawer/can-report-climb';
import { canDeleteClimb } from './delete-climb-rules';
import type { ClimbActionId, ClimbActionItem, UseClimbActionsArgs } from './use-climb-actions';

export type ClimbMenuState = {
  t: TFunction<'climbs'>;
  actionColors: ReturnType<typeof useTheme>['actionColors'];
  activeClimbUuid: string | null | undefined;
  wallArchived: boolean;
  moderationEnabled: boolean;
  isFavorited?: boolean;
  canReplay: boolean;
};

function buildAuroraAppUrl(boardName: AuroraBoardName, climbUuid: string): string | null {
  if (boardName === 'kilter') return null;
  const suffix = boardName === 'tension' ? '2' : '';
  return `https://${boardName}boardapp${suffix}.com/climbs/${climbUuid}`;
}

/** Metadata is ready before a native long press; commands execute only after selection. */
export function buildClimbMenuItems(
  args: UseClimbActionsArgs,
  state: ClimbMenuState,
  dispatch: (id: ClimbActionId) => void,
): ClimbActionItem[] {
  const {
    climb,
    boardConfig,
    currentUserId,
    isAuthenticated,
    onEditEntry,
    onOpenQueue,
    onOpenViewOptions,
    mirrorControl,
    onOpenAngle,
    favoriteControl,
  } = args;
  const { t, actionColors, activeClimbUuid, wallArchived, moderationEnabled, canReplay } = state;
  const isFavorited = favoriteControl?.isFavorited ?? state.isFavorited;
  const toggleFavoriteOverride = favoriteControl?.onToggle;
  if (!climb || !boardConfig) return [];

  const { boardName } = boardConfig;
  const { success: successColor, favorite: favoriteColor, accent: accentColor } = actionColors;

  const auroraBoardName = getBoardCapabilities(boardName).auroraAppLink ? toAuroraBoardName(boardName) : null;
  const auroraAppUrl = auroraBoardName ? buildAuroraAppUrl(auroraBoardName, climb.uuid) : null;

  const canEdit =
    getBoardCapabilities(boardName).climbCreation &&
    !wallArchived &&
    canEditClimb({ climb, boardType: boardName, currentUserId });

  const items: ClimbActionItem[] = [];

  if (climb.uuid !== activeClimbUuid) {
    items.push({
      id: 'playNext',
      title: t('mobile.climbActions.playNext'),
      icon: 'queue.next',
      color: accentColor,
      run: () => dispatch('playNext'),
    });
  }

  items.push({
    id: 'queue',
    title: t('mobile.climbActions.playLast'),
    icon: 'queue.last',
    color: successColor,
    run: () => dispatch('queue'),
  });

  if (onOpenQueue) {
    items.push({
      id: 'openQueue',
      title: t('mobile.climbActions.openQueue'),
      icon: 'queue',
      color: accentColor,
      run: () => dispatch('openQueue'),
    });
  }

  const replayItem = canReplay;
  if (replayItem) {
    items.push({
      id: 'replayFromHere',
      title: t('mobile.climbActions.replayFromHere'),
      icon: 'history',
      color: accentColor,
      run: () => dispatch('replayFromHere'),
    });
  }

  if (mirrorControl) {
    items.push({
      id: 'mirror',
      title: mirrorControl.isMirrored
        ? t('session:playView.actionBar.unmirrorAria')
        : t('session:playView.actionBar.mirrorAria'),
      icon: 'mirror',
      color: accentColor,
      run: () => dispatch('mirror'),
    });
  }

  if (onOpenAngle) {
    items.push({
      id: 'angle',
      title: t('session:playView.actionBar.changeAngle'),
      icon: 'angle',
      color: accentColor,
      run: () => dispatch('angle'),
    });
  }

  items.push({
    id: 'playlist',
    title: t('actions.playlist.popover.title'),
    icon: 'playlist',
    color: accentColor,

    run: () => dispatch('playlist'),
  });

  items.push({
    id: 'favorite',

    title: !toggleFavoriteOverride
      ? t('mobile.climbRow.toggleFavorite')
      : isFavorited
        ? t('session:playView.actionBar.removeFavoriteAria')
        : t('session:playView.actionBar.addFavoriteAria'),
    icon: isFavorited ? 'favorite.fill' : 'favorite',
    color: favoriteColor,
    run: () => dispatch('favorite'),
  });

  items.push({
    id: 'tick',
    title: t('mobile.climbActions.tick'),
    icon: 'tick',
    color: successColor,
    run: () => dispatch('tick'),
  });

  if (onEditEntry) {
    items.push({
      id: 'editEntry',
      title: t('mobile.climbActions.editEntry'),
      icon: 'edit',
      color: accentColor,
      run: () => dispatch('editEntry'),
    });
  }

  if (isAuthenticated) {
    items.push({
      id: 'betaVideo',
      title: t('mobile.climbActions.addBetaVideo'),
      icon: 'video',
      color: accentColor,
      run: () => dispatch('betaVideo'),
    });
  }

  if (canEdit) {
    items.push({
      id: 'edit',
      title: t('mobile.climbActions.edit'),
      icon: 'edit',
      color: accentColor,

      run: () => dispatch('edit'),
    });
  }

  if (getBoardCapabilities(boardName).climbCreation && !wallArchived) {
    items.push({
      id: 'fork',
      title: t('mobile.climbActions.fork'),
      icon: 'branch',
      color: accentColor,

      run: () => dispatch('fork'),
    });
  }

  if (onOpenViewOptions) {
    items.push({
      id: 'viewOptions',
      title: t('common:mobile.settings.climbDrawer.sheetTitle'),
      icon: 'view.options',
      color: accentColor,
      run: () => dispatch('viewOptions'),
    });
  }

  const isDraft = climb.is_draft === true;
  if (!isDraft) {
    items.push({
      id: 'share',
      title: t('share.actionLabel'),
      icon: 'share',
      color: accentColor,
      run: () => dispatch('share'),
    });
  }

  if (auroraAppUrl) {
    items.push({
      id: 'openInApp',
      title: t('mobile.climbActions.openInApp'),
      icon: 'open.external',
      color: accentColor,
      run: () => dispatch('openInApp'),
    });
  }

  const isOwnClimb = !!currentUserId && climb.userId === currentUserId;
  const reportable = climb.is_draft !== true && (!isOwnClimb || ownClimbIsReportable(boardName));
  if (isAuthenticated && moderationEnabled && reportable) {
    items.push({
      id: 'report',

      title: isOwnClimb ? t('mobile.climbActions.changeGrade') : t('mobile.climbActions.report'),
      icon: 'flag',
      color: accentColor,
      run: () => dispatch('report'),
    });
  }

  if (canDeleteClimb({ climb, boardName, currentUserId, wallArchived })) {
    items.push({
      id: 'delete',
      title: t('mobile.climbActions.deleteClimb.row'),
      icon: 'delete',
      color: accentColor,
      run: () => dispatch('delete'),
    });
  }

  return items;
}

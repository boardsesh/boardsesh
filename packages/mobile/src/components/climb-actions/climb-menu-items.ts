// The one place that decides which climb actions a menu offers, in what order,
// and how each row reads (label, icon, colour). Every climb menu goes through
// it: the row long-press and list ellipsis build their rows here before a hold
// (`useClimbMenu`), and the command host builds the same rows again after a
// selection to run one (`useClimbActions`), so a row can never show on one side
// and be missing on the other. The commands themselves live in
// `useClimbActions`; nothing here runs one.
//
// Menus offer no Preview: every list tap already opens one.
import type { TFunction } from 'i18next';
import type { AuroraBoardName, Climb } from '@boardsesh/shared-schema';
import { getBoardCapabilities, toAuroraBoardName } from '@boardsesh/board-config';
import { canEditClimb } from '@boardsesh/create-climb-react';
import type { useTheme } from '../../providers/theme-provider';
import { ownClimbIsReportable } from '../play-drawer/can-report-climb';
import { canDeleteClimb } from './delete-climb-rules';
import type { ClimbActionId, ClimbActionItem, UseClimbActionsArgs } from './use-climb-actions';

/** What a menu is built for: the climb, its board, and the caller's optional rows. */
export type ClimbMenuArgs = Pick<
  UseClimbActionsArgs,
  | 'climb'
  | 'boardConfig'
  | 'currentUserId'
  | 'isAuthenticated'
  | 'onEditEntry'
  | 'onOpenQueue'
  | 'onOpenViewOptions'
  | 'mirrorControl'
  | 'onOpenAngle'
  | 'favoriteControl'
>;

export type ClimbMenuState = {
  t: TFunction<'climbs'>;
  actionColors: ReturnType<typeof useTheme>['actionColors'];
  activeClimbUuid: string | null | undefined;
  wallArchived: boolean;
  moderationEnabled: boolean;
  isFavorited?: boolean;
  /** The menu is for a History slot that Replay from here can step back to. */
  canReplay: boolean;
};

// Mirrors web's constructClimbInfoUrl: Kilter no longer has a public app URL.
// Aurora-only by construction: the board must have the auroraAppLink capability,
// so a code-driven board (MoonBoard, Woods) never gets an invented domain.
function buildAuroraAppUrl(boardName: AuroraBoardName, climbUuid: string): string | null {
  if (boardName === 'kilter') return null;
  const suffix = boardName === 'tension' ? '2' : '';
  return `https://${boardName}boardapp${suffix}.com/climbs/${climbUuid}`;
}

/** The official app page for this climb, when its board has one. */
export function climbAuroraAppUrl(boardName: string, climb: Pick<Climb, 'uuid'>): string | null {
  const auroraBoardName = getBoardCapabilities(boardName).auroraAppLink ? toAuroraBoardName(boardName) : null;
  return auroraBoardName ? buildAuroraAppUrl(auroraBoardName, climb.uuid) : null;
}

/** Metadata is ready before a native long press; commands execute only after selection. */
export function buildClimbMenuItems(
  args: ClimbMenuArgs,
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
  if (!climb || !boardConfig) return [];

  const { boardName } = boardConfig;
  const { success: successColor, favorite: favoriteColor, accent: accentColor } = actionColors;
  // A caller-owned favourite (the player's heart) knows its state for certain.
  const isFavorited = favoriteControl ? favoriteControl.isFavorited : state.isFavorited;
  // Fork drops into the create-climb editor, so it only appears on boards that
  // can have climbs set on them, and never on an archived wall (the server
  // refuses every edit and new climb there).
  const canCreate = getBoardCapabilities(boardName).climbCreation && !wallArchived;
  // Who may edit is one shared rule (`canEditClimb`): the setter, a draft for
  // good and a published climb for 24 hours, on every board a spray wall
  // included. A hint only; the server decides.
  const canEdit = canCreate && canEditClimb({ climb, boardType: boardName, currentUserId });

  const items: ClimbActionItem[] = [];
  const push = (id: ClimbActionId, title: string, icon: ClimbActionItem['icon'], color: ClimbActionItem['color']) =>
    items.push({ id, title, icon, color, run: () => dispatch(id) });

  // "Play next" is meaningless on the climb already on the wall, so it is hidden
  // there rather than shown as a no-op. It sits right above Play last: the two
  // placements read as a pair, the way a music app offers them (#6772).
  if (climb.uuid !== activeClimbUuid) {
    push('playNext', t('mobile.climbActions.playNext'), 'queue.next', accentColor);
  }
  // Play last: the bottom of Up next, today's plain add.
  push('queue', t('mobile.climbActions.playLast'), 'queue.last', successColor);
  if (onOpenQueue) push('openQueue', t('mobile.climbActions.openQueue'), 'queue', accentColor);
  // Replay from here (F3, decision 8): a History row, while a climb is on the
  // wall and only in now-slot mode.
  if (canReplay) push('replayFromHere', t('mobile.climbActions.replayFromHere'), 'history', accentColor);
  if (mirrorControl) {
    push(
      'mirror',
      mirrorControl.isMirrored
        ? t('session:playView.actionBar.unmirrorAria')
        : t('session:playView.actionBar.mirrorAria'),
      'mirror',
      accentColor,
    );
  }
  if (onOpenAngle) push('angle', t('session:playView.actionBar.changeAngle'), 'angle', accentColor);
  push('playlist', t('actions.playlist.popover.title'), 'playlist', accentColor);
  // The label says which way the row goes, for a screen reader as much as for
  // sight. A caller-owned favourite knows both ways. A menu's own read is sure
  // only of a favourite: the store holds favourites, so a miss can also mean the
  // climb's status hasn't loaded, and that row keeps the neutral label.
  const favoriteLabel = isFavorited
    ? t('session:playView.actionBar.removeFavoriteAria')
    : favoriteControl
      ? t('session:playView.actionBar.addFavoriteAria')
      : t('mobile.climbRow.toggleFavorite');
  push('favorite', favoriteLabel, isFavorited ? 'favorite.fill' : 'favorite', favoriteColor);
  push('tick', t('mobile.climbActions.tick'), 'tick', successColor);
  if (onEditEntry) push('editEntry', t('mobile.climbActions.editEntry'), 'edit', accentColor);
  if (isAuthenticated) push('betaVideo', t('mobile.climbActions.addBetaVideo'), 'video', accentColor);
  if (canEdit) push('edit', t('mobile.climbActions.edit'), 'edit', accentColor);
  if (canCreate) push('fork', t('mobile.climbActions.fork'), 'branch', accentColor);
  if (onOpenViewOptions) {
    push('viewOptions', t('common:mobile.settings.climbDrawer.sheetTitle'), 'view.options', accentColor);
  }
  // A draft is visible to its setter alone, so a link to it opens nowhere for
  // anyone it is sent to (#5960).
  const isDraft = climb.is_draft === true;
  if (!isDraft) push('share', t('share.actionLabel'), 'share', accentColor);
  // Only boards with an official app page get the row.
  if (climbAuroraAppUrl(boardName, climb)) {
    push('openInApp', t('mobile.climbActions.openInApp'), 'open.external', accentColor);
  }
  // Last in the list, and last for a reason: it is the one action that acts
  // AGAINST the climb, so it sits below everything a climber came here to do.
  // Not on the viewer's own climb: reporting yourself to the crew has no
  // outcome, and the setter already has Edit for anything they want changed.
  // Except on a spray wall, where a grade proposal is how the setter changes
  // their own climb's grade (#5971). A draft is never reported.
  const isOwnClimb = !!currentUserId && climb.userId === currentUserId;
  const reportable = !isDraft && (!isOwnClimb || ownClimbIsReportable(boardName));
  if (isAuthenticated && moderationEnabled && reportable) {
    push(
      'report',
      isOwnClimb ? t('mobile.climbActions.changeGrade') : t('mobile.climbActions.report'),
      'flag',
      accentColor,
    );
  }
  // The setter's own published spray climb (#5960). Below Report, which the
  // setter never sees on their own climb, so it is the last row either way.
  if (canDeleteClimb({ climb, boardName, currentUserId, wallArchived })) {
    push('delete', t('mobile.climbActions.deleteClimb.row'), 'delete', accentColor);
  }

  return items;
}

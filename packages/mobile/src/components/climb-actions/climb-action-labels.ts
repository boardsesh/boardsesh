// Title and icon for each climb action, shared by the reaction overlay
// (`useClimbActions`) and the iOS native context menu (`ClimbContextMenu`), so a
// relabel lands in both.

import type { TFunction } from 'i18next';
import type { IconName } from '../icon-map';
import type { ClimbActionId } from './climb-action-gating';

/** The action's label in the `climbs` namespace. `ownClimb` turns Report into
 *  "Change grade": on your own spray climb a report is how you regrade it (#5971). */
export function climbActionTitle(id: ClimbActionId, t: TFunction<'climbs'>, ownClimb: boolean): string {
  switch (id) {
    case 'preview':
      return t('mobile.climbActions.preview');
    case 'queue':
      return t('mobile.climbRow.addToQueue');
    case 'openQueue':
      return t('mobile.climbActions.openQueue');
    case 'playNext':
      return t('mobile.climbActions.playNext');
    case 'playlist':
      return t('actions.playlist.popover.title');
    case 'favorite':
      return t('mobile.climbRow.toggleFavorite');
    case 'tick':
      return t('mobile.climbActions.tick');
    case 'editEntry':
      return t('mobile.climbActions.editEntry');
    case 'betaVideo':
      return t('mobile.climbActions.addBetaVideo');
    case 'edit':
      return t('mobile.climbActions.edit');
    case 'fork':
      return t('mobile.climbActions.fork');
    case 'share':
      return t('share.actionLabel');
    case 'openInApp':
      return t('mobile.climbActions.openInApp');
    case 'report':
      return ownClimb ? t('mobile.climbActions.changeGrade') : t('mobile.climbActions.report');
    case 'delete':
      return t('mobile.climbActions.deleteClimb.row');
  }
}

/** The action's app icon. Favourite is the outline heart here; the overlay fills it
 *  once it knows the climb is favourited. */
export const CLIMB_ACTION_ICONS: Readonly<Record<ClimbActionId, IconName>> = {
  preview: 'visibility',
  queue: 'add',
  openQueue: 'queue',
  playNext: 'queue.next',
  playlist: 'playlist',
  favorite: 'favorite',
  tick: 'tick',
  editEntry: 'edit',
  betaVideo: 'video',
  edit: 'edit',
  fork: 'branch',
  share: 'share',
  openInApp: 'open.external',
  report: 'flag',
  delete: 'delete',
};

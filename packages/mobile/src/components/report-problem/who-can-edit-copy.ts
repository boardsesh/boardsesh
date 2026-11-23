// The sentences under "You can't edit this board / gym" (design §4.4), built
// from what is true about it. Pure, so a table test pins every branch.

import { boardOriginFor, type Gym, type UserBoard } from '@boardsesh/shared-schema';

type TFn = (key: string, options?: Record<string, unknown>) => string;

/** The lines under "You can't edit this board", from what is true about it. */
export function boardWhoCanEditBody(
  board: Pick<UserBoard, 'ownerId' | 'ownerDisplayName'>,
  gym: Pick<Gym, 'name' | 'listingState'> | null,
  viewerUserId: string | null,
  t: TFn,
): string {
  const origin = boardOriginFor(board, viewerUserId);
  const runByGym = gym?.listingState === 'RUN_BY_GYM';
  const lines: string[] = [];
  if (origin === 'synced') {
    if (gym && !runByGym) {
      lines.push(t('whoCanEdit.boardSynced', { gym: gym.name }));
    } else {
      lines.push(t('whoCanEdit.boardSyncedNoGym'));
      if (gym) lines.push(t('whoCanEdit.boardStaff', { gym: gym.name }));
    }
    return lines.join(' ');
  }
  lines.push(
    origin === 'climber' && board.ownerDisplayName
      ? t('whoCanEdit.boardCreator', { name: board.ownerDisplayName })
      : t('whoCanEdit.boardCreatorHidden'),
  );
  if (gym && runByGym) lines.push(t('whoCanEdit.boardStaff', { gym: gym.name }));
  return lines.join(' ');
}

/** The lines under "You can't edit this gym". */
export function gymWhoCanEditBody(
  gym: Pick<Gym, 'name' | 'listingState' | 'ownerDisplayName' | 'canClaim'>,
  t: TFn,
): string {
  const lines: string[] = [];
  if (gym.listingState === 'RUN_BY_GYM') lines.push(t('whoCanEdit.gymStaff', { gym: gym.name }));
  else if (gym.listingState === 'CLIMBER_LISTED') {
    lines.push(
      gym.ownerDisplayName
        ? t('whoCanEdit.gymClimber', { name: gym.ownerDisplayName })
        : t('whoCanEdit.gymClimberHidden'),
    );
  } else lines.push(t('whoCanEdit.gymUnclaimed'));
  if (gym.canClaim) lines.push(t('whoCanEdit.claimHint'));
  return lines.join(' ');
}

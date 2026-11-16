import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardCardMenuLabels } from './board-card-menu';

/**
 * The card menu's row labels, resolved once per carousel. Memoized on the
 * resolved strings rather than on `t`, whose identity is not something a whole
 * rail of memoized cards should hang on.
 */
export function useBoardCardMenuLabels(): BoardCardMenuLabels {
  const { t } = useTranslation('boards');
  const climbHere = t('mobile.discovery.menu.climbHere');
  const pin = t('mobile.discovery.menu.pin');
  const unpin = t('mobile.discovery.menu.unpin');
  const download = t('mobile.discovery.menu.download');
  const details = t('mobile.boardDetail.details');
  const edit = t('mobile.discovery.menu.edit');
  const editWall = t('mobile.discovery.menu.editWall');
  const unfollow = t('mobile.manage.unfollowConfirm');
  const deleteLabel = t('mobile.manage.deleteConfirm');
  return useMemo(
    () => ({ climbHere, pin, unpin, download, details, edit, editWall, unfollow, delete: deleteLabel }),
    [climbHere, pin, unpin, download, details, edit, editWall, unfollow, deleteLabel],
  );
}

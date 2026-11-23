import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardCardMenuLabels } from './board-card-menu';

/**
 * Stands in for the gym name while "Remove from {{gym}}" is resolved once, so
 * each row fills in its own gym without a `t` call per row. A NUL pair cannot
 * occur in a translation or a gym name.
 */
const GYM_SLOT = '\u0000gym\u0000';

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
  const removeFromGym = t('gymBoards.remove');
  const removeFromNamedGymTemplate = t('gymBoards.removeFromNamed', {
    gym: GYM_SLOT,
    interpolation: { escapeValue: false },
  });
  const unfollow = t('mobile.manage.unfollowRow');
  const deleteLabel = t('mobile.manage.deleteConfirm');
  const reviewReports = t('reportReview.open');
  const report = t('report.action');
  const reported = t('report.reported');
  return useMemo(
    () => ({
      climbHere,
      pin,
      unpin,
      download,
      details,
      edit,
      editWall,
      removeFromGym,
      removeFromNamedGym: (gymName: string) => removeFromNamedGymTemplate.split(GYM_SLOT).join(gymName),
      unfollow,
      delete: deleteLabel,
      reviewReports,
      report,
      reported,
    }),
    [
      climbHere,
      pin,
      unpin,
      download,
      details,
      edit,
      editWall,
      removeFromGym,
      removeFromNamedGymTemplate,
      unfollow,
      deleteLabel,
      reviewReports,
      report,
      reported,
    ],
  );
}

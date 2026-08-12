// "You have no signal and this board isn't on your phone." The two screens that
// detect that state — the boards picker and the climbs list — used to end there.
//
// An affordance, not a prompt: it lives inside a screen the user chose to look
// at, in place of a dead end, so it carries no cooldown and no lifetime cap.
// Capping it would mean the empty state reverts to the dead end this set out to
// fix, possibly the day after an unrelated post-session prompt.
//
// ARM-ONLY. It never calls triggerSync. onlineManager.isOnline() is TRUE on
// captive-portal wifi — the exact case the boards picker's `isError && no
// cached boards` branch detects — so a cycle kicked from here would run, fail,
// and spend one of the two MAX_BOOTSTRAP_ATTEMPTS per tap, pinning the scope to
// the multi-minute paged crawl after two (#4313). The scheduler's own
// connectivity trigger pulls the board the moment the device reconnects.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { StyleProp, ViewStyle } from 'react-native';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useOfflineNudge } from '../../lib/offline-nudges/use-offline-nudge';
import { useConfirmBoardDownload } from '../../offline/use-confirm-board-download';
import { useToast } from '../../providers/toast-provider';
import { OfflineNudgeCard } from './OfflineNudgeCard';

type OfflineCatalogCtaProps = {
  /** The board whose catalog is missing. Usually the active board. */
  board: UserBoard | null | undefined;
  style?: StyleProp<ViewStyle>;
};

export function OfflineCatalogCta({ board, style }: OfflineCatalogCtaProps) {
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const { armWithoutConfirm } = useConfirmBoardDownload();
  const nudge = useOfflineNudge({ surface: 'no_catalog', board });

  const handleArm = useCallback(() => {
    if (!board) return;
    nudge.accept();
    armWithoutConfirm(board);
    // Say what actually happens. Nothing downloads yet, and a toast that implied
    // otherwise is the most likely source of "it said it downloaded and it
    // didn't" feedback.
    showToast(t('mobile.offline.nudge.noCatalog.armedToast', { name: board.name }), 'success');
  }, [board, nudge, armWithoutConfirm, showToast, t]);

  if (!nudge.visible || !board) return null;

  return (
    <OfflineNudgeCard
      testID="offline-catalog-cta"
      title={t('mobile.offline.nudge.noCatalog.title')}
      body={t('mobile.offline.nudge.noCatalog.body', { name: board.name })}
      primaryLabel={t('mobile.offline.nudge.noCatalog.cta')}
      onPrimary={handleArm}
      style={style}
    />
  );
}

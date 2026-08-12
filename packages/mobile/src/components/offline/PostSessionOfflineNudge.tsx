// The post-session offer: you just climbed here, keep the catalog on your phone.
//
// The only INTERRUPTIVE nudge in the set — the user asked for a session recap,
// not for this — so it is the only one that carries the cooldown / lifetime cap
// machinery, and the only one that stands down for a store-review prompt.
//
// Online by construction: the summary is a plain network query whose screen
// hard-errors when it fails, so this can only render with a working connection.
// That is why it uses confirmAndDownload (size quote + a real download) rather
// than the arm-only path the offline surfaces need.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { StyleProp, ViewStyle } from 'react-native';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useOfflineNudge } from '../../lib/offline-nudges/use-offline-nudge';
import { useConfirmBoardDownload } from '../../offline/use-confirm-board-download';
import { getSetting, setSetting } from '../../settings';
import { OfflineNudgeCard } from './OfflineNudgeCard';

type PostSessionOfflineNudgeProps = {
  /** True once the screen has decided the store review is NOT going to fire. */
  storeReviewWillPrompt: boolean;
  style?: StyleProp<ViewStyle>;
};

export function PostSessionOfflineNudge({ storeReviewWillPrompt, style }: PostSessionOfflineNudgeProps) {
  const { t } = useTranslation('boards');
  const { data: activeBoard } = useActiveBoard();
  const { confirmAndDownload } = useConfirmBoardDownload();
  const nudge = useOfflineNudge({ surface: 'post_session', board: activeBoard, storeReviewWillPrompt });

  const board = activeBoard ?? null;

  // The size dialog inside confirmAndDownload is the consent gate, so nothing is
  // recorded until it resolves true. Accepting on the tap would count a cancelled
  // dialog as an accept: it inflates the funnel, and it starts the 30-day
  // post-acceptance quiet period for someone who just said no.
  const handleDownload = useCallback(() => {
    if (!board) return;
    void confirmAndDownload(board).then((confirmed) => {
      if (confirmed) nudge.accept('download');
    });
  }, [board, nudge, confirmAndDownload]);

  // The 82%-stop-at-one lever, using the switch that already exists in More
  // rather than a second nudge surface: one setting write, and every board the
  // user owns (now and later) downloads. Same gate, and here it matters most —
  // writing the setting before the dialog resolves would leave someone who
  // cancelled opted into downloading every board they own.
  const handleDownloadAll = useCallback(() => {
    if (!board) return;
    void confirmAndDownload(board).then((confirmed) => {
      if (!confirmed) return;
      nudge.accept('download');
      setSetting('autoOfflineBoards', true);
    });
  }, [board, nudge, confirmAndDownload]);

  if (!nudge.visible || !board) return null;

  // Offered to someone who has downloaded nothing yet: the bulk switch is a fair
  // ask on a first download, but a user already curating individual boards has
  // made that choice by hand and shouldn't be talked out of it.
  const offerAllBoards = getSetting('syncEnabledBoards').length === 0;

  return (
    <OfflineNudgeCard
      testID="post-session-offline-nudge"
      title={t('mobile.offline.nudge.postSession.title', { name: board.name })}
      body={t('mobile.offline.nudge.postSession.body')}
      primaryLabel={t('mobile.offline.nudge.postSession.cta')}
      onPrimary={handleDownload}
      secondaryLabel={offerAllBoards ? t('mobile.offline.nudge.postSession.allBoardsCta') : undefined}
      onSecondary={offerAllBoards ? handleDownloadAll : undefined}
      dismissLabel={t('mobile.offline.nudge.notNow')}
      onDismiss={() => nudge.dismiss('once')}
      neverLabel={t('mobile.offline.nudge.never')}
      onNever={() => nudge.dismiss('forever')}
      style={style}
    />
  );
}

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

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { StyleProp, ViewStyle } from 'react-native';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useMyBoards } from '../../lib/graphql/hooks';
import { useOfflineNudge } from '../../lib/offline-nudges/use-offline-nudge';
import { useBoardDownloads } from '../../offline/use-board-downloads';
import { useConfirmBoardDownload } from '../../offline/use-confirm-board-download';
import { getSetting, offlineBoardKeyForBoard, setSetting } from '../../settings';
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
  const { enableBoardsOffline } = useBoardDownloads();
  const nudge = useOfflineNudge({ surface: 'post_session', board: activeBoard, storeReviewWillPrompt });

  const board = activeBoard ?? null;

  // Which boards "all my boards" actually means. Fetched only while the card is
  // on screen — a nudge that stood down must not add a query to the summary
  // screen — and it has the whole time the user spends reading the card to
  // resolve before the tap.
  const { data: myBoardsConnection } = useMyBoards(undefined, { enabled: nudge.visible });
  const myBoards = useMemo(() => myBoardsConnection?.boards ?? [], [myBoardsConnection]);

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
  // rather than a second nudge surface: the setting makes every board the user
  // adds from now on download itself. Same gate as the single download, and here
  // it matters most — writing the setting before the dialog resolves would leave
  // someone who cancelled opted into downloading every board they own.
  //
  // The boards they ALREADY own are downloaded here, not left to the setting.
  // The only code that expands `autoOfflineBoards` into downloads is an effect
  // scoped to the More screen, so without this a user with three boards would
  // get one — and the other two whenever they next happened to open Settings.
  const handleDownloadAll = useCallback(() => {
    if (!board) return;
    void confirmAndDownload(board).then((confirmed) => {
      if (!confirmed) return;
      nudge.accept('download');
      setSetting('autoOfflineBoards', true);
      // Read the setting rather than close over it: confirmAndDownload has just
      // enabled this board, and re-enabling it here would kick a second cycle.
      const alreadyEnabled = new Set(getSetting('syncEnabledBoards'));
      const missing = myBoards.filter((owned) => !alreadyEnabled.has(offlineBoardKeyForBoard(owned)));
      if (missing.length > 0) enableBoardsOffline(missing);
    });
  }, [board, nudge, confirmAndDownload, myBoards, enableBoardsOffline]);

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

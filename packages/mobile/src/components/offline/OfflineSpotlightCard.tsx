// A curated, translated spotlight pinned above the generated What's New
// timeline.
//
// It is pinned rather than written into the timeline because
// `changelog.generated.json` is regenerated from merged PR release notes by
// scripts/generate-changelog.ts — anything edited into it is overwritten on the
// next build, and its entries are English-only. One of them still describes
// offline downloads as testers-only, which stopped being true when the flag hit
// 100%.
//
// An affordance: no cooldown, no lifetime cap. It takes itself away once the
// user has any board armed or downloaded, or when they dismiss it.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import type { StyleProp, ViewStyle } from 'react-native';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useOfflineNudge } from '../../lib/offline-nudges/use-offline-nudge';
import { OfflineNudgeCard } from './OfflineNudgeCard';

type OfflineSpotlightCardProps = {
  style?: StyleProp<ViewStyle>;
};

export function OfflineSpotlightCard({ style }: OfflineSpotlightCardProps) {
  const { t } = useTranslation('boards');
  const router = useRouter();
  const { data: activeBoard } = useActiveBoard();
  const nudge = useOfflineNudge({ surface: 'whats_new', board: activeBoard });

  // Send them to My Boards rather than downloading from under them: this is a
  // "here's a feature you may not know about" card, not a confirmation, and the
  // per-board toggle there is where the size quote lives.
  const handleOpen = useCallback(() => {
    // A handoff, not an arm: nothing is queued here, the user is sent to the
    // screen where the size quote and the real download live. The drop-off that
    // leaves behind is a real one, so it counts as an ordinary accept.
    nudge.accept('handoff');
    router.push('/boards/manage');
  }, [nudge, router]);

  if (!nudge.visible) return null;

  return (
    <OfflineNudgeCard
      testID="offline-spotlight-card"
      title={t('mobile.offline.nudge.spotlight.title')}
      body={t('mobile.offline.nudge.spotlight.body')}
      primaryLabel={t('mobile.offline.nudge.spotlight.cta')}
      onPrimary={handleOpen}
      neverLabel={t('mobile.offline.nudge.never')}
      onNever={() => nudge.dismiss('forever')}
      style={style}
    />
  );
}

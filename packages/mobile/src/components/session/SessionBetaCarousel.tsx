import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BetaLink, SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';
import { SectionHeader } from '../SectionHeader';
import { betaLinkIdentity, isBetaVideoUrl, mapBetaLink } from '../../lib/beta-video-url';
import { spacing } from '../../theme/tokens';
import { BetaVideoCard, BETA_CARD_WIDTH } from '../play-drawer/BetaVideoCard';

type CrewBetaItem = { betaLink: BetaLink; uploaderName: string | null; uploaderAvatarUrl: string | null };

type SessionBetaCarouselProps = {
  ticks: SessionDetailTick[];
  /** Resolves a tick's `userId` to the participant who logged it (the uploader). */
  participantById: Map<string, SessionFeedParticipant>;
  isMultiUser: boolean;
};

const CARD_GAP = spacing[3];

/**
 * "Beta from this crew" shelf. The backend now scopes each tick's `betaLinks` to
 * the clip the ticking user attached to that ascent (via the direct beta↔tick
 * link), so this shows only the session's own videos — not every community clip
 * for the climbs. Each clip is attributed to the participant who logged its tick
 * (multi-user only; solo beta is all the viewer's). Walking ticks (rather than a
 * blind flatMap) keeps that uploader association. Self-hides when empty.
 */
export function SessionBetaCarousel({ ticks, participantById, isMultiUser }: SessionBetaCarouselProps) {
  const { t } = useTranslation('session');

  const items = useMemo<CrewBetaItem[]>(() => {
    const result: CrewBetaItem[] = [];
    const seen = new Set<string>();
    for (const tick of ticks) {
      const uploader = participantById.get(tick.userId);
      for (const raw of tick.betaLinks ?? []) {
        const mapped = mapBetaLink(raw);
        if (!isBetaVideoUrl(mapped.link)) continue;
        const identity = betaLinkIdentity(mapped.link);
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push({
          betaLink: mapped,
          uploaderName: isMultiUser ? (uploader?.displayName ?? null) : null,
          uploaderAvatarUrl: isMultiUser ? (uploader?.avatarUrl ?? null) : null,
        });
      }
    }
    return result;
  }, [ticks, participantById, isMultiUser]);

  if (items.length === 0) return null;

  return (
    <View>
      <SectionHeader title={t('mobile.betaVideos.crewTitle')} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        snapToInterval={BETA_CARD_WIDTH + CARD_GAP}
        decelerationRate="fast"
        snapToAlignment="start"
      >
        {items.map((item) => (
          <BetaVideoCard
            key={betaLinkIdentity(item.betaLink.link)}
            link={item.betaLink}
            uploaderName={item.uploaderName}
            uploaderAvatarUrl={item.uploaderAvatarUrl}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    gap: CARD_GAP,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[1],
  },
});

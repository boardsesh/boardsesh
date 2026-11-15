import type {
  BetaLink,
  BoardName,
  SessionFeedItem,
  SessionFeedTickHighlight,
  SocialEntityType,
} from '@boardsesh/shared-schema';
import { isBetaVideoUrl, isInstagramUrl, isTikTokUrl } from '@boardsesh/shared-schema';
import { Image } from 'expo-image';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { mapBetaLink } from '../../lib/beta-video-url';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { getSoleBoardType } from '../../lib/grade-label';
import { hapticLight } from '../../lib/haptics';
import { openValidatedUrl } from '../../lib/open-external-link';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { tickToClimb } from '../../lib/tick-to-climb';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { ClimbActionsPressable } from '../climb-actions/ClimbActionsPressable';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { PressableSurface } from '../PressableSurface';
import type { WorkoutHeadlineView } from '../session/workout/types';
import { Text } from '../Text';
import { AvatarGroup } from './AvatarGroup';
import { FeedSocialRow } from './FeedSocialRow';
import { gradeBadgeColor } from './profile-chart-colors';
import { SessionFeedCardView } from './SessionFeedCardView';
import { SessionFeedHeroView } from './SessionFeedHeroView';
import { SessionGradeStrip } from './SessionGradeStrip';

type SessionFeedCardProps = {
  session: SessionFeedItem;
  /** Per-viewer vote summary (count + userVote) for this session/tick, if loaded. */
  voteSummary?: { upvotes: number; userVote: number | null };
  onOpenComments: (entityId: string, entityType: SocialEntityType) => void;
  onPress: (session: SessionFeedItem) => void;
  onOpenClimb?: (tick: SessionFeedTickHighlight) => void;
  /** The workout the session was climbed to (#6903): one line under the header. */
  workoutHeadline?: WorkoutHeadlineView;
};

/** Hero media cell — sized for a portrait beta thumbnail / enlarged board art. */
const HERO_MEDIA = { width: 84, height: 104 } as const;

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function compactJoin(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => !!part).join(' · ');
}

function detectPlatform(url: string): { icon: IconName } | null {
  if (isInstagramUrl(url)) return { icon: 'instagram' };
  if (isTikTokUrl(url)) return { icon: 'tiktok' };
  return null;
}

export const SessionFeedCard = memo(function SessionFeedCard({
  session,
  voteSummary,
  onOpenComments,
  onPress,
  onOpenClimb,
  workoutHeadline,
}: SessionFeedCardProps) {
  const { t } = useTranslation('feed');
  const { formatGrade } = useGradeFormat();
  const { showToast } = useToast();
  const { getClimbActions } = useDrawerHost();

  const names = session.participants
    .map((participant) => participant.displayName)
    .filter((name): name is string => !!name)
    .join(', ');
  const title = names || t('sessionFeedCard.climbCount', { count: session.tickCount });

  const primaryBoard = session.boardTypes[0] ?? null;
  const metaLine = compactJoin([
    formatRelativeTime(session.lastTickAt),
    session.durationMinutes != null && session.durationMinutes > 0 ? formatDuration(session.durationMinutes) : null,
    primaryBoard,
  ]);

  const hardestSend = session.hardestSend ?? null;
  // The hardest grade belongs to the hardest send, so it reads on that send's board.
  const hardestGradeBoard = hardestSend?.boardType ?? primaryBoard;
  const displayHardestGrade = session.hardestGrade
    ? (formatGrade(session.hardestGrade, hardestGradeBoard) ?? session.hardestGrade)
    : null;

  // Beta video is the more engaging content, so it wins the hero when present —
  // the climb's board art only takes the hero when there's no beta to show.
  const featuredBeta = session.featuredBeta ?? null;
  const betaLink = featuredBeta ? mapBetaLink(featuredBeta.betaLink) : null;
  const betaUrl = betaLink?.link ?? null;

  // The featured beta is the crew's own clip (the backend scopes featuredBeta to
  // the tick's uploader), so attribute it to the participant who logged that
  // tick rather than to the original poster's handle.
  const betaUploaderName = featuredBeta
    ? (session.participants.find((participant) => participant.userId === featuredBeta.tick.userId)?.displayName ?? null)
    : null;

  const handleCardPress = useCallback(() => {
    hapticLight();
    onPress(session);
  }, [onPress, session]);

  const handleHeroPress = useCallback(() => {
    if (hardestSend && onOpenClimb) {
      hapticLight();
      onOpenClimb(hardestSend);
      return;
    }
    handleCardPress();
  }, [handleCardPress, hardestSend, onOpenClimb]);

  const heroMenuTarget = useMemo(() => {
    if (!hardestSend) return null;
    const climb = tickToClimb(hardestSend);
    const config = renderBoardToPlaylistConfig(hardestSend.boardType, hardestSend.layoutId, hardestSend.renderBoard);
    return climb && config
      ? getClimbActions(climb, {
          boardName: config.boardName,
          layoutId: config.layoutId,
          sizeId: config.sizeId,
          setIds: config.setIds.join(','),
          angle: hardestSend.angle,
        })
      : null;
  }, [hardestSend, getClimbActions]);

  const handleOpenBeta = useCallback(async () => {
    if (!betaUrl) return;
    hapticLight();
    const opened = await openValidatedUrl(betaUrl, isBetaVideoUrl);
    if (!opened) {
      showToast(t('mobile.home.betaOpenError'), 'error');
    }
  }, [betaUrl, showToast, t]);

  const heroClimbLabel = hardestSend
    ? t('sessionFeedCard.openHardestClimb', { climb: hardestSend.climbName ?? t('sessionFeedCard.unknownClimb') })
    : compactJoin([title, metaLine]);

  return (
    <SessionFeedCardView
      session={session}
      metaLine={metaLine}
      displayHardestGrade={displayHardestGrade}
      onPress={handleCardPress}
      workoutHeadline={workoutHeadline}
      avatars={<AvatarGroup participants={session.participants} size={36} />}
      gradeStrip={
        <SessionGradeStrip
          distribution={session.gradeDistribution}
          totalSends={session.totalSends}
          boardName={getSoleBoardType(session.boardTypes)}
        />
      }
      hero={
        featuredBeta && betaLink ? (
          <PressableSurface
            onPress={handleOpenBeta}
            feedback="opacity"
            accessibilityRole="link"
            accessibilityLabel={t('mobile.home.betaCardLabel')}
            style={styles.heroPressable}
          >
            <BetaHero betaLink={betaLink} tick={featuredBeta.tick} uploaderName={betaUploaderName} />
          </PressableSurface>
        ) : hardestSend ? (
          <ClimbActionsPressable
            target={heroMenuTarget}
            onPress={handleHeroPress}
            accessibilityRole="button"
            accessibilityLabel={heroClimbLabel}
            accessibilityHint={t('sessionFeedCard.openHint')}
            style={styles.heroPressable}
          >
            <HeroSend tick={hardestSend} />
          </ClimbActionsPressable>
        ) : null
      }
      social={
        <FeedSocialRow
          entityId={session.socialEntityId}
          entityType={session.socialEntityType}
          upvotes={voteSummary?.upvotes ?? session.upvotes}
          userVote={voteSummary?.userVote ?? null}
          commentCount={session.commentCount}
          onOpenComments={(entityId) => onOpenComments(entityId, session.socialEntityType)}
        />
      }
    />
  );
});

/** Beta-video hero: the Instagram/TikTok thumbnail + the climb it's beta for. */
const BetaHero = memo(function BetaHero({
  betaLink,
  tick,
  uploaderName,
}: {
  betaLink: BetaLink;
  tick: SessionFeedTickHighlight;
  uploaderName: string | null;
}) {
  const { t } = useTranslation('feed');
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const [imageFailed, setImageFailed] = useState(false);

  const platform = detectPlatform(betaLink.link);
  const username = betaLink.foreign_username?.trim();
  const displayGrade = tick.difficultyName
    ? (formatGrade(tick.difficultyName, tick.boardType) ?? tick.difficultyName)
    : null;

  return (
    <View style={styles.hero}>
      <View style={styles.betaMedia}>
        {betaLink.thumbnail && !imageFailed ? (
          <Image
            source={{ uri: betaLink.thumbnail }}
            style={styles.media}
            contentFit="cover"
            transition={150}
            recyclingKey={betaLink.thumbnail}
            onError={() => setImageFailed(true)}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={[styles.media, styles.mediaFallback, { backgroundColor: systemColors.fill }]}>
            <Icon name="video" size={26} color={systemColors.tertiaryLabel} />
          </View>
        )}
        <View style={styles.playOverlay} pointerEvents="none">
          <View style={styles.playBadge}>
            <Icon name="play.fill" size={22} color="#FFFFFF" />
          </View>
        </View>
        {platform ? (
          <View style={styles.platformBadge}>
            <Icon name={platform.icon} size={13} color="#FFFFFF" />
          </View>
        ) : null}
      </View>
      <View style={styles.heroDetails}>
        <Text variant="caption1" color={brandColors.primary} style={styles.betaEyebrow}>
          {t('sessionFeedCard.betaEyebrow').toUpperCase()}
        </Text>
        <View style={styles.nameRow}>
          <Text variant="title3" numberOfLines={2} style={styles.flex}>
            {tick.climbName ?? t('sessionFeedCard.unknownClimb')}
          </Text>
          {displayGrade ? (
            <Text
              variant="title3"
              style={[styles.gradeText, { color: gradeBadgeColor(tick.difficultyName ?? displayGrade) }]}
            >
              {displayGrade}
            </Text>
          ) : null}
        </View>
        {uploaderName ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
            {t('sessionFeedCard.betaBy', { name: uploaderName })}
          </Text>
        ) : null}
        {username ? (
          <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
            @{username}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

/** Live board rendering and grade preference for the shared hero. */
const HeroSend = memo(function HeroSend({ tick }: { tick: SessionFeedTickHighlight }) {
  const { formatGrade } = useGradeFormat();
  const boardConfig = renderBoardToPlaylistConfig(tick.boardType, tick.layoutId, tick.renderBoard);
  const displayGrade = tick.difficultyName
    ? (formatGrade(tick.difficultyName, tick.boardType) ?? tick.difficultyName)
    : null;
  return (
    <SessionFeedHeroView
      tick={tick}
      displayGrade={displayGrade}
      media={
        boardConfig && tick.frames ? (
          <ClimbListThumbnail
            frames={tick.frames}
            boardName={boardConfig.boardName as BoardName}
            layoutId={boardConfig.layoutId}
            sizeId={boardConfig.sizeId}
            setIds={boardConfig.setIds.join(',')}
            mirrored={tick.isMirror}
            size={HERO_MEDIA}
          />
        ) : undefined
      }
    />
  );
});

const styles = StyleSheet.create({
  wrapper: { marginHorizontal: spacing[4], marginTop: spacing[3] },
  heroPressable: {
    margin: -spacing[1],
    padding: spacing[1],
    borderRadius: borderRadius.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  headerText: { flex: 1 },
  title: { fontWeight: '600' },
  metaLine: { marginTop: 2 },
  statEmphasis: { fontWeight: '600' },
  workoutChip: { marginTop: spacing[2] },
  goal: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[2] },
  hero: { flexDirection: 'row', gap: spacing[3], marginTop: spacing[2] },
  media: { width: HERO_MEDIA.width, height: HERO_MEDIA.height, borderRadius: borderRadius.md },
  mediaFallback: { alignItems: 'center', justifyContent: 'center' },
  betaMedia: { width: HERO_MEDIA.width, height: HERO_MEDIA.height, borderRadius: borderRadius.md, overflow: 'hidden' },
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  platformBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroDetails: { flex: 1, gap: spacing[1], justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  gradeText: { fontWeight: '700' },
  betaEyebrow: { fontWeight: '700', letterSpacing: 0.6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  statusText: { fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth, marginTop: spacing[2] },
  footer: { marginTop: spacing[2] },
  flex: { flex: 1 },
});

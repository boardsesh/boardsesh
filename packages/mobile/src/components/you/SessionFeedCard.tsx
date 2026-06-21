import { memo, useCallback, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { isBetaVideoUrl, isInstagramUrl, isTikTokUrl } from '@boardsesh/shared-schema';
import type {
  BetaLink,
  BoardName,
  SessionFeedItem,
  SessionFeedTickHighlight,
  SocialEntityType,
} from '@boardsesh/shared-schema';
import { formatTickRelativeTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { Card } from '../Card';
import { PressableSurface } from '../PressableSurface';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { AvatarGroup } from './AvatarGroup';
import { FeedSocialRow } from './FeedSocialRow';
import { SessionGradeStrip } from './SessionGradeStrip';
import { gradeBadgeColor } from './profile-chart-colors';
import { mapBetaLink } from '../../lib/beta-video-url';
import { openValidatedUrl } from '../../lib/open-external-link';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { tickToClimb } from '../../lib/tick-to-climb';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useToast } from '../../providers/toast-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { hapticLight, hapticMedium } from '../../lib/haptics';

type SessionFeedCardProps = {
  session: SessionFeedItem;
  /** Per-viewer vote summary (count + userVote) for this session/tick, if loaded. */
  voteSummary?: { upvotes: number; userVote: number | null };
  onOpenComments: (entityId: string, entityType: SocialEntityType) => void;
  onPress: (session: SessionFeedItem) => void;
  onOpenClimb?: (tick: SessionFeedTickHighlight) => void;
};

/** Hero media cell — sized for a portrait beta thumbnail / enlarged board art. */
const HERO_MEDIA = { width: 84, height: 104 } as const;

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function tickStatusLabel(status: string, t: (key: string) => string): string {
  if (status === 'flash') return t('sessionFeedCard.status.flash');
  if (status === 'send') return t('sessionFeedCard.status.send');
  if (status === 'attempt') return t('sessionFeedCard.status.attempt');
  return status;
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
}: SessionFeedCardProps) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const { showToast } = useToast();
  const { openClimbActions } = useDrawerHost();

  const names = session.participants
    .map((participant) => participant.displayName)
    .filter((name): name is string => !!name)
    .join(', ');
  const title = names || t('sessionFeedCard.climbCount', { count: session.tickCount });

  // One quiet grey summary line replaces the 4-chip stats rail. Tries are
  // intentionally dropped here (they live on session detail); the hardest grade
  // is already the big coloured hero number, so it isn't repeated either.
  const statLine = compactJoin([
    t('sessionFeedCard.sendsCount', { count: session.totalSends }),
    session.totalFlashes > 0 ? t('sessionFeedCard.flashesCount', { count: session.totalFlashes }) : null,
  ]);

  const primaryBoard = session.boardTypes[0] ?? null;
  const metaLine = compactJoin([
    formatTickRelativeTime(session.lastTickAt),
    session.durationMinutes != null && session.durationMinutes > 0 ? formatDuration(session.durationMinutes) : null,
    primaryBoard,
  ]);

  const hardestSend = session.hardestSend ?? null;
  const displayHardestGrade = session.hardestGrade ? (formatGrade(session.hardestGrade) ?? session.hardestGrade) : null;

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

  // Long press the hardest-send hero → open the climb reaction menu.
  const handleHeroLongPress = useCallback(() => {
    if (!hardestSend) return;
    const climb = tickToClimb(hardestSend);
    const config = getBoardConfigForPlaylist(hardestSend.boardType, hardestSend.layoutId);
    if (!climb || !config) return;
    hapticMedium();
    openClimbActions(climb, {
      boardName: config.boardName,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      setIds: config.setIds.join(','),
      angle: hardestSend.angle,
    });
  }, [hardestSend, openClimbActions]);

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

  const cardAccessibilityLabel = compactJoin([
    title,
    metaLine,
    t('sessionFeedCard.sendsCount', { count: session.totalSends }),
    displayHardestGrade ? t('sessionFeedCard.hardestGrade', { grade: displayHardestGrade }) : null,
  ]);

  return (
    <View style={styles.wrapper}>
      <Card>
        {/* Header opens the SESSION; the hero opens the beta video (when present)
            or the hardest-send CLIMB. Two tap targets so session detail stays
            reachable. */}
        <PressableSurface
          onPress={handleCardPress}
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={cardAccessibilityLabel}
          accessibilityHint={t('sessionFeedCard.openHint')}
          style={styles.heroPressable}
        >
          <View style={styles.header}>
            <AvatarGroup participants={session.participants} size={36} />
            <View style={styles.headerText}>
              <Text variant="subheadline" style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {/* One line, sends first: counts in a bolder secondary colour, the
                  time·duration·board tail quieter. Weight+colour carry the tiers
                  at one 12pt size, so there's no orphaned second line. */}
              <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1} style={styles.metaLine}>
                {statLine ? (
                  <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.statEmphasis}>
                    {statLine}
                  </Text>
                ) : null}
                {statLine ? ' · ' : ''}
                {metaLine}
              </Text>
            </View>
          </View>

          {session.goal ? (
            <View style={styles.goal}>
              <Icon name="flag" size={13} color={systemColors.secondaryLabel} />
              <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={2} style={styles.flex}>
                {session.goal}
              </Text>
            </View>
          ) : null}
        </PressableSurface>

        {/* The session's grade SPREAD — the "this is a session" signal the
            single-climb hero can't carry. Self-hides unless there are 2+ grades. */}
        <SessionGradeStrip distribution={session.gradeDistribution} totalSends={session.totalSends} />

        {featuredBeta && betaLink ? (
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
          <PressableSurface
            onPress={handleHeroPress}
            onLongPress={handleHeroLongPress}
            feedback="opacity"
            accessibilityRole="button"
            accessibilityLabel={heroClimbLabel}
            accessibilityHint={t('sessionFeedCard.openHint')}
            style={styles.heroPressable}
          >
            <HeroSend tick={hardestSend} />
          </PressableSurface>
        ) : null}

        <View style={[styles.divider, { backgroundColor: systemColors.separator }]} />

        <View style={styles.footer}>
          <FeedSocialRow
            entityId={session.socialEntityId}
            entityType={session.socialEntityType}
            upvotes={voteSummary?.upvotes ?? session.upvotes}
            userVote={voteSummary?.userVote ?? null}
            commentCount={session.commentCount}
            onOpenComments={(entityId) => onOpenComments(entityId, session.socialEntityType)}
          />
        </View>
      </Card>
    </View>
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
  const displayGrade = tick.difficultyName ? (formatGrade(tick.difficultyName) ?? tick.difficultyName) : null;

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
          <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1}>
            @{username}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

/** Hero for sessions with no beta: enlarged board art + the hardest send. */
const HeroSend = memo(function HeroSend({ tick }: { tick: SessionFeedTickHighlight }) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();

  const boardConfig = getBoardConfigForPlaylist(tick.boardType, tick.layoutId);
  const displayGrade = tick.difficultyName ? (formatGrade(tick.difficultyName) ?? tick.difficultyName) : null;
  const statusLabel = tickStatusLabel(tick.status, t);
  const statusIcon: IconName = tick.status === 'flash' ? 'flash' : 'check.small';
  const attemptLabel = tick.attemptCount > 1 ? t('sessionFeedCard.attempts', { count: tick.attemptCount }) : null;

  return (
    <View style={styles.hero}>
      {boardConfig && tick.frames ? (
        <ClimbListThumbnail
          frames={tick.frames}
          boardName={boardConfig.boardName as BoardName}
          layoutId={boardConfig.layoutId}
          sizeId={boardConfig.sizeId}
          setIds={boardConfig.setIds.join(',')}
          mirrored={tick.isMirror}
          size={HERO_MEDIA}
        />
      ) : (
        <View style={[styles.media, styles.mediaFallback, { backgroundColor: systemColors.fill }]}>
          <Icon name="lightbulb" size={26} color={systemColors.tertiaryLabel} />
        </View>
      )}
      <View style={styles.heroDetails}>
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
        {/* Status stays shape-coded (flash glyph vs check) but greyscale, so the
            grade is the only colour on the card. */}
        <View style={styles.statusRow}>
          <Icon name={statusIcon} size={13} color={systemColors.secondaryLabel} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.statusText}>
            {statusLabel}
          </Text>
          {attemptLabel ? (
            <>
              <Text variant="footnote" color={systemColors.tertiaryLabel}>
                ·
              </Text>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {attemptLabel}
              </Text>
            </>
          ) : null}
        </View>
      </View>
    </View>
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

import { memo, useCallback, useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import type { BetaLink } from '@boardsesh/shared-schema';
import { isBetaVideoUrl, isInstagramUrl, isTikTokUrl } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import type { IconName } from '../icon-map';
import { useToast } from '../../providers/toast-provider';
import { track } from '../../lib/analytics';
import { openValidatedUrl } from '../../lib/open-external-link';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

export const BETA_CARD_WIDTH = 108;
const BETA_CARD_ASPECT_RATIO = 9 / 16;
export const BETA_CARD_HEIGHT = BETA_CARD_WIDTH / BETA_CARD_ASPECT_RATIO;

// Half-size variant for the profile beta shelf, where the strip is a secondary
// section under the stats summary rather than a hero row.
export const BETA_CARD_COMPACT_WIDTH = BETA_CARD_WIDTH / 2;
export const BETA_CARD_COMPACT_HEIGHT = BETA_CARD_HEIGHT / 2;

type Props = {
  link: BetaLink;
  /**
   * Crew attribution: the session participant who attached this clip. When set,
   * the card labels the uploader (avatar + name) instead of the original poster's
   * @handle — answering "whose beta is this" on a multi-user session shelf.
   */
  uploaderName?: string | null;
  uploaderAvatarUrl?: string | null;
  /**
   * `'compact'` halves the card (54×96) for the profile shelf; `'default'`
   * (108×192) is the hero size used by the home + session shelves and the grid.
   */
  size?: 'default' | 'compact';
};

export const BetaVideoCard = memo(function BetaVideoCard({
  link,
  uploaderName,
  uploaderAvatarUrl,
  size = 'default',
}: Props) {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const [imageFailed, setImageFailed] = useState(false);

  const onPress = useCallback(async () => {
    void Haptics.selectionAsync();
    track(SHARED_EVENTS.BetaVideoLinkClicked, {
      climbUuid: link.climb_uuid,
      platform: detectPlatform(link.link)?.name ?? null,
    });
    const opened = await openValidatedUrl(link.link, isBetaVideoUrl);
    if (!opened) {
      showToast(t('mobile.betaVideos.openError'), 'error');
    }
  }, [link.climb_uuid, link.link, showToast, t]);

  const platform = detectPlatform(link.link);
  const username = link.foreign_username?.trim();
  const accessibilityLabel = uploaderName
    ? t('mobile.betaVideos.cardLabelByUploader', { name: uploaderName })
    : username
      ? t('mobile.betaVideos.cardLabelWithUser', { username })
      : t('mobile.betaVideos.cardLabel');

  const compact = size === 'compact';
  const cardWidth = compact ? BETA_CARD_COMPACT_WIDTH : BETA_CARD_WIDTH;
  const cardHeight = compact ? BETA_CARD_COMPACT_HEIGHT : BETA_CARD_HEIGHT;
  const badgeSize = compact ? 14 : 22;
  const badgeIconSize = compact ? 8 : 12;
  const fallbackIconSize = compact ? 20 : 28;
  const pillMaxWidth = cardWidth - spacing[2] * 2;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.card, { width: cardWidth, height: cardHeight }, pressed && styles.cardPressed]}
    >
      {link.thumbnail && !imageFailed ? (
        <Image
          source={{ uri: link.thumbnail }}
          style={styles.thumbnail}
          contentFit="cover"
          transition={150}
          recyclingKey={link.thumbnail}
          onError={() => setImageFailed(true)}
          accessibilityIgnoresInvertColors
          // Remote IG/TikTok thumbnail (now requested pre-sized via ?size=);
          // skip expo-image's main-thread downscale resample regardless.
          allowDownscaling={false}
        />
      ) : (
        <View style={[styles.thumbnail, styles.thumbnailFallback]}>
          <Icon name="video" size={fallbackIconSize} color={iosSystemColors.systemGray} />
        </View>
      )}

      {platform && (
        <View style={[styles.platformBadge, { width: badgeSize, height: badgeSize }]}>
          <Icon name={platform.icon} size={badgeIconSize} color={iosSystemColors.white} />
        </View>
      )}

      {uploaderName ? (
        <View style={[styles.usernamePill, { maxWidth: pillMaxWidth }, styles.uploaderPill]}>
          <Avatar uri={uploaderAvatarUrl ?? undefined} name={uploaderName} size={16} />
          <Text variant="caption2" color={iosSystemColors.white} numberOfLines={1} style={styles.uploaderName}>
            {uploaderName}
          </Text>
        </View>
      ) : username ? (
        <View style={[styles.usernamePill, { maxWidth: pillMaxWidth }, compact && styles.usernamePillCompact]}>
          <Text variant="caption2" color={iosSystemColors.white} numberOfLines={1}>
            @{username}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
});

function detectPlatform(url: string): { name: 'instagram' | 'tiktok'; icon: IconName } | null {
  if (isInstagramUrl(url)) return { name: 'instagram', icon: 'instagram' };
  if (isTikTokUrl(url)) return { name: 'tiktok', icon: 'tiktok' };
  return null;
}

const styles = StyleSheet.create({
  card: {
    // width/height are applied inline from the `size` prop.
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    backgroundColor: `${iosSystemColors.systemGray}1F`,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosSystemColors.separator,
  },
  cardPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.97 }],
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  thumbnailFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  platformBadge: {
    position: 'absolute',
    top: spacing[1],
    left: spacing[1],
    width: 22,
    height: 22,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  usernamePill: {
    position: 'absolute',
    bottom: spacing[1],
    left: spacing[1],
    // maxWidth is applied inline from the resolved card width.
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  usernamePillCompact: {
    paddingHorizontal: spacing[1],
    paddingVertical: 1,
  },
  uploaderPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingLeft: 2,
  },
  uploaderName: { flexShrink: 1 },
});

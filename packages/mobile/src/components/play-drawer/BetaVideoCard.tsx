import { memo, useCallback, useState } from 'react';
import { Pressable, View, StyleSheet, Linking, Alert } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import type { BetaLink } from '@boardsesh/shared-schema';
import { isInstagramUrl, isTikTokUrl } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { useToast } from '../../providers/toast-provider';
import { track } from '../../lib/analytics';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useDeleteBetaLink } from '../../lib/graphql/hooks';

export const BETA_CARD_WIDTH = 140;
const BETA_CARD_ASPECT_RATIO = 9 / 16;
export const BETA_CARD_HEIGHT = BETA_CARD_WIDTH / BETA_CARD_ASPECT_RATIO;

type Props = {
  link: BetaLink;
  boardName?: string;
  climbUuid?: string;
  currentUserId?: string | null;
};

export const BetaVideoCard = memo(function BetaVideoCard({ link, boardName, climbUuid, currentUserId }: Props) {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const [imageFailed, setImageFailed] = useState(false);
  const deleteMutation = useDeleteBetaLink();

  const onPress = useCallback(async () => {
    void Haptics.selectionAsync();
    track(SHARED_EVENTS.BetaVideoLinkClicked, {
      climbUuid: link.climb_uuid,
      platform: detectPlatform(link.link)?.name ?? null,
    });
    try {
      const canOpen = await Linking.canOpenURL(link.link);
      if (!canOpen) {
        showToast(t('mobile.betaVideos.openError'), 'error');
        return;
      }
      await Linking.openURL(link.link);
    } catch {
      showToast(t('mobile.betaVideos.openError'), 'error');
    }
  }, [link.climb_uuid, link.link, showToast, t]);

  const attachedByUser = link.attached_by_user;
  const isOwner = attachedByUser && currentUserId && attachedByUser.id === currentUserId;

  const onLongPress = useCallback(() => {
    if (!isOwner || !boardName || !climbUuid) return;
    void Haptics.selectionAsync();
    Alert.alert(t('mobile.betaVideos.deleteConfirmTitle'), t('mobile.betaVideos.deleteConfirmBody'), [
      { text: t('mobile.betaVideos.deleteCancel'), style: 'cancel' },
      {
        text: t('mobile.betaVideos.deleteLink'),
        style: 'destructive',
        onPress: () => {
          deleteMutation.mutate(
            { boardType: boardName, climbUuid, link: link.link },
            {
              onSuccess: () => showToast(t('mobile.betaVideos.deleteSuccess'), 'success'),
              onError: () => showToast(t('mobile.betaVideos.deleteError'), 'error'),
            },
          );
        },
      },
    ]);
  }, [isOwner, boardName, climbUuid, link.link, t, deleteMutation, showToast]);

  const platform = detectPlatform(link.link);
  const username = link.foreign_username?.trim();
  const displayName = attachedByUser?.displayName;
  const accessibilityLabel = username
    ? t('mobile.betaVideos.cardLabelWithUser', { username })
    : t('mobile.betaVideos.cardLabel');

  return (
    <Pressable
      onPress={onPress}
      onLongPress={isOwner ? onLongPress : undefined}
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
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
          <Icon name="video" size={28} color={iosSystemColors.systemGray} />
        </View>
      )}

      {platform && (
        <View style={styles.platformBadge}>
          <Icon name={platform.icon} size={12} color={iosSystemColors.white} />
        </View>
      )}

      {(displayName || username) && (
        <View style={styles.usernamePill}>
          {displayName ? (
            <>
              <Text variant="caption2" color={iosSystemColors.white} numberOfLines={1}>
                {displayName}
              </Text>
              {username && (
                <Text variant="caption2" color={iosSystemColors.systemGray} numberOfLines={1}>
                  {t('mobile.betaVideos.viaHandle', { handle: username })}
                </Text>
              )}
            </>
          ) : (
            <Text variant="caption2" color={iosSystemColors.white} numberOfLines={1}>
              @{username}
            </Text>
          )}
        </View>
      )}
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
    width: BETA_CARD_WIDTH,
    height: BETA_CARD_HEIGHT,
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
    maxWidth: BETA_CARD_WIDTH - spacing[2] * 2,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
});

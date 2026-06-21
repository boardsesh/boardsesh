import { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { PublicUserProfile } from '@boardsesh/shared-schema';
import { isInstagramUrl } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import { Button } from '../Button';
import { useToggleUserFollow } from '../../lib/graphql/hooks';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { hapticLight } from '../../lib/haptics';
import { openValidatedUrl } from '../../lib/open-external-link';
import { spacing, borderRadius } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants';

const AVATAR_SIZE = 80;

type PublicProfileHeaderBlockProps = {
  profile: PublicUserProfile;
  /** Sourced via the publicProfile query once PR #2902 lands; null hides the chip. */
  instagramUrl: string | null;
  currentUserId: string | undefined;
};

/**
 * The identity block at the top of a climber's public profile: 80dp avatar,
 * display name, tappable follower/following counts, an optional Instagram link,
 * and the Follow CTA. No email (own-profile only) and no activity chart (that
 * lives in the Progress sub-tab, fed by the same view model).
 */
export function PublicProfileHeaderBlock({ profile, instagramUrl, currentUserId }: PublicProfileHeaderBlockProps) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const router = useRouter();

  const displayName = profile.displayName || t('mobile.unknownName');
  const isSelf = !!currentUserId && profile.id === currentUserId;

  const openConnections = useCallback(
    (mode: 'followers' | 'following') => {
      router.push({ pathname: '/users/connections', params: { userId: profile.id, mode } });
    },
    [router, profile.id],
  );

  return (
    <View style={styles.container}>
      <View style={styles.identityRow}>
        <Avatar uri={profile.avatarUrl} name={profile.displayName} size={AVATAR_SIZE} />
        <View style={styles.identityText}>
          <Text variant="title2" numberOfLines={2} style={styles.name}>
            {displayName}
          </Text>
          <View style={styles.countsRow}>
            <Pressable
              onPress={() => openConnections('followers')}
              accessibilityRole="button"
              hitSlop={8}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {t('mobile.social.followerCount', { count: profile.followerCount })}
              </Text>
            </Pressable>
            <Text variant="subheadline" color={systemColors.tertiaryLabel} style={styles.dot}>
              ·
            </Text>
            <Pressable
              onPress={() => openConnections('following')}
              accessibilityRole="button"
              hitSlop={8}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {t('mobile.social.followingCount', { count: profile.followingCount })}
              </Text>
            </Pressable>
          </View>
          {instagramUrl ? <InstagramLink url={instagramUrl} /> : null}
        </View>
      </View>

      {isSelf ? null : (
        <FollowButton
          targetUserId={profile.id}
          isFollowedByMe={profile.isFollowedByMe}
          currentUserId={currentUserId}
          displayName={displayName}
        />
      )}
    </View>
  );
}

function FollowButton({
  targetUserId,
  isFollowedByMe,
  currentUserId,
  displayName,
}: {
  targetUserId: string;
  isFollowedByMe: boolean;
  currentUserId: string | undefined;
  displayName: string;
}) {
  const { t } = useTranslation('you');
  const { variant } = useTheme();
  const toggleFollow = useToggleUserFollow(currentUserId);
  const isPending = toggleFollow.isPending && toggleFollow.variables?.userId === targetUserId;

  // Following at rest reads as middle-emphasis: M3 → tonal, HIG → outlined capsule.
  const followingVariant = selectByVariant(variant, { liquidGlass: 'outlined', material: 'tonal' } as const);

  return (
    <Button
      title={isFollowedByMe ? t('mobile.social.following') : t('mobile.social.followAction')}
      accessibilityLabel={
        isFollowedByMe
          ? t('mobile.social.unfollowUser', { name: displayName })
          : t('mobile.social.followUser', { name: displayName })
      }
      variant={isFollowedByMe ? followingVariant : 'filled'}
      size="medium"
      loading={isPending}
      disabled={isPending}
      style={styles.followButton}
      onPress={() => toggleFollow.mutate({ userId: targetUserId, isFollowedByMe })}
    />
  );
}

function InstagramLink({ url }: { url: string }) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const { showToast } = useToast();

  const handleOpen = useCallback(async () => {
    hapticLight();
    const opened = await openValidatedUrl(url, isInstagramUrl);
    if (!opened) {
      showToast(t('mobile.social.instagramOpenError'), 'error');
    }
  }, [showToast, t, url]);

  return (
    <Pressable
      onPress={handleOpen}
      accessibilityRole="link"
      accessibilityLabel={t('mobile.social.instagramLink')}
      hitSlop={6}
      style={({ pressed }) => [
        styles.instagramChip,
        { borderColor: systemColors.separator },
        pressed && styles.pressed,
      ]}
    >
      <Icon name="instagram" size={15} color={systemColors.secondaryLabel} />
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('mobile.social.instagramLink')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
    gap: spacing[3],
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
  identityText: {
    flex: 1,
    gap: spacing[1],
  },
  name: {
    fontWeight: '700',
  },
  countsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  dot: {
    paddingHorizontal: spacing[2],
  },
  instagramChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    marginTop: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  followButton: {
    alignSelf: 'stretch',
  },
  pressed: {
    opacity: 0.6,
  },
});

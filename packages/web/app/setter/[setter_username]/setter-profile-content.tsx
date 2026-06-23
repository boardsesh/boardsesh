'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import { PersonOutlined, SentimentDissatisfiedOutlined, IosShare } from '@mui/icons-material';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import BackButton from '@/app/components/back-button';
import FollowButton from '@/app/components/ui/follow-button';
import SetterClimbList from '@/app/components/climb-list/setter-climb-list';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_SETTER_PROFILE,
  FOLLOW_SETTER,
  UNFOLLOW_SETTER,
  type GetSetterProfileQueryVariables,
  type GetSetterProfileQueryResponse,
} from '@boardsesh/graphql/operations';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { shareWithFallback } from '@/app/lib/share-utils';
import type { SetterProfile } from '@boardsesh/shared-schema';
import styles from '@/app/components/library/playlist-view.module.css';

type SetterProfileContentProps = {
  username: string;
};

export default function SetterProfileContent({ username }: SetterProfileContentProps) {
  const { data: session } = useSession();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('profile');
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<SetterProfile | null>(null);

  const fetchProfile = useCallback(async () => {
    try {
      const authToken = (session as { authToken?: string } | null)?.authToken ?? null;
      const client = createGraphQLHttpClient(authToken);
      const response = await client.request<GetSetterProfileQueryResponse, GetSetterProfileQueryVariables>(
        GET_SETTER_PROFILE,
        { input: { username } },
      );
      setProfile(response.setterProfile);
    } catch (error) {
      console.error('Failed to fetch setter profile:', error);
    } finally {
      setLoading(false);
    }
  }, [username, session]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const shareDisplayName = profile?.linkedUserDisplayName || profile?.username || username;

  const handleShare = useCallback(async () => {
    const shareUrl = `${window.location.origin}/setter/${encodeURIComponent(username)}`;
    await shareWithFallback({
      url: shareUrl,
      title: t('setter.shareTitle', { name: shareDisplayName }),
      text: t('setter.shareText', { name: shareDisplayName }),
      trackingEvent: 'Setter Shared',
      trackingProps: { username },
      onClipboardSuccess: () => showMessage(t('setter.linkCopied'), 'success'),
      onError: () => showMessage(t('setter.shareFailed'), 'error'),
    });
  }, [username, shareDisplayName, showMessage, t]);

  if (loading) {
    return (
      <div className={styles.loadingContainer}>
        <LoadingSpinner size={48} />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className={styles.errorContainer}>
        <SentimentDissatisfiedOutlined className={styles.errorIcon} />
        <div className={styles.errorTitle}>{t('setter.notFoundTitle')}</div>
        <div className={styles.errorMessage}>{t('setter.notFoundMessage')}</div>
      </div>
    );
  }

  const displayName = profile.linkedUserDisplayName || profile.username;
  const avatarUrl = profile.linkedUserAvatarUrl;
  const authToken = (session as { authToken?: string } | null)?.authToken ?? null;

  return (
    <>
      {/* Back Button & Share */}
      <div className={styles.actionsSection}>
        <BackButton fallbackUrl="/" />
        <IconButton onClick={handleShare} aria-label={t('setter.shareAriaLabel')}>
          <IosShare />
        </IconButton>
      </div>

      {/* Main Content */}
      <div className={styles.contentWrapper}>
        {/* Hero Card */}
        <div className={styles.heroSection}>
          <div className={styles.heroContent}>
            <div
              className={styles.heroSquare}
              style={{ backgroundColor: 'var(--color-primary-fill)', overflow: 'hidden' }}
            >
              {avatarUrl ? (
                <Image src={avatarUrl} alt={displayName} fill style={{ objectFit: 'cover' }} />
              ) : (
                <PersonOutlined className={styles.heroSquareIcon} />
              )}
            </div>
            <div className={styles.heroInfo}>
              <Typography variant="h5" component="h2" className={styles.heroName}>
                {displayName}
              </Typography>
              <div className={styles.heroMeta}>
                <span className={styles.heroMetaItem}>
                  {profile.followerCount} {t('setter.follower', { count: profile.followerCount })}
                </span>
                <span className={styles.heroMetaItem}>
                  {profile.climbCount} {t('setter.climb', { count: profile.climbCount })}
                </span>
              </div>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                {profile.boardTypes.map((bt) => (
                  <Chip key={bt} label={bt.charAt(0).toUpperCase() + bt.slice(1)} size="small" variant="outlined" />
                ))}
              </Box>
              <FollowButton
                entityId={profile.username}
                initialIsFollowing={profile.isFollowedByMe}
                followMutation={FOLLOW_SETTER}
                unfollowMutation={UNFOLLOW_SETTER}
                entityLabel="setter"
                getFollowVariables={(id) => ({ input: { setterUsername: id } })}
                onFollowChange={(isFollowing) => {
                  if (profile) {
                    setProfile({
                      ...profile,
                      followerCount: profile.followerCount + (isFollowing ? 1 : -1),
                      isFollowedByMe: isFollowing,
                    });
                  }
                }}
              />
            </div>
          </div>
        </div>

        {/* Climbs Section */}
        <div className={styles.climbsSection}>
          <SetterClimbList username={profile.username} boardTypes={profile.boardTypes} authToken={authToken} />
        </div>
      </div>
    </>
  );
}

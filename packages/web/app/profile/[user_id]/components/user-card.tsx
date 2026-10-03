'use client';

import React from 'react';
import MuiAvatar from '@mui/material/Avatar';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { PersonOutlined, Instagram } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import FollowButton from '@/app/components/ui/follow-button';
import FollowerCount from '@/app/components/social/follower-count';
import { FOLLOW_USER, UNFOLLOW_USER } from '@boardsesh/graphql/operations';
import type { UserProfile } from '../utils/profile-constants';
import styles from '../profile-page.module.css';

export type UserCardProps = {
  userId: string;
  profile: UserProfile;
  isOwnProfile: boolean;
  onProfileUpdate: (updatedProfile: UserProfile) => void;
};

export default function UserCard({ userId, profile, isOwnProfile, onProfileUpdate }: UserCardProps) {
  const { t } = useTranslation('profile');
  const displayName = profile.displayName || t('page.displayNameFallback');
  const avatarUrl = profile.avatarUrl;
  const instagramUrl = profile.instagramUrl;

  return (
    <MuiCard className={styles.profileCard}>
      <CardContent>
        <div className={styles.profileInfo}>
          <MuiAvatar sx={{ width: 80, height: 80 }} src={avatarUrl ?? undefined}>
            {!avatarUrl && <PersonOutlined />}
          </MuiAvatar>
          <div className={styles.profileDetails}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="h6" component="h4" className={styles.displayName}>
                {displayName}
              </Typography>
              {!isOwnProfile && (
                <FollowButton
                  entityId={userId}
                  initialIsFollowing={profile.isFollowedByMe}
                  followMutation={FOLLOW_USER}
                  unfollowMutation={UNFOLLOW_USER}
                  entityLabel="user"
                  getFollowVariables={(id) => ({ input: { userId: id } })}
                  onFollowChange={(isFollowing) => {
                    onProfileUpdate({
                      ...profile,
                      followerCount: profile.followerCount + (isFollowing ? 1 : -1),
                      isFollowedByMe: isFollowing,
                    });
                  }}
                />
              )}
            </Box>
            <FollowerCount
              userId={userId}
              followerCount={profile.followerCount}
              followingCount={profile.followingCount}
            />
            {isOwnProfile && (
              <Typography variant="body2" component="span" color="text.secondary">
                {profile.email}
              </Typography>
            )}
            {instagramUrl && (
              <a
                href={instagramUrl.startsWith('http') ? instagramUrl : `https://${instagramUrl}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.instagramLink}
              >
                <Instagram className={styles.instagramIcon} />
                <span>{instagramUrl.replace(/^https?:\/\/(www\.)?instagram\.com\//, '@').replace(/\/$/, '')}</span>
              </a>
            )}
          </div>
        </div>
      </CardContent>
    </MuiCard>
  );
}

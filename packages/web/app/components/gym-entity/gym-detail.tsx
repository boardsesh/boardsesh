'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Avatar from '@mui/material/Avatar';
import MuiTypography from '@mui/material/Typography';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Divider from '@mui/material/Divider';
import MuiButton from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import CircularProgress from '@mui/material/CircularProgress';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import LanguageOutlined from '@mui/icons-material/LanguageOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import VerifiedUserOutlined from '@mui/icons-material/VerifiedUserOutlined';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import ChatBubbleOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import FlagOutlined from '@mui/icons-material/FlagOutlined';
import type { Gym } from '@boardsesh/shared-schema';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { safeExternalHref } from '@/app/lib/safe-external-url';
import {
  GET_GYM,
  DELETE_GYM,
  FOLLOW_GYM,
  UNFOLLOW_GYM,
  type GetGymQueryResponse,
  type GetGymQueryVariables,
  type DeleteGymMutationVariables,
  type DeleteGymMutationResponse,
} from '@boardsesh/graphql/operations';
import { useSession } from 'next-auth/react';
import { gymClaimCtaClicked } from '@boardsesh/analytics';
import { trackGymFunnelEvent, viewerStateFrom } from '@/app/lib/gym-funnel-analytics';
import { themeTokens } from '@/app/theme/theme-config';
import FollowButton from '@/app/components/ui/follow-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { GYM_KIOSK_FLAG } from '@/app/flags';
import EditGymForm from './edit-gym-form';
import GymMemberManagement from './gym-member-management';
import ClaimGymDialog from './claim-gym-dialog';
import ReportDuplicateDialog from './report-duplicate-dialog';
import GymStatChip from './gym-stat-chip';
import CommentSection from '@/app/components/social/comment-section';

type GymDetailProps = {
  gymUuid: string;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
  anchor?: 'top' | 'bottom';
};

export default function GymDetail({ gymUuid, open, onClose, onDeleted, anchor = 'bottom' }: GymDetailProps) {
  const { t } = useTranslation('boards');
  const { t: tKiosk } = useTranslation('kiosk');
  const kioskFlag = useFeatureFlag(GYM_KIOSK_FLAG);
  const [gym, setGym] = useState<Gym | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showClaimDialog, setShowClaimDialog] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  // `isAuthenticated` rather than useSession().status: its query is gated on
  // `status !== 'loading'`, so a gym fetched through this token means the
  // session already settled — no pre-hydration `loading` masquerading as
  // signed-out on the claim CTA event.
  const { token, isAuthenticated } = useWsAuthToken();
  const { data: session } = useSession();
  const { showMessage } = useSnackbar();
  const currentUserId = session?.user?.id ?? null;

  const fetchGym = useCallback(async () => {
    if (!token || !gymUuid) return;
    setIsLoading(true);
    try {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<GetGymQueryResponse, GetGymQueryVariables>(GET_GYM, {
        gymUuid,
      });
      setGym(data.gym ?? null);
    } catch (error) {
      console.error('Failed to fetch gym:', error);
    } finally {
      setIsLoading(false);
    }
  }, [token, gymUuid]);

  useEffect(() => {
    if (open) {
      void fetchGym();
      setIsEditing(false);
      setActiveTab(0);
      // This is a single reused instance across gyms — clear per-gym dialog state.
      setShowClaimDialog(false);
      setShowReportDialog(false);
      setShowDeleteDialog(false);
    }
  }, [open, fetchGym]);

  const isOwner = !!currentUserId && gym?.ownerId === currentUserId;
  const isOwnerOrAdmin = isOwner || gym?.myRole === 'admin';

  const handleDeleteConfirm = async () => {
    if (!token || !gym) return;

    setShowDeleteDialog(false);
    setIsDeleting(true);
    try {
      const client = createGraphQLHttpClient(token);
      await client.request<DeleteGymMutationResponse, DeleteGymMutationVariables>(DELETE_GYM, {
        gymUuid: gym.uuid,
      });
      showMessage(t('gymEntity.snackbar.deleted'), 'success');
      onDeleted?.();
      onClose();
    } catch (error) {
      console.error('Failed to delete gym:', error);
      showMessage(t('gymEntity.snackbar.deleteFailed'), 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEditSuccess = (updatedGym: Gym) => {
    setGym(updatedGym);
    setIsEditing(false);
  };

  let drawerContent: React.ReactNode;
  if (isLoading) {
    drawerContent = (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
        <CircularProgress />
      </Box>
    );
  } else if (!gym) {
    drawerContent = (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
        <MuiTypography color="text.secondary">{t('gymEntity.notFound')}</MuiTypography>
      </Box>
    );
  } else if (isEditing) {
    drawerContent = (
      <Box sx={{ px: 2, pb: 2, overflow: 'auto', flex: 1 }}>
        <EditGymForm gym={gym} onSuccess={handleEditSuccess} onCancel={() => setIsEditing(false)} />
      </Box>
    );
  } else {
    drawerContent = (
      <>
        {/* Header */}
        <Box sx={{ px: 2, pb: 2 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 1,
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {gym.slug ? (
                <MuiLink
                  component={LocaleLink}
                  href={`/gym/${gym.slug}`}
                  underline="hover"
                  color="inherit"
                  variant="h5"
                  sx={{ display: 'block', fontWeight: themeTokens.typography.fontWeight.bold }}
                >
                  {gym.name}
                </MuiLink>
              ) : (
                <MuiTypography variant="h5" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
                  {gym.name}
                </MuiTypography>
              )}
              {gym.address && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                  <LocationOnOutlined sx={{ fontSize: 16, color: 'var(--neutral-400)' }} />
                  <MuiTypography variant="body2" color="text.secondary">
                    {gym.address}
                  </MuiTypography>
                </Box>
              )}
              {safeExternalHref(gym.website) && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                  <LanguageOutlined sx={{ fontSize: 16, color: 'var(--neutral-400)' }} />
                  <MuiLink
                    href={safeExternalHref(gym.website) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                    underline="hover"
                  >
                    {(gym.website ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </MuiLink>
                </Box>
              )}
            </Box>
          </Box>

          {/* Owner info */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5 }}>
            <Avatar src={gym.ownerAvatarUrl ?? undefined} sx={{ width: 24, height: 24, fontSize: 11 }}>
              {gym.ownerDisplayName?.[0]?.toUpperCase()}
            </Avatar>
            <MuiTypography variant="body2" color="text.secondary">
              {gym.ownerDisplayName}
            </MuiTypography>
          </Box>

          {gym.description && (
            <MuiTypography variant="body2" sx={{ mt: 1.5, color: 'var(--neutral-600)' }}>
              {gym.description}
            </MuiTypography>
          )}

          {/* Stats */}
          <Box sx={{ display: 'flex', gap: 2.5, mt: 2, flexWrap: 'wrap' }}>
            <GymStatChip
              icon={<FitnessCenterOutlined sx={{ fontSize: 16 }} />}
              value={gym.boardCount}
              label={t('gymEntity.stats.boards')}
            />
            <GymStatChip
              icon={<PersonOutlined sx={{ fontSize: 16 }} />}
              value={gym.memberCount}
              label={t('gymEntity.stats.members')}
            />
            <GymStatChip
              icon={<PeopleOutlined sx={{ fontSize: 16 }} />}
              value={gym.followerCount}
              label={t('gymEntity.stats.followers')}
            />
            <GymStatChip
              icon={<ChatBubbleOutlined sx={{ fontSize: 16 }} />}
              value={gym.commentCount}
              label={t('gymEntity.stats.comments')}
            />
          </Box>

          {/* Actions */}
          <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
            {!isOwner && (
              <FollowButton
                entityId={gym.uuid}
                initialIsFollowing={gym.isFollowedByMe}
                followMutation={FOLLOW_GYM}
                unfollowMutation={UNFOLLOW_GYM}
                entityLabel={t('gymEntity.follow.entityLabel')}
                getFollowVariables={(id) => ({ input: { gymUuid: id } })}
                onFollowChange={() => fetchGym()}
              />
            )}
            {gym.canEdit && kioskFlag && (
              <MuiButton
                component={LocaleLink}
                href={`/gym/${gym.slug ?? gym.uuid}/manage?tab=profile`}
                variant="outlined"
                size="small"
                startIcon={<EditOutlined />}
                sx={{ textTransform: 'none' }}
              >
                {t('gymEntity.actions.edit')}
              </MuiButton>
            )}
            {gym.canEdit && !kioskFlag && (
              <MuiButton
                variant="outlined"
                size="small"
                startIcon={<EditOutlined />}
                onClick={() => setIsEditing(true)}
                sx={{ textTransform: 'none' }}
              >
                {t('gymEntity.actions.edit')}
              </MuiButton>
            )}
            {gym.canEdit && kioskFlag && (
              <MuiButton
                component={LocaleLink}
                href={`/gym/${gym.slug ?? gym.uuid}/manage`}
                variant="outlined"
                size="small"
                startIcon={<SettingsOutlined />}
                sx={{ textTransform: 'none' }}
              >
                {tKiosk('gymPage.manageGym')}
              </MuiButton>
            )}
            {gym.canClaim && (
              <MuiButton
                variant="outlined"
                size="small"
                startIcon={<VerifiedUserOutlined />}
                onClick={() => {
                  trackGymFunnelEvent(
                    gymClaimCtaClicked({
                      placement: 'preview-sheet',
                      viewerState: viewerStateFrom(isAuthenticated),
                      gymUuid: gym.uuid,
                    }),
                  );
                  setShowClaimDialog(true);
                }}
                sx={{ textTransform: 'none' }}
              >
                {t('gymEntity.actions.claim')}
              </MuiButton>
            )}
            {isOwner && (
              <MuiButton
                variant="outlined"
                size="small"
                color="error"
                startIcon={<DeleteOutlined />}
                onClick={() => setShowDeleteDialog(true)}
                disabled={isDeleting}
                sx={{ textTransform: 'none' }}
              >
                {isDeleting ? <CircularProgress size={16} /> : t('gymEntity.actions.delete')}
              </MuiButton>
            )}
          </Box>

          {/* Low-key "see two of this gym?" flag for any signed-in climber. */}
          {currentUserId && (
            <MuiButton
              variant="text"
              size="small"
              startIcon={<FlagOutlined sx={{ fontSize: 16 }} />}
              onClick={() => setShowReportDialog(true)}
              sx={{ textTransform: 'none', mt: 1, color: 'text.secondary' }}
            >
              {t('reportDuplicate.cta')}
            </MuiButton>
          )}
        </Box>

        <Divider />

        {/* Tabs */}
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)} sx={{ px: 2 }}>
          <Tab label={t('gymEntity.tabs.members')} sx={{ textTransform: 'none' }} />
          <Tab label={t('gymEntity.tabs.comments')} sx={{ textTransform: 'none' }} />
        </Tabs>

        {/* Tab content */}
        <Box sx={{ flex: 1, overflow: 'auto', px: 2, py: 2 }}>
          {activeTab === 0 && (
            <GymMemberManagement
              gymUuid={gym.uuid}
              isOwnerOrAdmin={isOwnerOrAdmin}
              canGrantAccess={gym.canGrantAccess ?? false}
              onMembersChanged={fetchGym}
            />
          )}
          {activeTab === 1 && (
            <CommentSection entityType="gym" entityId={gym.uuid} title={t('gymEntity.comments.title')} />
          )}
        </Box>
      </>
    );
  }

  return (
    <>
      <SwipeableDrawer
        placement={anchor}
        open={open}
        onClose={onClose}
        height="90dvh"
        styles={{ body: { padding: 0, overflow: 'hidden' } }}
      >
        {drawerContent}
      </SwipeableDrawer>

      {/* Claim gym dialog */}
      {gym && (
        <ClaimGymDialog
          gymUuid={gym.uuid}
          gymName={gym.name}
          website={gym.website}
          canClaimByDomain={gym.canClaimByDomain}
          open={showClaimDialog}
          onClose={() => setShowClaimDialog(false)}
        />
      )}

      {/* Report a duplicate dialog */}
      {gym && (
        <ReportDuplicateDialog
          gymUuid={gym.uuid}
          gymName={gym.name}
          latitude={gym.latitude}
          longitude={gym.longitude}
          open={showReportDialog}
          onClose={() => setShowReportDialog(false)}
        />
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteDialog} onClose={() => setShowDeleteDialog(false)}>
        <DialogTitle>{t('gymEntity.delete.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('gymEntity.delete.confirm', { name: gym?.name ?? '' })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <MuiButton onClick={() => setShowDeleteDialog(false)}>{t('gymEntity.delete.cancel')}</MuiButton>
          <MuiButton onClick={handleDeleteConfirm} color="error" autoFocus>
            {t('gymEntity.delete.delete')}
          </MuiButton>
        </DialogActions>
      </Dialog>
    </>
  );
}

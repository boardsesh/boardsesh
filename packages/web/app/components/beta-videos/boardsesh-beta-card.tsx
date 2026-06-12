'use client';

import React, { useState } from 'react';
import Instagram from '@mui/icons-material/Instagram';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import Avatar from '@mui/material/Avatar';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { track } from '@/app/lib/analytics';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import { isInstagramUrl, isTikTokUrl } from '@/app/lib/beta-video-url';
import LocaleLink from '@/app/components/i18n/locale-link';
import TikTokIcon from './tiktok-icon';
import styles from './boardsesh-beta.module.css';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  DELETE_BETA_LINK,
  type DeleteBetaLinkMutationVariables,
  type DeleteBetaLinkMutationResponse,
} from '@boardsesh/graphql/operations';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';

type BoardseshBetaCardSource = 'home' | 'drawer' | 'profile';

type BoardseshBetaCardProps = {
  link: BetaLink;
  /**
   * Board type (e.g. "kilter", "tension"). Required to call the deleteBetaLink
   * mutation; when omitted the delete option is not shown.
   */
  boardType?: string | null;
  /**
   * Optional climb label rendered as a top-anchored chip. Only the
   * home-screen slider passes this — the per-climb drawer slider omits it
   * because every card belongs to the same climb.
   */
  climbName?: string | null;
  /**
   * When provided alongside a climbName, the chip becomes a link to the
   * climb's view page. Falls back to a plain span when null.
   */
  climbHref?: string | null;
  /**
   * Surfaces where this card appears. Tagged on the analytics event so we
   * can measure CTR per placement.
   */
  source?: BoardseshBetaCardSource;
};

const BoardseshBetaCard: React.FC<BoardseshBetaCardProps> = ({
  link,
  boardType,
  climbName,
  climbHref,
  source = 'drawer',
}) => {
  const { t } = useTranslation('feed');
  const { data: session } = useSession();
  const { token } = useWsAuthToken();
  const queryClient = useQueryClient();
  const { showMessage } = useSnackbar();
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const thumbnailSrc = !thumbnailFailed ? link.thumbnail : null;
  const isTikTok = isTikTokUrl(link.link);
  const isInstagram = !isTikTok && isInstagramUrl(link.link);
  const PlatformIcon = isTikTok ? TikTokIcon : Instagram;
  const displayPlatform = isTikTok ? 'TikTok' : 'Instagram';
  let analyticsPlatform: 'TikTok' | 'Instagram' | 'Unknown' = 'Unknown';
  if (isTikTok) {
    analyticsPlatform = 'TikTok';
  } else if (isInstagram) {
    analyticsPlatform = 'Instagram';
  }

  const climbLabel = climbName?.trim() ? climbName : null;
  const climbHrefEffective = climbLabel && climbHref ? climbHref : null;

  const attachedByUser = link.attached_by_user;
  const isOwner = attachedByUser && boardType && session?.user?.id === attachedByUser.id;

  const ariaLabel =
    `Open beta on ${displayPlatform}` +
    (link.foreign_username ? ` by ${link.foreign_username}` : '') +
    (climbLabel ? ` for ${climbLabel}` : '');

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!token || !boardType) throw new Error('Auth token or boardType not available');
      const client = createGraphQLHttpClient(token);
      const variables: DeleteBetaLinkMutationVariables = {
        boardType,
        climbUuid: link.climb_uuid,
        link: link.link,
      };
      await client.request<DeleteBetaLinkMutationResponse>(DELETE_BETA_LINK, variables);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['betaLinks'] });
      showMessage(t('betaVideos.deleteSuccess'), 'success');
    },
    onError: () => {
      showMessage(t('betaVideos.deleteError'), 'error');
    },
  });

  return (
    <article className={styles.card}>
      <div className={styles.thumbnailWrapper}>
        <a
          href={link.link}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.bodyLink}
          aria-label={ariaLabel}
          onClick={() =>
            track('Beta Video Link Clicked', {
              platform: analyticsPlatform,
              climbUuid: link.climb_uuid,
              source,
              ...(link.foreign_username ? { foreignUsername: link.foreign_username } : {}),
            })
          }
        >
          {thumbnailSrc ? (
            <img
              src={thumbnailSrc}
              alt={`Beta by ${link.foreign_username || 'unknown'}`}
              className={styles.thumbnail}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setThumbnailFailed(true)}
            />
          ) : (
            <div className={styles.thumbnailPlaceholder}>
              <PlatformIcon sx={{ fontSize: 28, color: 'var(--neutral-400)' }} />
            </div>
          )}
          <span className={styles.platformBadge} aria-label={`From ${displayPlatform}`}>
            <PlatformIcon sx={{ fontSize: 12 }} />
          </span>
          {attachedByUser ? (
            <span className={styles.userChip}>
              <Avatar
                src={attachedByUser.avatarUrl ?? undefined}
                sx={{ width: 14, height: 14, display: 'inline-flex', verticalAlign: 'middle' }}
              />{' '}
              {attachedByUser.displayName ?? attachedByUser.id}
              {link.foreign_username && <> {t('betaVideos.viaHandle', { handle: link.foreign_username })}</>}
            </span>
          ) : (
            link.foreign_username && <span className={styles.userChip}>@{link.foreign_username}</span>
          )}
        </a>
        {isOwner && (
          <>
            <IconButton
              size="small"
              className={styles.kebabButton}
              aria-label="More options"
              onClick={(e) => {
                e.stopPropagation();
                setMenuAnchor(e.currentTarget);
              }}
            >
              <MoreVertIcon sx={{ fontSize: 14, color: 'white' }} />
            </IconButton>
            <Menu
              anchorEl={menuAnchor}
              open={Boolean(menuAnchor)}
              onClose={() => setMenuAnchor(null)}
              onClick={(e) => e.stopPropagation()}
            >
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  deleteMutation.mutate();
                }}
                disabled={deleteMutation.isPending}
              >
                <ListItemIcon>
                  <DeleteOutlineIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('betaVideos.deleteLink')}</ListItemText>
              </MenuItem>
            </Menu>
          </>
        )}
        {climbLabel &&
          (climbHrefEffective ? (
            <LocaleLink
              href={climbHrefEffective}
              prefetch={false}
              className={styles.climbChip}
              aria-label={`View climb ${climbLabel}`}
              onClick={() =>
                track('Beta Video Climb Clicked', {
                  platform: analyticsPlatform,
                  climbUuid: link.climb_uuid,
                  source,
                })
              }
            >
              {climbLabel}
            </LocaleLink>
          ) : (
            <span className={styles.climbChip}>{climbLabel}</span>
          ))}
      </div>
    </article>
  );
};

export default BoardseshBetaCard;

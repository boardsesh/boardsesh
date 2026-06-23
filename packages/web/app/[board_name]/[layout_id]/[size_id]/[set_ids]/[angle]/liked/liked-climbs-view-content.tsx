'use client';

import React, { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import { FavoriteOutlined, SentimentDissatisfiedOutlined, MoreVertOutlined, AddOutlined } from '@mui/icons-material';
import { track } from '@/app/lib/analytics';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { executeGraphQL } from '@/app/lib/graphql/client';
import {
  type GetUserFavoriteClimbsQueryResponse,
  type GetUserFavoriteClimbsQueryVariables,
  GET_USER_FAVORITE_CLIMBS,
} from '@boardsesh/graphql/operations/favorites';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useQueueActions } from '@/app/components/graphql-queue';
import BackButton from '@/app/components/back-button';
import LikedClimbsList from './liked-climbs-list';
import styles from '@/app/components/library/playlist-view.module.css';

type LikedClimbsViewContentProps = {
  boardDetails: BoardDetails;
  angle: number;
};

export default function LikedClimbsViewContent({ boardDetails, angle }: LikedClimbsViewContentProps) {
  const { t } = useTranslation('climbs');
  const { showMessage } = useSnackbar();
  const [isAddingToQueue, setIsAddingToQueue] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const addingToQueueRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const { addToQueue } = useQueueActions();

  const getBackUrl = () => {
    return '/playlists';
  };

  const handleAddAllToQueue = useCallback(async () => {
    if (!token || addingToQueueRef.current) return;

    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    addingToQueueRef.current = true;
    setIsAddingToQueue(true);
    setMenuAnchor(null);

    try {
      const allClimbs: Climb[] = [];
      let page = 0;
      let hasMore = true;
      const pageSize = 100;

      while (hasMore) {
        if (abortController.signal.aborted) return;

        const response = await executeGraphQL<GetUserFavoriteClimbsQueryResponse, GetUserFavoriteClimbsQueryVariables>(
          GET_USER_FAVORITE_CLIMBS,
          {
            input: {
              boardName: boardDetails.board_name,
              layoutId: boardDetails.layout_id,
              sizeId: boardDetails.size_id,
              setIds: boardDetails.set_ids.join(','),
              angle,
              page,
              pageSize,
            },
          },
          token,
        );

        if (abortController.signal.aborted) return;

        const climbs = response.userFavoriteClimbs.climbs;
        for (const climb of climbs) {
          allClimbs.push({ ...climb, angle } as Climb);
        }
        hasMore = response.userFavoriteClimbs.hasMore;
        page++;
      }

      if (allClimbs.length === 0) {
        showMessage(t('liked.noClimbsToAdd'), 'info');
        return;
      }

      for (const climb of allClimbs) {
        addToQueue(climb, 'playlist');
      }

      track('Liked Climbs Add All To Queue', {
        climbCount: allClimbs.length,
      });

      showMessage(t('liked.addedToQueue', { count: allClimbs.length }), 'success');
    } catch (err) {
      if (abortController.signal.aborted) return;
      console.error('Error adding climbs to queue:', err);
      showMessage(t('liked.addToQueueFailed'), 'error');
    } finally {
      addingToQueueRef.current = false;
      setIsAddingToQueue(false);
    }
  }, [token, boardDetails, angle, addToQueue, showMessage, t]);

  if (tokenLoading) {
    return (
      <div className={styles.loadingContainer}>
        <LoadingSpinner size={48} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className={styles.errorContainer}>
        <SentimentDissatisfiedOutlined className={styles.errorIcon} />
        <div className={styles.errorTitle}>{t('liked.signInRequired')}</div>
        <div className={styles.errorMessage}>{t('liked.signInBody')}</div>
      </div>
    );
  }

  return (
    <>
      {/* Back Button */}
      <div className={styles.actionsSection}>
        <BackButton fallbackUrl={getBackUrl()} />
      </div>

      {/* Main Content */}
      <div className={styles.contentWrapper}>
        {/* Hero Card */}
        <div className={styles.heroSection}>
          <div className={styles.heroContent}>
            <div
              className={styles.heroSquare}
              style={{ background: 'linear-gradient(135deg, var(--color-error), #e57373)' }}
            >
              <FavoriteOutlined className={styles.heroSquareIcon} />
            </div>
            <div className={styles.heroInfo}>
              <Typography variant="h5" component="h2" className={styles.heroName}>
                {t('liked.heroTitle')}
              </Typography>
              <div className={styles.heroMeta}>
                <span className={styles.heroMetaItem}>{t('liked.heroSubtitle')}</span>
              </div>
            </div>
          </div>

          {/* Ellipsis Menu */}
          <IconButton
            className={styles.heroMenuButton}
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            aria-label={t('liked.actionsAriaLabel')}
          >
            <MoreVertOutlined />
          </IconButton>

          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
            <MenuItem onClick={handleAddAllToQueue} disabled={isAddingToQueue}>
              <ListItemIcon>
                <AddOutlined />
              </ListItemIcon>
              <ListItemText>{isAddingToQueue ? t('liked.adding') : t('liked.queueAll')}</ListItemText>
            </MenuItem>
          </Menu>
        </div>

        {/* Climbs List */}
        <LikedClimbsList boardDetails={boardDetails} angle={angle} />
      </div>
    </>
  );
}

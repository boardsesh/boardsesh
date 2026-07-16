'use client';

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import UnifiedSearchDrawer from '../search-drawer/unified-search-drawer';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { GYM_KIOSK_FLAG } from '@/app/flags';
import { useMyGyms } from '@/app/hooks/use-my-gyms';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import { resolveGymRole, type GymRoleKind } from '@/app/lib/gym-role';
import styles from './my-gyms-drawer.module.css';

type MyGymsDrawerProps = {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
};

type ChipColor = 'primary' | 'secondary' | 'default';

const ROLE_CHIP_COLOR: Record<GymRoleKind, ChipColor> = {
  owner: 'primary',
  admin: 'secondary',
  editor: 'default',
  member: 'default',
};

export default function MyGymsDrawer({ open, onClose, onTransitionEnd }: MyGymsDrawerProps) {
  const { t } = useTranslation('common');
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;
  // Kill switch for the manage surface — mirrors gym-detail.tsx and the public
  // gym page's Manage button, which both hide manage entry points until the
  // gym-kiosk feature ships broadly. The drawer and View action stay ungated.
  const kioskFlag = useFeatureFlag(GYM_KIOSK_FLAG);
  const { gyms, isLoading, isFetchingMore, hasMore, loadMore, error } = useMyGyms(open);
  const { sentinelRef } = useInfiniteScroll({ onLoadMore: loadMore, hasMore, isFetching: isFetchingMore });
  const [showSearch, setShowSearch] = useState(false);
  const [searchRendered, setSearchRendered] = useState(false);

  const roleLabel = useCallback(
    (role: GymRoleKind): string => {
      switch (role) {
        case 'owner':
          return t('myGyms.roleOwner');
        case 'admin':
          return t('myGyms.roleAdmin');
        case 'editor':
          return t('myGyms.roleEditor');
        case 'member':
          return t('myGyms.roleMember');
      }
    },
    [t],
  );

  const openSearch = useCallback(() => {
    setSearchRendered(true);
    setShowSearch(true);
  }, []);

  const handleSearchTransitionEnd = useCallback((searchOpen: boolean) => {
    if (!searchOpen) setSearchRendered(false);
  }, []);

  const headerExtra = (
    <IconButton size="small" onClick={openSearch} aria-label={t('myGyms.ariaFindGym')}>
      <SearchOutlined fontSize="small" />
    </IconButton>
  );

  const renderContent = () => {
    if (error && gyms.length === 0) {
      return (
        <div className={styles.emptyState} data-testid="my-gyms-error">
          <Alert severity="error" sx={{ width: '100%' }}>
            {t('myGyms.loadError')}
          </Alert>
        </div>
      );
    }
    if (isLoading && gyms.length === 0) {
      return (
        <div className={styles.loadingState} data-testid="my-gyms-loading">
          <CircularProgress size={32} />
        </div>
      );
    }
    if (gyms.length === 0) {
      return (
        <div className={styles.emptyState} data-testid="my-gyms-empty">
          <FitnessCenterOutlined sx={{ fontSize: 48, color: 'var(--neutral-300)' }} />
          <Typography variant="body2" color="text.secondary">
            {t('myGyms.empty')}
          </Typography>
          <MuiButton variant="contained" startIcon={<SearchOutlined />} onClick={openSearch} data-testid="my-gyms-find">
            {t('myGyms.findGym')}
          </MuiButton>
        </div>
      );
    }
    return (
      <div className={styles.gymList} data-testid="my-gyms-list">
        {gyms.map((gym) => {
          const role = resolveGymRole(gym, currentUserId);
          // The manage route resolves a bare UUID (slug-less legacy gyms), but the
          // public gym page only resolves by slug — so "View" is offered only when
          // the gym has a public slug to link to.
          const manageHref = `/gym/${gym.slug ?? gym.uuid}/manage`;
          const viewHref = gym.slug ? `/gym/${gym.slug}` : null;
          return (
            <div key={gym.uuid} className={styles.gymItem} data-testid={`gym-item-${gym.uuid}`}>
              <div className={styles.gymItemIcon}>
                <FitnessCenterOutlined />
              </div>
              <div className={styles.gymItemInfo}>
                <div className={styles.gymItemHeader}>
                  <span className={styles.gymItemName}>{gym.name}</span>
                  {role && <Chip size="small" label={roleLabel(role)} color={ROLE_CHIP_COLOR[role]} />}
                </div>
                {gym.address && <div className={styles.gymItemMeta}>{gym.address}</div>}
              </div>
              <div className={styles.gymItemActions}>
                {gym.canEdit && kioskFlag && (
                  <MuiButton
                    component={LocaleLink}
                    href={manageHref}
                    onClick={onClose}
                    size="small"
                    variant="outlined"
                    startIcon={<SettingsOutlined />}
                    sx={{ textTransform: 'none' }}
                    data-testid={`gym-manage-${gym.uuid}`}
                  >
                    {t('myGyms.manage')}
                  </MuiButton>
                )}
                {viewHref && (
                  <MuiButton
                    component={LocaleLink}
                    href={viewHref}
                    onClick={onClose}
                    size="small"
                    variant="text"
                    startIcon={<VisibilityOutlined />}
                    sx={{ textTransform: 'none' }}
                    data-testid={`gym-view-${gym.uuid}`}
                  >
                    {t('myGyms.view')}
                  </MuiButton>
                )}
              </div>
            </div>
          );
        })}
        <div ref={sentinelRef} />
        {isFetchingMore && (
          <div className={styles.loadingMore}>
            <CircularProgress size={20} />
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <SwipeableDrawer
        title={t('myGyms.title')}
        placement="bottom"
        open={open}
        onClose={onClose}
        onTransitionEnd={onTransitionEnd}
        height="100%"
        fullHeight
        extra={headerExtra}
        styles={{ body: { padding: 0 } }}
      >
        {renderContent()}
      </SwipeableDrawer>

      {searchRendered && (
        <UnifiedSearchDrawer
          open={showSearch}
          onClose={() => setShowSearch(false)}
          onTransitionEnd={handleSearchTransitionEnd}
          defaultCategory="gyms"
          allowedCategories={['gyms']}
          showCloseButton
        />
      )}
    </>
  );
}

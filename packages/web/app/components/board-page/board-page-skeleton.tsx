'use client';

import React from 'react';
import Box from '@mui/material/Box';
import MuiCard from '@mui/material/Card';
import CardHeader from '@mui/material/CardHeader';
import CardContent from '@mui/material/CardContent';
import CardActions from '@mui/material/CardActions';
import MuiSkeleton from '@mui/material/Skeleton';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import CallSplitOutlined from '@mui/icons-material/CallSplitOutlined';
import FavoriteBorderOutlined from '@mui/icons-material/FavoriteBorderOutlined';
import AddCircleOutlined from '@mui/icons-material/AddCircleOutlined';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './board-page-skeleton.module.css';

/**
 * Skeleton that mimics the ClimbCard title structure (horizontal layout with V grade)
 */
const ClimbCardTitleSkeleton = () => (
  <Box sx={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
    {/* Left side: Name and info stacked */}
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
      <MuiSkeleton variant="rounded" width="60%" height={24} sx={{ minWidth: 80 }} animation="wave" />
      <MuiSkeleton variant="rounded" width="80%" height={14} sx={{ minWidth: 100 }} animation="wave" />
    </Box>
    {/* Right side: V grade placeholder */}
    <MuiSkeleton variant="rounded" width={32} height={32} animation="wave" />
  </Box>
);

/**
 * Skeleton that mimics the BoardRenderer - placeholder for the board image.
 * Uses the actual board's aspect ratio to prevent layout shift when content loads.
 */
const BoardRendererSkeleton = ({ aspectRatio }: { aspectRatio?: number }) => (
  <MuiSkeleton
    variant="rounded"
    animation="wave"
    sx={{
      width: '100%',
      minHeight: '40vh',
      aspectRatio: aspectRatio ? `${aspectRatio}` : '1 / 1.1',
    }}
  />
);

/**
 * Skeleton loading UI for ClimbCard, matching the card structure with muted action icons.
 */
const ClimbCardSkeleton = ({ aspectRatio }: { aspectRatio?: number }) => (
  <MuiCard
    sx={{
      backgroundColor: 'var(--semantic-surface)',
    }}
  >
    <CardHeader title={<ClimbCardTitleSkeleton />} sx={{ paddingTop: '8px', paddingBottom: '6px' }} />
    <CardContent sx={{ p: '6px', display: 'flex', justifyContent: 'center' }}>
      <BoardRendererSkeleton aspectRatio={aspectRatio} />
    </CardContent>
    <CardActions sx={{ justifyContent: 'space-around' }}>
      <InfoOutlined key="info" sx={{ color: 'var(--neutral-300)' }} />
      <CallSplitOutlined key="fork" sx={{ color: 'var(--neutral-300)' }} />
      <FavoriteBorderOutlined key="heart" sx={{ color: 'var(--neutral-300)' }} />
      <AddCircleOutlined key="plus" sx={{ color: 'var(--neutral-300)' }} />
    </CardActions>
  </MuiCard>
);

/**
 * Skeleton that mimics the ClimbListItem layout (~60px rows with thumbnail, text, and grade).
 */
const ClimbListItemSkeleton = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
      gap: themeTokens.spacing[3],
      backgroundColor: 'var(--semantic-surface)',
      borderBottom: `1px solid var(--neutral-200)`,
    }}
  >
    {/* Thumbnail placeholder - matches ClimbListItem width of themeTokens.spacing[16] (64px) */}
    <div style={{ width: themeTokens.spacing[16], flexShrink: 0 }}>
      <MuiSkeleton variant="rounded" width={48} height={48} animation="wave" />
    </div>

    {/* Center: Name and setter lines */}
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
      <MuiSkeleton variant="rounded" width="55%" height={16} sx={{ minWidth: 80 }} animation="wave" />
      <MuiSkeleton variant="rounded" width="35%" height={12} sx={{ minWidth: 60 }} animation="wave" />
    </Box>

    {/* Right: Ascent + Grade placeholder - matches ClimbListItem flex container */}
    <div style={{ display: 'flex', alignItems: 'center', gap: themeTokens.spacing[1], flexShrink: 0 }}>
      <MuiSkeleton variant="rounded" width={24} height={24} animation="wave" />
    </div>

    {/* Ellipsis dot placeholder */}
    <MuiSkeleton variant="rounded" width={24} height={24} animation="wave" />
  </div>
);

/**
 * Skeleton loading UI for the board page.
 * Defaults to list mode skeletons since SSR default is 'list'.
 * Includes a sidebar placeholder on desktop (min-width: 768px) to prevent layout shift.
 */
const BoardPageSkeleton = () => {
  return (
    <>
      {/* Main content - always visible, defaults to list mode (SSR default) */}
      <div className={styles.skeletonMain}>
        {Array.from({ length: 10 }, (_, i) => (
          <ClimbListItemSkeleton key={i} />
        ))}
      </div>

      {/* Sidebar placeholder - only visible on desktop via CSS to reserve space */}
      <div className={styles.skeletonSider} />
    </>
  );
};

export default BoardPageSkeleton;
export { ClimbCardSkeleton, ClimbListItemSkeleton };

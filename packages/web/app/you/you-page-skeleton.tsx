'use client';

import React from 'react';
import Box from '@mui/material/Box';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Skeleton from '@mui/material/Skeleton';
import styles from '@/app/profile/[user_id]/profile-page.module.css';

export default function YouPageSkeleton() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <MuiCard className={styles.profileCard}>
        <CardContent>
          <Box className={styles.profileInfo}>
            <Skeleton variant="circular" width={80} height={80} animation="wave" />
            <Box className={styles.profileDetails} sx={{ gap: 1 }}>
              <Skeleton variant="text" width={180} height={28} animation="wave" />
              <Skeleton variant="text" width={120} height={20} animation="wave" />
            </Box>
          </Box>
        </CardContent>
      </MuiCard>

      <Skeleton variant="rounded" height={120} animation="wave" sx={{ borderRadius: '12px' }} />
      <Skeleton variant="rounded" height={200} animation="wave" sx={{ borderRadius: '12px' }} />
      <Skeleton variant="rounded" height={160} animation="wave" sx={{ borderRadius: '12px' }} />

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={72} animation="wave" sx={{ borderRadius: '12px' }} />
        ))}
      </Box>
    </Box>
  );
}

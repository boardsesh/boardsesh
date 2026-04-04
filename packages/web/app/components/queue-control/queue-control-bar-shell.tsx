'use client';

import React from 'react';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './queue-control-bar.module.css';

interface QueueControlBarShellProps {
  message?: string;
}

export default function QueueControlBarShell({
  message = 'No climb selected',
}: QueueControlBarShellProps) {
  return (
    <div
      id="onboarding-queue-bar"
      className={`queue-bar-shadow ${styles.queueBar}`}
      data-testid="queue-control-bar-shell"
    >
      <MuiCard variant="outlined" className={styles.card} sx={{ border: 'none', backgroundColor: 'transparent' }}>
        <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
          <div className={styles.swipeWrapper}>
            <div
              className={styles.swipeContainer}
              style={{
                padding: `6px ${themeTokens.spacing[3]}px 6px ${themeTokens.spacing[3]}px`,
                backgroundColor: 'var(--semantic-surface)',
              }}
            >
              <Box sx={{ display: 'flex', flexWrap: 'nowrap', justifyContent: 'space-between', alignItems: 'center' }} className={styles.row}>
                <Box sx={{ flex: 1 }} className={styles.climbInfoCol}>
                  <div className={styles.climbInfoInner} style={{ gap: themeTokens.spacing[2] }}>
                    <div aria-hidden="true" className={`${styles.boardPreviewContainer} ${styles.shellThumbnail}`} />
                    <span className={styles.shellTitle}>{message}</span>
                  </div>
                </Box>

                <Box sx={{ flex: 'none', marginLeft: `${themeTokens.spacing[2]}px` }}>
                  <Stack direction="row" spacing={1} aria-hidden="true">
                    <span className={styles.shellControl} />
                    <span className={styles.shellControl} />
                    <span className={styles.shellControlWide} />
                  </Stack>
                </Box>
              </Box>
            </div>
          </div>
        </CardContent>
      </MuiCard>
    </div>
  );
}

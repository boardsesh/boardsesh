'use client';

import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import MuiAlert from '@mui/material/Alert';
import MuiButton from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import MuiAvatar from '@mui/material/Avatar';
import Stack from '@mui/material/Stack';
import {
  CheckCircleOutlined,
  GitHub,
} from '@mui/icons-material';
import { useSession } from 'next-auth/react';
import AuthModal from '@/app/components/auth/auth-modal';
import BoardImportPrompt from '@/app/components/settings/board-import-prompt';
import UserSmartCard from '@/app/components/user-smart-card/user-smart-card';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './aurora-migration.module.css';

export default function AuroraMigrationContent() {
  const { data: session, status } = useSession();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [smartCardRefreshKey, setSmartCardRefreshKey] = useState(0);
  const isAuthenticated = status === 'authenticated';

  const handleImportComplete = useCallback(() => {
    setSmartCardRefreshKey((prev) => prev + 1);
  }, []);

  return (
    <Box className={styles.pageLayout}>
      <Box component="main" className={styles.content}>
        <Stack spacing={3}>
          {/* Section 1: What Happened */}
          <MuiCard>
            <CardContent>
              <Stack spacing={2} className={styles.cardContent}>
                <Typography variant="h5">
                  What Happened
                </Typography>

                <Typography variant="body1" component="p" sx={{ fontWeight: 600 }}>
                  The Aurora Kilter backend is gone. Your playlists, logbook, and
                  draft climbs go with it unless you export them.
                </Typography>

                <Typography variant="body1" component="p">
                  Today the Kilter board app suddenly disappeared, as Aurora randomly
                  shut down its Kilter backend. In response Kilter rushed out their own
                  app which was still in beta, but the outcome of these two entities
                  fighting is that the customer gets left holding the bag, and everyone
                  likely has lost their data (including playlists, logbooks and draft
                  climbs).
                </Typography>

                <Typography variant="body1" component="p">
                  This single-vendor risk first became obvious 2 years ago, when you
                  couldn&apos;t buy an LED kit for your Kilter holds due to an ongoing
                  legal dispute between Kilter and Aurora.
                </Typography>

                <Typography variant="body1" component="p">
                  To remove this risk,{' '}
                  <MuiLink href="https://www.boardsesh.com" target="_blank" rel="noopener noreferrer">
                    Boardsesh
                  </MuiLink>{' '}
                  was created as an open-source alternative to all board climbing apps.
                  Boardsesh has its own copy of the climb databases and will eventually
                  support all boards. It can easily be self-hosted, and will provide
                  data checkout functionality.
                </Typography>
              </Stack>
            </CardContent>
          </MuiCard>

          {/* Section 2: How to Migrate */}
          <MuiCard>
            <CardContent>
              <Stack spacing={3} className={styles.cardContent}>
                <Typography variant="h5">
                  How to Migrate
                </Typography>

                {/* Step 1: Request data export */}
                <div className={styles.stepRow}>
                  <MuiAvatar
                    className={styles.stepNumber}
                    sx={{
                      width: 32,
                      height: 32,
                      fontSize: 14,
                      fontWeight: 600,
                      bgcolor: themeTokens.colors.primary,
                    }}
                  >
                    1
                  </MuiAvatar>
                  <div className={styles.stepContent}>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                      Request your data export
                    </Typography>
                    <Typography variant="body1" component="p">
                      Email Aurora to request an export of your data. This will give you
                      a JSON file containing your ascents, attempts, and circuits.
                    </Typography>
                    <MuiButton
                      variant="outlined"
                      size="small"
                      component="a"
                      href="mailto:peter@auroraclimbing.com?subject=Data%20Export%20Request&body=Hi%20Peter%2C%0A%0ACould%20you%20please%20send%20me%20an%20export%20of%20my%20Aurora%20data%3F%0A%0AThank%20you"
                      sx={{ mt: 1, textTransform: 'none' }}
                    >
                      Email peter@auroraclimbing.com
                    </MuiButton>
                  </div>
                </div>

                {/* Step 2: Create account / Sign in */}
                <div className={styles.stepRow}>
                  <MuiAvatar
                    className={styles.stepNumber}
                    sx={{
                      width: 32,
                      height: 32,
                      fontSize: 14,
                      fontWeight: 600,
                      bgcolor: isAuthenticated ? themeTokens.colors.success : themeTokens.colors.primary,
                    }}
                  >
                    {isAuthenticated ? <CheckCircleOutlined sx={{ fontSize: 18 }} /> : '2'}
                  </MuiAvatar>
                  <div className={styles.stepContent}>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                      Create a Boardsesh account
                    </Typography>
                    {isAuthenticated ? (
                      <MuiAlert severity="success" icon={<CheckCircleOutlined />}>
                        Signed in as {session?.user?.email}
                      </MuiAlert>
                    ) : (
                      <>
                        <Typography variant="body1" component="p">
                          Create an account or sign in so we have somewhere to put your data.
                        </Typography>
                        <MuiButton
                          variant="contained"
                          size="small"
                          onClick={() => setAuthModalOpen(true)}
                          sx={{ mt: 1, textTransform: 'none' }}
                        >
                          Sign in or Create Account
                        </MuiButton>
                      </>
                    )}
                  </div>
                </div>

                {/* Step 3: Import data */}
                <div className={styles.stepRow}>
                  <MuiAvatar
                    className={styles.stepNumber}
                    sx={{
                      width: 32,
                      height: 32,
                      fontSize: 14,
                      fontWeight: 600,
                      bgcolor: themeTokens.colors.primary,
                    }}
                  >
                    3
                  </MuiAvatar>
                  <div className={styles.stepContent}>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                      Import your data
                    </Typography>
                    {!isAuthenticated && (
                      <Typography variant="body2" color="text.secondary">
                        Sign in first to import your data.
                      </Typography>
                    )}
                  </div>
                </div>

                {isAuthenticated && (
                  <Stack spacing={2}>
                    <Typography variant="body1" component="p">
                      The Kilter backend is down so only JSON import is available for
                      Kilter. For Tension, linking your account will automatically sync
                      your data every 12 hours so you always have a backup.
                    </Typography>
                    <BoardImportPrompt boardType="kilter" onImportComplete={handleImportComplete} />
                    <BoardImportPrompt boardType="tension" onImportComplete={handleImportComplete} />
                  </Stack>
                )}

                {/* Step 4: Your Profile */}
                <div className={styles.stepRow}>
                  <MuiAvatar
                    className={styles.stepNumber}
                    sx={{
                      width: 32,
                      height: 32,
                      fontSize: 14,
                      fontWeight: 600,
                      bgcolor: themeTokens.colors.primary,
                    }}
                  >
                    4
                  </MuiAvatar>
                  <div className={styles.stepContent}>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                      Check out your profile
                    </Typography>
                    {isAuthenticated && session?.user?.id ? (
                      <Stack spacing={1.5}>
                        <Typography variant="body1" component="p">
                          Your climbing stats live here. After importing, this card updates with your data.
                        </Typography>
                        <UserSmartCard
                          userId={session.user.id}
                          refreshKey={smartCardRefreshKey}
                        />
                      </Stack>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Sign in to see a preview of your profile.
                      </Typography>
                    )}
                  </div>
                </div>
              </Stack>
            </CardContent>
          </MuiCard>

          {/* Section 4: Get Help */}
          <MuiCard>
            <CardContent>
              <Stack spacing={2} className={styles.cardContent}>
                <Typography variant="h5">
                  <GitHub className={`${styles.sectionIcon}`} />
                  Get Help
                </Typography>

                <Typography variant="body1" component="p">
                  Boardsesh is open source. File bugs, request features, or just ask for help.
                </Typography>

                <Stack spacing={1}>
                  <MuiLink
                    href="https://discord.gg/YXA8GsXfQK"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Discord &mdash; Join for help and discussion
                  </MuiLink>
                  <MuiLink
                    href="https://github.com/boardsesh/boardsesh"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub &mdash; github.com/boardsesh/boardsesh
                  </MuiLink>
                </Stack>
              </Stack>
            </CardContent>
          </MuiCard>
        </Stack>
      </Box>

      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        title="Sign in to migrate your data"
        description="Create an account or sign in to import your Aurora data."
      />
    </Box>
  );
}

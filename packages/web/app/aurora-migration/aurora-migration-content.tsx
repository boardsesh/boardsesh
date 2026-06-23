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
import { CheckCircleOutlined, GitHub } from '@mui/icons-material';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import BoardImportPrompt from '@/app/components/settings/board-import-prompt';
import UserSmartCard from '@/app/components/social/user-smart-card';
import styles from './aurora-migration.module.css';

export default function AuroraMigrationContent() {
  const { t } = useTranslation('aurora');
  const { data: session, status } = useSession();
  const { openAuthModal } = useAuthModal();
  const [importRefreshKey, setImportRefreshKey] = useState(0);
  const isAuthenticated = status === 'authenticated';

  const handleImportComplete = useCallback(() => {
    setImportRefreshKey((prev: number) => prev + 1);
  }, []);

  return (
    <Box className={styles.pageLayout}>
      <Box component="main" className={styles.content}>
        <Stack spacing={3}>
          {/* Section 1: What Happened */}
          <MuiCard>
            <CardContent>
              <Stack spacing={2} className={styles.cardContent}>
                <Typography variant="h5">{t('migration.whatHappened.title')}</Typography>

                <Typography variant="body1" component="p" sx={{ fontWeight: 600 }}>
                  {t('migration.whatHappened.lead')}
                </Typography>

                <Typography variant="body1" component="p">
                  {t('migration.whatHappened.body')}
                </Typography>

                <MuiLink
                  href="https://www.climbing.com/news/why-the-kilter-board-app-suddenly-disappeared/"
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="none"
                  className={styles.articleCard}
                >
                  <Box
                    component="img"
                    src="https://cdn.climbing.com/wp-content/uploads/2026/03/Untitled-design-1-2.jpg"
                    alt={t('migration.whatHappened.articleAlt')}
                    loading="lazy"
                    onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                      e.currentTarget.style.display = 'none';
                    }}
                    className={styles.articleImage}
                  />
                  <Box className={styles.articleBody}>
                    <Typography variant="subtitle2" color="text.primary" className={styles.articleTitle}>
                      {t('migration.whatHappened.articleTitle')}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" className={styles.articleDescription}>
                      {t('migration.whatHappened.articleDescription')}
                    </Typography>
                    <Typography variant="caption" color="text.disabled">
                      {t('migration.whatHappened.articleSource')}
                    </Typography>
                  </Box>
                </MuiLink>

                <Typography variant="body1" component="p">
                  {t('migration.whatHappened.ledRisk')}
                </Typography>

                <Typography variant="body1" component="p">
                  {t('migration.whatHappened.boardseshIntroPrefix')}
                  <MuiLink href="https://www.boardsesh.com" target="_blank" rel="noopener noreferrer">
                    {t('migration.whatHappened.boardseshLink')}
                  </MuiLink>
                  {t('migration.whatHappened.boardseshIntroSuffix')}
                </Typography>
              </Stack>
            </CardContent>
          </MuiCard>

          {/* Section 2: How to Migrate */}
          <MuiCard>
            <CardContent>
              <Stack spacing={3} className={styles.cardContent}>
                <Typography variant="h5">{t('migration.howToMigrate.title')}</Typography>

                {/* Step 1: Request data export */}
                <div className={styles.stepRow}>
                  <MuiAvatar
                    className={styles.stepNumber}
                    sx={{
                      width: 32,
                      height: 32,
                      fontSize: 14,
                      fontWeight: 600,
                      bgcolor: 'var(--color-primary-fill)',
                    }}
                  >
                    1
                  </MuiAvatar>
                  <div className={styles.stepContent}>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                      {t('migration.howToMigrate.step1.title')}
                    </Typography>
                    <Typography variant="body1" component="p">
                      {t('migration.howToMigrate.step1.body')}
                    </Typography>
                    <MuiButton
                      variant="outlined"
                      size="small"
                      component="a"
                      href="mailto:peter@auroraclimbing.com?subject=Data%20Export%20Request&body=Hi%20Peter%2C%0A%0ACould%20you%20please%20send%20me%20an%20export%20of%20my%20Aurora%20data%3F%0A%0AThank%20you"
                      sx={{ mt: 1, textTransform: 'none' }}
                    >
                      {t('migration.howToMigrate.step1.cta')}
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
                      bgcolor: isAuthenticated ? 'var(--color-success)' : 'var(--color-primary-fill)',
                    }}
                  >
                    {isAuthenticated ? <CheckCircleOutlined sx={{ fontSize: 18 }} /> : '2'}
                  </MuiAvatar>
                  <div className={styles.stepContent}>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                      {t('migration.howToMigrate.step2.title')}
                    </Typography>
                    {isAuthenticated ? (
                      <MuiAlert severity="success" icon={<CheckCircleOutlined />}>
                        {t('migration.howToMigrate.step2.signedInAs', { email: session?.user?.email ?? '' })}
                      </MuiAlert>
                    ) : (
                      <>
                        <Typography variant="body1" component="p">
                          {t('migration.howToMigrate.step2.body')}
                        </Typography>
                        <MuiButton
                          variant="contained"
                          size="small"
                          onClick={() =>
                            openAuthModal({
                              title: t('migration.howToMigrate.step2.modalTitle'),
                              description: t('migration.howToMigrate.step2.modalDescription'),
                            })
                          }
                          sx={{ mt: 1, textTransform: 'none' }}
                        >
                          {t('migration.howToMigrate.step2.cta')}
                        </MuiButton>
                      </>
                    )}
                  </div>
                </div>

                {/* Step 3: Link Aurora account & import data */}
                <div className={styles.stepRow}>
                  <MuiAvatar
                    className={styles.stepNumber}
                    sx={{
                      width: 32,
                      height: 32,
                      fontSize: 14,
                      fontWeight: 600,
                      bgcolor: 'var(--color-primary-fill)',
                    }}
                  >
                    3
                  </MuiAvatar>
                  <div className={styles.stepContent}>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                      {t('migration.howToMigrate.step3.title')}
                    </Typography>
                    {!isAuthenticated && (
                      <Typography variant="body2" color="text.secondary">
                        {t('migration.howToMigrate.step3.signInFirst')}
                      </Typography>
                    )}
                  </div>
                </div>

                {isAuthenticated && (
                  <Stack spacing={2}>
                    <Typography variant="body1" component="p">
                      {t('migration.howToMigrate.step3.body')}
                    </Typography>
                    <BoardImportPrompt boardType="kilter" onImportComplete={handleImportComplete} />
                    <BoardImportPrompt boardType="tension" onImportComplete={handleImportComplete} />
                  </Stack>
                )}

                {/* Step 4: Your profile */}
                <div className={styles.stepRow}>
                  <MuiAvatar
                    className={styles.stepNumber}
                    sx={{
                      width: 32,
                      height: 32,
                      fontSize: 14,
                      fontWeight: 600,
                      bgcolor: 'var(--color-primary-fill)',
                    }}
                  >
                    4
                  </MuiAvatar>
                  <div className={styles.stepContent}>
                    <Typography variant="h6" sx={{ mb: 1 }}>
                      {t('migration.howToMigrate.step4.title')}
                    </Typography>
                    {!isAuthenticated && (
                      <Typography variant="body2" color="text.secondary">
                        {t('migration.howToMigrate.step4.signInFirst')}
                      </Typography>
                    )}
                  </div>
                </div>

                {isAuthenticated && session?.user?.id && (
                  <UserSmartCard userId={session.user.id} refreshKey={importRefreshKey} />
                )}
              </Stack>
            </CardContent>
          </MuiCard>

          {/* Section 4: Get Help */}
          <MuiCard>
            <CardContent>
              <Stack spacing={2} className={styles.cardContent}>
                <Typography variant="h5">
                  <GitHub className={`${styles.sectionIcon}`} />
                  {t('migration.getHelp.title')}
                </Typography>

                <Typography variant="body1" component="p">
                  {t('migration.getHelp.body')}
                </Typography>

                <Stack spacing={1}>
                  <MuiLink href="https://discord.gg/YXA8GsXfQK" target="_blank" rel="noopener noreferrer">
                    {t('migration.getHelp.discord')}
                  </MuiLink>
                  <MuiLink href="https://github.com/boardsesh/boardsesh" target="_blank" rel="noopener noreferrer">
                    {t('migration.getHelp.github')}
                  </MuiLink>
                </Stack>
              </Stack>
            </CardContent>
          </MuiCard>
        </Stack>
      </Box>
    </Box>
  );
}

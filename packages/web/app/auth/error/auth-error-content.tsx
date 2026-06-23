'use client';

import React from 'react';
import MuiAlert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import { useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import { themeTokens } from '@/app/theme/theme-config';
import { getAuthErrorMessage } from './get-error-message';

export default function AuthErrorContent() {
  const { t } = useTranslation('auth');
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  return (
    <Box sx={{ minHeight: '100vh', background: 'var(--semantic-background)' }}>
      <Box
        component="header"
        sx={{
          background: 'var(--semantic-surface)',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          boxShadow: themeTokens.shadows.xs,
          height: 64,
        }}
      >
        <BackButton />
        <Logo size="sm" showText={false} />
        <Typography variant="h4" sx={{ margin: 0, flex: 1 }}>
          {t('error.header')}
        </Typography>
      </Box>

      <Box
        component="main"
        sx={{
          padding: '24px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          paddingTop: '48px',
        }}
      >
        <Card sx={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>
          <CardContent>
            <Stack spacing={3} sx={{ width: '100%' }}>
              <CancelOutlined sx={{ fontSize: 48, color: 'var(--color-error)', mx: 'auto' }} />
              <Typography variant="h3">{t('error.title')}</Typography>
              <MuiAlert severity="error">{getAuthErrorMessage(error, t)}</MuiAlert>
              <Button variant="contained" href="/auth/login" fullWidth size="large">
                {t('error.back')}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}

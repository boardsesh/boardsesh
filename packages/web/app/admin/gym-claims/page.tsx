'use client';

import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_MY_ROLES } from '@boardsesh/graphql/operations/proposals';
import type { CommunityRoleAssignment } from '@boardsesh/shared-schema';
import GymClaimsPanel from '@/app/components/admin/gym-claims-panel';
import LocaleLink from '@/app/components/i18n/locale-link';

export default function AdminGymClaimsPage() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function checkRole() {
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<{ myRoles: CommunityRoleAssignment[] }>(GET_MY_ROLES);
        setIsAdmin(result.myRoles.some((r) => r.role === 'admin'));
      } catch {
        setIsAdmin(false);
      } finally {
        setLoading(false);
      }
    }
    void checkRole();
  }, [token]);

  if (loading) return null;

  if (!token) {
    return (
      <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Alert severity="warning">{t('auth.signInRequired')}</Alert>
      </Container>
    );
  }

  if (!isAdmin) {
    return (
      <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Alert severity="error">{t('auth.noAccess')}</Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 1, color: themeTokens.neutral[800] }}>
        {t('gymClaims.title')}
      </Typography>
      <Box sx={{ mb: 3 }}>
        <MuiLink component={LocaleLink} href="/admin" underline="hover" sx={{ color: themeTokens.colors.primary }}>
          {t('gymClaims.backToAdmin')}
        </MuiLink>
      </Box>
      <GymClaimsPanel />
    </Container>
  );
}

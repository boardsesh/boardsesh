'use client';

import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Alert from '@mui/material/Alert';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_MY_ROLES } from '@boardsesh/graphql/operations/proposals';
import type { CommunityRoleAssignment } from '@boardsesh/shared-schema';
import RoleManagement from '@/app/components/admin/role-management';
import CommunitySettingsPanel from '@/app/components/admin/community-settings-panel';
import GymSettingsPanel from '@/app/components/admin/gym-settings-panel';
import LocaleLink from '@/app/components/i18n/locale-link';
import { rolesGrantGlobalAdmin, rolesGrantScopedAdmin } from '@/app/lib/admin/admin-scope';

export default function AdminPage() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [tab, setTab] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [boardScopedOnly, setBoardScopedOnly] = useState(false);
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
        // Every resolver these pages call — role grants, community settings,
        // gym settings — gates with `requireAdmin(ctx)` / `hasAdmin(userId)`
        // and no board type, which a board-scoped admin fails. Without the
        // narrower check they'd see a hub whose every action errors (and a
        // gym-settings toggle that reads "off" whatever its real value is).
        const globalAdmin = rolesGrantGlobalAdmin(result.myRoles);
        setIsAdmin(globalAdmin);
        setBoardScopedOnly(!globalAdmin && rolesGrantScopedAdmin(result.myRoles));
      } catch {
        setIsAdmin(false);
        setBoardScopedOnly(false);
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
        <Alert severity="error">{t(boardScopedOnly ? 'auth.boardScopedNoAccess' : 'auth.noAccess')}</Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 1, color: themeTokens.neutral[800] }}>
        {t('title')}
      </Typography>
      <Box sx={{ mb: 3, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        <MuiLink
          component={LocaleLink}
          href="/admin/retention"
          underline="hover"
          sx={{ color: 'var(--color-primary)' }}
        >
          {t('nav.retention')}
        </MuiLink>
        <MuiLink
          component={LocaleLink}
          href="/admin/gym-claims"
          underline="hover"
          sx={{ color: themeTokens.colors.primary }}
        >
          {t('nav.gymClaims')}
        </MuiLink>
        <MuiLink component={LocaleLink} href="/admin/feedback" underline="hover" sx={{ color: 'var(--color-primary)' }}>
          {t('nav.feedback')}
        </MuiLink>
        <MuiLink
          component={LocaleLink}
          href="/admin/gym-duplicates"
          underline="hover"
          sx={{ color: themeTokens.colors.primary }}
        >
          {t('nav.gymDuplicates')}
        </MuiLink>
        <MuiLink
          component={LocaleLink}
          href="/admin/build-plans"
          underline="hover"
          sx={{ color: themeTokens.colors.primary }}
        >
          {t('nav.buildPlans')}
        </MuiLink>
        <MuiLink
          component={LocaleLink}
          href="/admin/location-sync"
          underline="hover"
          sx={{ color: themeTokens.colors.primary }}
        >
          {t('nav.locationSync')}
        </MuiLink>
      </Box>

      <Box sx={{ borderBottom: 1, borderColor: themeTokens.neutral[200], mb: 3 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label={t('tabs.roles')} sx={{ textTransform: 'none' }} />
          <Tab label={t('tabs.settings')} sx={{ textTransform: 'none' }} />
          <Tab label={t('tabs.gyms')} sx={{ textTransform: 'none' }} />
        </Tabs>
      </Box>

      {tab === 0 && <RoleManagement />}
      {tab === 1 && <CommunitySettingsPanel />}
      {tab === 2 && <GymSettingsPanel />}
    </Container>
  );
}

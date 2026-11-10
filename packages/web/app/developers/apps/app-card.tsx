'use client';

import React from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import { useTranslation } from 'react-i18next';
import type { OAuthClient } from '@boardsesh/shared-schema';
import { PageCard } from '@/app/components/ui/page-shell';
import { themeTokens } from '@/app/theme/theme-config';
import CopyValue, { MONOSPACE_SX } from './copy-value';

type AppCardProps = {
  app: OAuthClient;
  locale: string;
  onEdit: (app: OAuthClient) => void;
  onRotate: (app: OAuthClient) => void;
  onDelete: (app: OAuthClient) => void;
  onCopyFailed: () => void;
};

function DetailRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '10rem 1fr' },
        columnGap: 2,
        rowGap: 0.5,
        py: 1.25,
        borderTop: `1px solid ${themeTokens.semantic.separator}`,
      }}
    >
      <Typography component="dt" variant="body2" color="text.secondary">
        {term}
      </Typography>
      <Box component="dd" sx={{ m: 0, minWidth: 0 }}>
        {children}
      </Box>
    </Box>
  );
}

// The two lookups below are keyed by the GraphQL enum values:
// i18n-keep developers.app.kind.WEB
// i18n-keep developers.app.kind.NATIVE
// i18n-keep developers.app.auth.NONE
// i18n-keep developers.app.auth.CLIENT_SECRET_BASIC
// i18n-keep developers.app.auth.CLIENT_SECRET_POST

function registeredDate(createdAt: string, locale: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime())
    ? createdAt
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

export default function AppCard({ app, locale, onEdit, onRotate, onDelete, onCopyFailed }: AppCardProps) {
  const { t } = useTranslation('developers');
  const suspended = app.suspendedAt !== null;
  const confidential = app.tokenEndpointAuthMethod !== 'NONE';
  const headingId = `developer-app-${app.clientId}`;
  const links = [
    { href: app.homepageUrl, label: t('app.homepage') },
    { href: app.privacyPolicyUrl, label: t('app.privacyPolicy') },
  ].filter((link): link is { href: string; label: string } => Boolean(link.href));

  return (
    <PageCard component="li" aria-labelledby={headingId} sx={{ listStyle: 'none' }}>
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              id={headingId}
              variant="h6"
              component="h2"
              sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, overflowWrap: 'anywhere' }}
            >
              {app.name}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {app.publisherName ? t('app.publisher', { publisher: app.publisherName }) : t('app.noPublisher')}
            </Typography>
          </Box>
          <Chip label={t(`app.kind.${app.applicationType}`)} size="small" variant="outlined" sx={{ flexShrink: 0 }} />
        </Box>

        {suspended ? (
          <Alert severity="warning">
            <AlertTitle>{t('app.suspended.title')}</AlertTitle>
            {app.suspensionReason
              ? t('app.suspended.body', { reason: app.suspensionReason })
              : t('app.suspended.noReason')}
          </Alert>
        ) : null}

        <Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
            {t('app.clientId')}
          </Typography>
          <CopyValue
            value={app.clientId}
            label={t('app.clientId')}
            copyLabel={t('secret.copy')}
            onCopyFailed={onCopyFailed}
          />
        </Box>

        <Box component="dl" sx={{ m: 0 }}>
          <DetailRow term={t('app.clientTypeTerm')}>
            <Typography variant="body2">{t(`app.auth.${app.tokenEndpointAuthMethod}`)}</Typography>
          </DetailRow>
          <DetailRow term={t('app.redirectUris')}>
            <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
              {app.redirectUris.map((uri) => (
                <Typography key={uri} component="li" variant="body2" sx={MONOSPACE_SX}>
                  {uri}
                </Typography>
              ))}
            </Box>
          </DetailRow>
          <DetailRow term={t('app.registeredTerm')}>
            <Typography variant="body2">{registeredDate(app.createdAt, locale)}</Typography>
          </DetailRow>
          <DetailRow term={t('app.connectionsTerm')}>
            <Typography variant="body2">
              {t('app.connections', {
                count: app.activeConnections,
                max: app.maxActiveConnections,
              })}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('app.newPerDay', { count: app.maxNewConnectionsPerDay })}
            </Typography>
          </DetailRow>
          {links.length > 0 ? (
            <DetailRow term={t('app.linksTerm')}>
              <Box
                component="ul"
                aria-label={t('app.linksLabel', { app: app.name })}
                sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', columnGap: 2 }}
              >
                {links.map((link) => (
                  <li key={link.label}>
                    <MuiLink href={link.href} target="_blank" rel="noopener noreferrer" variant="body2">
                      {link.label}
                    </MuiLink>
                  </li>
                ))}
              </Box>
            </DetailRow>
          ) : null}
        </Box>

        {suspended ? null : (
          <Box
            role="group"
            aria-label={t('app.actions.label', { app: app.name })}
            sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, pt: 0.5, '& .MuiButton-root': { minHeight: 44 } }}
          >
            <Button variant="outlined" startIcon={<EditOutlined />} onClick={() => onEdit(app)}>
              {t('app.actions.edit')}
            </Button>
            {confidential ? (
              <Button variant="outlined" startIcon={<KeyOutlined />} onClick={() => onRotate(app)}>
                {t('app.actions.rotate')}
              </Button>
            ) : null}
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteOutlined />}
              onClick={() => onDelete(app)}
              sx={{ ml: { sm: 'auto' } }}
            >
              {t('app.actions.delete')}
            </Button>
          </Box>
        )}
      </Stack>
    </PageCard>
  );
}

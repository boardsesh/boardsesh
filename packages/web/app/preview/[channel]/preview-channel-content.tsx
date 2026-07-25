'use client';

import React from 'react';
import { useTranslation, Trans } from 'react-i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import PhoneIphoneOutlined from '@mui/icons-material/PhoneIphoneOutlined';
import { QRCodeSVG } from 'qrcode.react';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { buildAppPreviewLink } from '@/app/lib/ota-preview-link';
import { themeTokens } from '@/app/theme/theme-config';

const REPO_URL = 'https://github.com/boardsesh/boardsesh';

export default function PreviewChannelContent({ channel, pullNumber }: { channel: string; pullNumber: number }) {
  const { t } = useTranslation('common');
  const appLink = buildAppPreviewLink(channel);
  const pageUrl = absoluteUrl(`/preview/${channel}`);
  const pullRequestUrl = `${REPO_URL}/pull/${pullNumber}`;

  return (
    <Box sx={{ maxWidth: 640, mx: 'auto', px: 2, py: { xs: 4, sm: 6 } }}>
      <Stack spacing={1} sx={{ mb: 3 }}>
        <Typography variant="overline" sx={{ color: themeTokens.colors.secondary }}>
          {t('otaPreview.eyebrow')}
        </Typography>
        <Typography variant="h1" sx={{ fontSize: { xs: '1.75rem', sm: '2.25rem' }, fontWeight: 700 }}>
          {t('otaPreview.heading', { number: pullNumber })}
        </Typography>
        <Typography sx={{ color: themeTokens.neutral[500] }}>{t('otaPreview.intro')}</Typography>
      </Stack>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2.5} alignItems="center">
            <Button
              variant="contained"
              size="large"
              fullWidth
              href={appLink}
              startIcon={<PhoneIphoneOutlined />}
              sx={{ py: 1.5 }}
            >
              {t('otaPreview.openInApp')}
            </Button>
            <Typography variant="body2" sx={{ color: themeTokens.neutral[500], textAlign: 'center' }}>
              {t('otaPreview.openInAppHint')}
            </Typography>

            <Divider flexItem>
              <Typography variant="body2" sx={{ color: themeTokens.neutral[500] }}>
                {t('otaPreview.qrDivider')}
              </Typography>
            </Divider>

            {/* A QR needs a light quiet zone to scan, so the tile stays white in
                both colour modes rather than inheriting the card surface. */}
            <Box sx={{ bgcolor: '#FFFFFF', borderRadius: 2, p: 2, lineHeight: 0 }}>
              <QRCodeSVG value={pageUrl} size={168} level="M" marginSize={1} aria-hidden />
            </Box>
            <Typography variant="body2" sx={{ color: themeTokens.neutral[500], textAlign: 'center' }}>
              {t('otaPreview.qrHint')}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Stack spacing={1.5} sx={{ mt: 4 }}>
        <Typography variant="h2" sx={{ fontSize: '1.125rem', fontWeight: 600 }}>
          {t('otaPreview.notesHeading')}
        </Typography>
        <Typography variant="body2" sx={{ color: themeTokens.neutral[500] }}>
          {t('otaPreview.noteBuild')}
        </Typography>
        <Typography variant="body2" sx={{ color: themeTokens.neutral[500] }}>
          {t('otaPreview.noteNative')}
        </Typography>
        <Typography variant="body2" sx={{ color: themeTokens.neutral[500] }}>
          <Trans
            i18nKey="otaPreview.noteManual"
            ns="common"
            values={{ channel }}
            components={{ code: <Box component="code" sx={{ fontFamily: 'monospace' }} /> }}
          />
        </Typography>
        <Typography variant="body2">
          <Link href={pullRequestUrl} target="_blank" rel="noopener noreferrer">
            {t('otaPreview.viewPullRequest', { number: pullNumber })}
          </Link>
        </Typography>
      </Stack>
    </Box>
  );
}

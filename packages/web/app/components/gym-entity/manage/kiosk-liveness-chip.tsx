'use client';

// Per-kiosk liveness chip for the Kiosks tab. Turns the kiosk's last-seen signal
// into an at-a-glance status: Live / Last seen X ago / No signal for X days
// (with a "Reinstall on TV" nudge) / No signal yet. The bucketing lives in the
// pure `kiosk-liveness.ts` so it's testable; this component only maps a bucket
// to MUI + copy.

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import ReplayOutlined from '@mui/icons-material/ReplayOutlined';
import type { TFunction } from 'i18next';
import { bucketKioskLiveness, type KioskLiveness } from './kiosk-liveness';
import KioskTvQrDialog from './kiosk-tv-qr-dialog';

type KioskLivenessChipProps = {
  lastSeenAt: string | null;
  kioskName: string;
  /** The kiosk's TV path (null when the gym has no slug) — for the reinstall QR. */
  tvPath: string | null;
};

type ChipColor = 'success' | 'warning' | 'default';

function livenessLabel(liveness: KioskLiveness, t: TFunction<'kiosk'>): string {
  switch (liveness.status) {
    case 'live':
      return t('manage.kiosks.liveness.live');
    case 'recent':
      return liveness.unit === 'minutes'
        ? t('manage.kiosks.liveness.lastSeenMinutes', { count: liveness.count })
        : t('manage.kiosks.liveness.lastSeenHours', { count: liveness.count });
    case 'stale':
      return t('manage.kiosks.liveness.noSignalDays', { count: liveness.days });
    case 'never':
      return t('manage.kiosks.liveness.noSignalYet');
  }
}

function livenessColor(liveness: KioskLiveness): ChipColor {
  switch (liveness.status) {
    case 'live':
      return 'success';
    case 'stale':
      return 'warning';
    case 'recent':
    case 'never':
      return 'default';
  }
}

export default function KioskLivenessChip({ lastSeenAt, kioskName, tvPath }: KioskLivenessChipProps) {
  const { t } = useTranslation('kiosk');
  const [reinstallOpen, setReinstallOpen] = useState(false);

  const liveness = bucketKioskLiveness(lastSeenAt, Date.now());
  const color = livenessColor(liveness);
  const label = livenessLabel(liveness, t);

  const chip = (
    <Chip
      size="small"
      color={color}
      // Filled for the two states an owner acts on (live is reassuring, stale is
      // a warning); outlined for the in-between "last seen …" and "no signal yet".
      variant={liveness.status === 'live' || liveness.status === 'stale' ? 'filled' : 'outlined'}
      label={label}
    />
  );

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      {/* liveness.status === 'never' covers both null and unparseable lastSeenAt
          (see bucketKioskLiveness), so the tooltip never formats an invalid date. */}
      {liveness.status === 'never' ? chip : <Tooltip title={new Date(lastSeenAt!).toLocaleString()}>{chip}</Tooltip>}
      {liveness.status === 'stale' && (
        <>
          <Button
            size="small"
            color="warning"
            startIcon={<ReplayOutlined />}
            onClick={() => setReinstallOpen(true)}
            sx={{ textTransform: 'none' }}
          >
            {t('manage.kiosks.liveness.reinstall')}
          </Button>
          <KioskTvQrDialog
            open={reinstallOpen}
            kioskName={kioskName}
            tvPath={tvPath}
            onClose={() => setReinstallOpen(false)}
          />
        </>
      )}
    </Box>
  );
}

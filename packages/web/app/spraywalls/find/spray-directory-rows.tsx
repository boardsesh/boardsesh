'use client';

import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import { useTranslation } from 'react-i18next';
import type { SprayWallDirectoryEntry } from '@boardsesh/graphql/operations';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { Locale } from '@/app/lib/i18n/config';
import styles from '@/app/gyms/gym-directory-card.module.css';

export default function SprayDirectoryRows({ walls, locale }: { walls: SprayWallDirectoryEntry[]; locale: Locale }) {
  const { t } = useTranslation('website');
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return (
    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {walls.map((wall) => (
        <Box component="li" key={wall.uuid} className={styles.row}>
          <Box className={styles.heading}>
            <Typography component="h3" variant="h6">
              <MuiLink
                component={LocaleLink}
                href={`/b/${encodeURIComponent(wall.slug)}`}
                color="text.primary"
                underline="hover"
              >
                {wall.name}
              </MuiLink>
            </Typography>
            <Chip label={t('sprayDirectory.angle', { angle: wall.angle })} size="small" />
          </Box>
          {(wall.locationName || wall.gymName) && (
            <Typography variant="body2" color="text.secondary" className={styles.location}>
              {wall.locationName || wall.gymName}
            </Typography>
          )}
          {wall.distanceMeters != null && (
            <Typography variant="body2" color="text.secondary">
              {t('sprayDirectory.distance', { distance: numberFormat.format(wall.distanceMeters / 1000) })}
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  );
}

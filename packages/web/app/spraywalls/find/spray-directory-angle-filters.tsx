'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import { useTranslation } from 'react-i18next';
import { ANGLES } from '@boardsesh/board-config';

/** FormControlLabel reads its control's props, so both stay on the same side of the RSC boundary. */
export default function SprayDirectoryAngleFilters({ selectedAngles }: { selectedAngles: number[] }) {
  const { t } = useTranslation('website');
  const { t: gyms } = useTranslation('gyms');
  return (
    <Box component="details" open={selectedAngles.length > 0 || undefined}>
      <Box component="summary" sx={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
        {gyms('filters.angleHeading')}
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {ANGLES.spray.map((angle) => (
          <FormControlLabel
            key={angle}
            control={<Checkbox name="angle" value={String(angle)} defaultChecked={selectedAngles.includes(angle)} />}
            label={t('sprayDirectory.angle', { angle })}
          />
        ))}
      </Box>
    </Box>
  );
}

'use client';

// Profile tab: the gym's core identity (name, address, website, description,
// public/private) plus the gym photo. It mounts the SAME EditGymForm the
// GymDetail sheet used — single-source, no duplicate form — and pushes saves
// back to the shell via onGymChange so sibling tabs and the Overview see the
// update. onDirtyChange bubbles the form's unsaved-edit state so the shell
// routes tab switches through the discard confirmation (parity with
// Kiosks/Branding).
//
// The photo lives here and NOT in Branding: Branding is the kiosk/embed
// surface (logo + TV brand colours), while gyms.image_url is public-profile
// content — it's the hero on /gym/<slug> and the page's share card.

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import EditGymForm from '@/app/components/gym-entity/edit-gym-form';
import { themeTokens } from '@/app/theme/theme-config';
import GymPhotoUploader from './gym-photo-uploader';
import type { GymManageTabProps } from './tab-props';

export default function ProfileTab({ gym, onGymChange, onDirtyChange }: GymManageTabProps) {
  const { t } = useTranslation('kiosk');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
          {t('manage.profile.heading')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('manage.profile.description')}
        </Typography>
      </Box>
      <GymPhotoUploader gym={gym} onGymChange={onGymChange} />
      <Divider />
      <EditGymForm gym={gym} onSuccess={onGymChange} onDirtyChange={onDirtyChange} />
    </Box>
  );
}

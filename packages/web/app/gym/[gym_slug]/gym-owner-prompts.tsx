'use client';

// Client island: low-key owner CTAs on the public gym page. The server renders
// this only for editors and passes the content-absence booleans it already
// computed from the enriched gym, so the gating is decided server-side; the
// island adds the kiosk-flag check (the manage console it links into is
// flag-gated) and renders one small outlined card per missing piece.

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import TvOutlined from '@mui/icons-material/TvOutlined';
import PaletteOutlined from '@mui/icons-material/PaletteOutlined';
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined';
import NotesOutlined from '@mui/icons-material/NotesOutlined';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { GYM_KIOSK_FLAG } from '@/app/flags';
import { themeTokens } from '@/app/theme/theme-config';
import { ownerPromptsToShow, OWNER_PROMPT_TAB, type OwnerPromptKey } from './gym-owner-prompts-logic';

type GymOwnerPromptsProps = {
  gymSlug: string;
  canEdit: boolean;
  hasBoards: boolean;
  hasHours: boolean;
  hasDescription: boolean;
  hasKiosk: boolean;
  hasBranding: boolean;
};

// Static-literal lookups: the i18n linter forbids t(variable)/t(template). No
// `default` on purpose — a new prompt key then fails typecheck here instead of
// rendering an untranslated card.
function promptTitle(t: TFunction, key: OwnerPromptKey): string {
  switch (key) {
    case 'boards':
      return t('gymPage.owner.linkBoards.title');
    case 'hours':
      return t('gymPage.owner.addHours.title');
    case 'description':
      return t('gymPage.owner.addDescription.title');
    case 'kiosk':
      return t('gymPage.owner.putOnTv.title');
    case 'branding':
      return t('gymPage.owner.addBranding.title');
  }
}

function promptBody(t: TFunction, key: OwnerPromptKey): string {
  switch (key) {
    case 'boards':
      return t('gymPage.owner.linkBoards.body');
    case 'hours':
      return t('gymPage.owner.addHours.body');
    case 'description':
      return t('gymPage.owner.addDescription.body');
    case 'kiosk':
      return t('gymPage.owner.putOnTv.body');
    case 'branding':
      return t('gymPage.owner.addBranding.body');
  }
}

function promptIcon(key: OwnerPromptKey): React.ReactNode {
  switch (key) {
    case 'boards':
      return <FitnessCenterOutlined sx={{ fontSize: 18 }} />;
    case 'hours':
      return <ScheduleOutlined sx={{ fontSize: 18 }} />;
    case 'description':
      return <NotesOutlined sx={{ fontSize: 18 }} />;
    case 'kiosk':
      return <TvOutlined sx={{ fontSize: 18 }} />;
    case 'branding':
      return <PaletteOutlined sx={{ fontSize: 18 }} />;
  }
}

export default function GymOwnerPrompts({
  gymSlug,
  canEdit,
  hasBoards,
  hasHours,
  hasDescription,
  hasKiosk,
  hasBranding,
}: GymOwnerPromptsProps) {
  const { t } = useTranslation('kiosk');
  const kioskFlag = useFeatureFlag(GYM_KIOSK_FLAG);

  // The prompts link into the manage console, which is gated until the feature
  // ships broadly — hide them entirely while the flag is off.
  if (!kioskFlag) {
    return null;
  }

  const prompts = ownerPromptsToShow({ canEdit, hasBoards, hasHours, hasDescription, hasKiosk, hasBranding });
  if (prompts.length === 0) {
    return null;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 3 }}>
      {prompts.map((key) => (
        <Card key={key} variant="outlined" sx={{ borderRadius: themeTokens.borderRadius.md, borderColor: 'divider' }}>
          <MuiLink
            component={LocaleLink}
            href={`/gym/${gymSlug}/manage?tab=${OWNER_PROMPT_TAB[key]}`}
            underline="none"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              p: 2,
              color: 'text.primary',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Box sx={{ color: 'primary.main', display: 'flex' }}>{promptIcon(key)}</Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                {promptTitle(t, key)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {promptBody(t, key)}
              </Typography>
            </Box>
            <ArrowForwardOutlined sx={{ fontSize: 18, color: 'primary.main' }} />
          </MuiLink>
        </Card>
      ))}
    </Box>
  );
}

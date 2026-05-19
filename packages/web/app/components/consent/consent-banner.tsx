'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useConsent } from './consent-context';
import ConsentDialog from './consent-dialog';

// MUI's z-index scale: Modal/Drawer/Dialog = 1300, Snackbar = 1400, Tooltip = 1500.
// The banner has to sit above everything that's persistent at the bottom of the
// viewport (snackbars in particular), otherwise an in-flight toast covers it and
// the user can't dismiss. 1500 also clears Tooltip so a hovered tooltip can't
// occlude the choice — the trade-off (banner painting over a Tooltip) is fine
// because the banner unmounts after a single click.
const Z_INDEX_CONSENT_BANNER = 1500;

/**
 * Bottom-anchored consent banner. Renders nothing once the user has
 * decided both categories. Uses a fixed `<Paper>` rather than MUI Snackbar
 * so we get edge-to-edge layout on mobile with safe-area-inset support
 * and proper word-wrapping for the body copy.
 */
export default function ConsentBanner() {
  const { t } = useTranslation('consent');
  const { isDecided, isLoading, acceptAll, rejectAll } = useConsent();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (isLoading || isDecided) {
    return <ConsentDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />;
  }

  return (
    <>
      <Box
        role="region"
        aria-labelledby="consent-banner-headline"
        data-testid="consent-banner"
        sx={(theme) => ({
          position: 'fixed',
          zIndex: Z_INDEX_CONSENT_BANNER,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          justifyContent: 'center',
          paddingX: { xs: 0, sm: 2 },
          paddingBottom: {
            xs: 'env(safe-area-inset-bottom, 0px)',
            sm: `calc(${theme.spacing(2)} + env(safe-area-inset-bottom, 0px))`,
          },
          pointerEvents: 'none',
        })}
      >
        <Paper
          elevation={8}
          sx={(theme) => ({
            pointerEvents: 'auto',
            width: '100%',
            maxWidth: { xs: '100%', sm: theme.breakpoints.values.sm },
            padding: theme.spacing(2),
            borderRadius: { xs: 0, sm: 1 },
            borderTop: { xs: `1px solid ${theme.palette.divider}`, sm: 'none' },
          })}
        >
          <Stack spacing={1.5}>
            <Stack spacing={0.5}>
              <Typography variant="subtitle1" component="h2" id="consent-banner-headline">
                {t('banner.headline')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('banner.body')}
              </Typography>
            </Stack>
            <Stack
              direction={{ xs: 'column-reverse', sm: 'row' }}
              spacing={1}
              justifyContent={{ sm: 'flex-end' }}
              alignItems={{ xs: 'stretch', sm: 'center' }}
            >
              {/* Reject and Accept share the same visual weight per GDPR
                  EDPB guidance + national-DPA enforcement (CNIL, Garante):
                  unequal-weight buttons are treated as evidence the
                  consent was nudged, not freely given. `autoFocus` on
                  Accept used to be a dark-pattern signal too — dropped. */}
              <Button variant="outlined" onClick={() => void rejectAll()} size="medium">
                {t('banner.actions.reject')}
              </Button>
              <Button variant="outlined" onClick={() => setDialogOpen(true)} size="medium">
                {t('banner.actions.customize')}
              </Button>
              <Button variant="outlined" onClick={() => void acceptAll()} size="medium">
                {t('banner.actions.acceptAll')}
              </Button>
            </Stack>
          </Stack>
        </Paper>
      </Box>
      <ConsentDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}

'use client';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { ConsentLabels } from './consent-labels';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { isChromeLessPath } from '@/app/lib/chrome-less-routes';
import { useConsent } from './consent-state-provider';
import { useConsentRegionPromptState, type ConsentRegionPromptState } from './use-consent-region-prompt';
import { loadConsentChoicesDialog } from './consent-choices-loader';
import ConsentDisclosures from './consent-disclosures';
import type { ConsentChoicesDialogProps } from './consent-choices-dialog';

export type ConsentPromptProps = {
  labels: ConsentLabels;
  children?: (region: ConsentRegionPromptState) => ReactNode;
};

export default function ConsentPrompt({ labels, children }: ConsentPromptProps) {
  const { decide, dialogOpen, openChoices, closeChoices, syncFailed, reportPromptShowing } = useConsent();
  const pathname = usePathnameWithoutLocale();
  const chromeLess = isChromeLessPath(pathname.toLowerCase());
  const [ChoicesDialog, setChoicesDialog] = useState<ComponentType<ConsentChoicesDialogProps> | null>(null);
  const pendingCloseRef = useRef<HTMLButtonElement>(null);
  const pendingOrigin = useRef<HTMLElement | null>(null);
  const previouslyOpen = useRef(false);
  useEffect(() => {
    if (chromeLess) return;
    if (dialogOpen && !previouslyOpen.current && !ChoicesDialog) {
      pendingOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      pendingCloseRef.current?.focus();
    } else if (!dialogOpen && previouslyOpen.current) {
      if (pendingOrigin.current?.isConnected) pendingOrigin.current.focus();
      pendingOrigin.current = null;
    }
    previouslyOpen.current = dialogOpen;
  }, [dialogOpen, ChoicesDialog, chromeLess]);
  useEffect(() => {
    if (!dialogOpen || ChoicesDialog || chromeLess) return;
    let mounted = true;
    void loadConsentChoicesDialog()
      .then(({ default: LoadedDialog }) => {
        if (mounted) setChoicesDialog(() => LoadedDialog);
      })
      .catch(() => {
        /* The existing compact choices stay actionable if the dialog cannot load. */
      });
    return () => {
      mounted = false;
    };
  }, [dialogOpen, ChoicesDialog, chromeLess]);
  // The banner asks only in the prompt regions (or an unknown one). Privacy
  // choices in the footer and Settings open the dialog below for everyone.
  // The welcome consumes this same lookup state, including focus refreshes.
  const region = useConsentRegionPromptState(!chromeLess);
  // The card is up, or may still come up while the region lookup is out.
  const pendingDetails = !chromeLess && dialogOpen && !ChoicesDialog;
  const promptShowing = !chromeLess && (region.prompt || !region.settled || pendingDetails);
  useEffect(() => reportPromptShowing(promptShowing), [promptShowing, reportPromptShowing]);
  if (chromeLess) return null;
  const choose = (choice: 'granted' | 'denied') => {
    void decide(choice);
    closeChoices();
  };
  return (
    <>
      {(region.prompt || pendingDetails) && (
        <Box
          className={pendingDetails ? undefined : 'analytics-consent-banner'}
          role="region"
          aria-labelledby="consent-banner-title"
          data-testid="consent-banner"
          onKeyDown={(event) => {
            if (pendingDetails && event.key === 'Escape') {
              event.preventDefault();
              closeChoices();
            }
          }}
          sx={{
            position: 'fixed',
            zIndex: (theme) => theme.zIndex.modal - 1,
            bottom: 0,
            left: 0,
            right: 0,
            px: 2,
            pb: 'max(16px, env(safe-area-inset-bottom))',
            display: 'flex',
            justifyContent: 'flex-start',
            pointerEvents: 'none',
          }}
        >
          <Paper
            elevation={8}
            sx={{
              p: 1.5,
              maxWidth: 420,
              width: '100%',
              pointerEvents: 'auto',
              maxHeight: 'calc(100dvh - 32px)',
              overflowY: 'auto',
            }}
          >
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Typography variant="h6" component="h2" id="consent-banner-title">
                  {pendingDetails ? labels.privacyChoices : labels.title}
                </Typography>
                <Button
                  variant="text"
                  size="small"
                  ref={pendingCloseRef}
                  onClick={pendingDetails ? closeChoices : openChoices}
                  aria-haspopup={pendingDetails ? undefined : 'dialog'}
                  sx={{ minHeight: 44, minWidth: 44, flexShrink: 0, textDecoration: 'underline' }}
                >
                  {pendingDetails ? labels.close : labels.details}
                </Button>
              </Stack>
              {pendingDetails ? (
                <ConsentDisclosures labels={labels} onClose={closeChoices} syncFailed={syncFailed} />
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {labels.bannerSummary}
                </Typography>
              )}
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" fullWidth sx={{ minHeight: 44 }} onClick={() => choose('granted')}>
                  {labels.allow}
                </Button>
                <Button variant="outlined" fullWidth sx={{ minHeight: 44 }} onClick={() => choose('denied')}>
                  {labels.deny}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        </Box>
      )}
      {dialogOpen && ChoicesDialog ? (
        <ChoicesDialog
          labels={labels}
          onClose={closeChoices}
          onChoose={choose}
          syncFailed={syncFailed}
          disableRestoreFocus={pendingOrigin.current !== null}
        />
      ) : null}
      {children?.(region)}
    </>
  );
}

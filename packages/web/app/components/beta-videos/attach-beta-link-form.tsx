'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InstagramIcon from '@mui/icons-material/Instagram';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { track } from '@/app/lib/analytics';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import {
  ATTACH_BETA_LINK,
  type AttachBetaLinkMutationVariables,
  type AttachBetaLinkMutationResponse,
} from '@boardsesh/graphql/operations';
import {
  isBetaVideoUrl,
  isInstagramUrl,
  isTikTokUrl,
  BETA_VIDEO_URL_VALIDATION_MESSAGE,
} from '@/app/lib/beta-video-url';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { buildInstagramCaption, copyAndOpenInstagram } from '@/app/lib/instagram-posting';
import { extractGraphQLErrorMessage } from '@/app/lib/graphql/extract-error-message';

export type AttachBetaLinkSurface = 'play-view' | 'logbook' | 'instagram-dialog' | 'climb-actions' | 'unknown';

type AttachBetaLinkFormProps = {
  boardType: string;
  climbUuid: string;
  climbName?: string;
  angle?: number | null;
  grade?: string | null;
  setter?: string | null;
  layoutId?: number | null;
  surface?: AttachBetaLinkSurface;
  resetTrigger?: unknown;
  submitLabel?: string;
  helperText?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  showCancel?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  showStepsGuide?: boolean;
};

const AttachBetaLinkForm: React.FC<AttachBetaLinkFormProps> = ({
  boardType,
  climbUuid,
  climbName,
  angle,
  grade,
  setter,
  layoutId,
  surface = 'unknown',
  resetTrigger,
  submitLabel,
  helperText,
  onSuccess,
  onCancel,
  showCancel = false,
  autoFocus = false,
  compact = false,
  showStepsGuide = false,
}) => {
  const { t } = useTranslation('feed');
  const resolvedSubmitLabel = submitLabel ?? t('betaVideos.shareBeta');
  const [url, setUrl] = useState('');
  const [isLaunchingInstagram, setIsLaunchingInstagram] = useState(false);
  const { token } = useWsAuthToken();
  const queryClient = useQueryClient();
  const { showMessage } = useSnackbar();

  const instagramCaption = useMemo(() => {
    if (!climbName || angle == null) return '';
    return buildInstagramCaption({
      climbName,
      angle,
      boardType,
      grade,
      setter,
      layoutId,
    });
  }, [climbName, angle, boardType, grade, setter, layoutId]);

  useEffect(() => {
    setUrl('');
  }, [resetTrigger]);

  const trimmed = url.trim();
  const validationError = trimmed && !isBetaVideoUrl(trimmed) ? BETA_VIDEO_URL_VALIDATION_MESSAGE : null;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('Auth token not available');
      const client = createGraphQLHttpClient(token);
      const variables: AttachBetaLinkMutationVariables = {
        input: {
          boardType,
          climbUuid,
          link: trimmed,
          angle: angle ?? undefined,
        },
      };
      await client.request<AttachBetaLinkMutationResponse>(ATTACH_BETA_LINK, variables);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['betaLinks', boardType, climbUuid] });
      let platform: 'TikTok' | 'Instagram' | 'Unknown' = 'Unknown';
      if (isTikTokUrl(trimmed)) {
        platform = 'TikTok';
      } else if (isInstagramUrl(trimmed)) {
        platform = 'Instagram';
      }
      track('Beta Video Added', { boardType, climbUuid, platform });
      showMessage(t('betaVideos.addedToast'), 'success');
      setUrl('');
      onSuccess?.();
    },
    onError: (error) => {
      // Surface the GraphQL resolver's user-facing error message (the validator
      // throws InstagramBetaValidationError with a message we want users to
      // see). Don't fall back to error.message — for non-GraphQL failures
      // (network, library internals, type assertions) that field can carry
      // raw stack traces or implementation strings that shouldn't be shown.
      const serverMessage = extractGraphQLErrorMessage(error);
      showMessage(serverMessage ?? t('betaVideos.addError'), 'error');
    },
  });

  const canSubmit = !!trimmed && !validationError && !mutation.isPending;

  const handleCopyAndOpenInstagram = async () => {
    if (!instagramCaption || isLaunchingInstagram) return;
    track('Beta Caption Copy Clicked', { boardType, climbUuid, surface });
    setIsLaunchingInstagram(true);
    let result: { copied: boolean; opened: boolean };
    try {
      result = await copyAndOpenInstagram(instagramCaption);
    } catch {
      // Defensive: copyAndOpenInstagram catches its own errors but a thrown
      // navigation/clipboard exception from a restricted browser context
      // would otherwise leave the button stuck in the launching state.
      track('Beta Caption Copy Failed', { boardType, climbUuid, surface, reason: 'copyFailed' });
      showMessage(t('betaVideos.instagramCopyFailed'), 'error');
      return;
    } finally {
      setIsLaunchingInstagram(false);
    }

    if (!result.copied) {
      track('Beta Caption Copy Failed', { boardType, climbUuid, surface, reason: 'copyFailed' });
      showMessage(t('betaVideos.instagramCopyFailed'), 'error');
      return;
    }

    track('Beta Caption Copied', { boardType, climbUuid, surface, opened: result.opened });

    if (!result.opened) {
      // Copy succeeded — let the user paste manually wherever they want.
      showMessage(t('betaVideos.instagramCopiedOnly'), 'success');
      return;
    }

    showMessage(t('betaVideos.instagramCopiedAndOpened'), 'success');
  };

  const urlFieldLabel = climbName ? t('betaVideos.urlLabelForClimb', { name: climbName }) : t('betaVideos.urlLabel');
  const urlField = (
    <TextField
      autoFocus={autoFocus}
      fullWidth
      placeholder={t('betaVideos.urlPlaceholder')}
      label={showStepsGuide ? undefined : urlFieldLabel}
      inputProps={showStepsGuide ? { 'aria-label': urlFieldLabel } : undefined}
      value={url}
      onChange={(e) => setUrl(e.target.value)}
      error={!!validationError}
      helperText={validationError ?? helperText ?? t('betaVideos.defaultHelper')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && canSubmit) {
          e.preventDefault();
          mutation.mutate();
        }
      }}
    />
  );

  const instagramButton = instagramCaption ? (
    <Button
      variant="outlined"
      onClick={handleCopyAndOpenInstagram}
      disabled={isLaunchingInstagram || mutation.isPending}
      startIcon={isLaunchingInstagram ? <CircularProgress size={16} /> : <InstagramIcon />}
      sx={showStepsGuide ? { alignSelf: 'flex-start' } : { mr: 'auto' }}
    >
      {t('betaVideos.copyAndOpenInstagram')}
    </Button>
  ) : null;

  const cancelButton =
    showCancel && onCancel ? (
      <Button onClick={onCancel} disabled={mutation.isPending}>
        {t('betaVideos.cancel')}
      </Button>
    ) : null;

  const submitButton = (
    <Button
      variant="contained"
      onClick={() => mutation.mutate()}
      disabled={!canSubmit}
      startIcon={mutation.isPending ? <CircularProgress size={16} /> : undefined}
    >
      {resolvedSubmitLabel}
    </Button>
  );

  if (showStepsGuide) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: compact ? 1.5 : 1.75 }}>
        <StepRow index={1} title={t('betaVideos.steps.step1Title')} optionalLabel={t('betaVideos.steps.optional')}>
          {instagramButton}
        </StepRow>
        <StepRow index={2} title={t('betaVideos.steps.step2Title')} optionalLabel={t('betaVideos.steps.optional')} />
        <StepRow index={3} title={t('betaVideos.steps.step3Title')}>
          {urlField}
        </StepRow>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
          {cancelButton}
          {submitButton}
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: compact ? 1.25 : 1.5 }}>
      {urlField}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
        {instagramButton}
        {cancelButton}
        {submitButton}
      </Box>
    </Box>
  );
};

type StepRowProps = {
  index: number;
  title: string;
  optionalLabel?: string;
  children?: React.ReactNode;
};

const StepRow: React.FC<StepRowProps> = ({ index, title, optionalLabel, children }) => (
  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
    <Typography variant="body1" sx={{ lineHeight: 1.5 }}>
      <Box component="span" sx={{ color: 'text.primary', fontWeight: 700, mr: 1 }}>
        {index}.
      </Box>
      {title}
      {optionalLabel && (
        <Box component="span" sx={{ color: 'text.secondary', ml: 1, typography: 'caption' }}>
          ({optionalLabel})
        </Box>
      )}
    </Typography>
    {children}
  </Box>
);

export default AttachBetaLinkForm;

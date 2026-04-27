'use client';

import React, { useState, useEffect } from 'react';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { track } from '@/app/lib/analytics';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import {
  ATTACH_BETA_LINK,
  type AttachBetaLinkMutationVariables,
  type AttachBetaLinkMutationResponse,
} from '@/app/lib/graphql/operations';
import {
  isBetaVideoUrl,
  isInstagramUrl,
  isTikTokUrl,
  BETA_VIDEO_URL_VALIDATION_MESSAGE,
} from '@/app/lib/beta-video-url';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';

// graphql-request throws ClientError-shaped errors with a `response.errors[]`
// array. We trust those messages because they come from our own resolvers
// (zod errors, InstagramBetaValidationError, our explicit throws). Anything
// else — fetch failures, library bugs, `error.message` — is opaque and we
// fall back to the generic toast so we never leak internal strings.
export function extractGraphQLErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  if (!('response' in error)) return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object' || !('errors' in response)) return null;
  const errors = (response as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  if (!first || typeof first !== 'object' || !('message' in first)) return null;
  const message = (first as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

type AttachBetaLinkFormProps = {
  boardType: string;
  climbUuid: string;
  climbName?: string;
  angle?: number | null;
  resetTrigger?: unknown;
  submitLabel?: string;
  helperText?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  showCancel?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
};

const AttachBetaLinkForm: React.FC<AttachBetaLinkFormProps> = ({
  boardType,
  climbUuid,
  climbName,
  angle,
  resetTrigger,
  submitLabel = 'Share beta',
  helperText,
  onSuccess,
  onCancel,
  showCancel = false,
  autoFocus = false,
  compact = false,
}) => {
  const [url, setUrl] = useState('');
  const { token } = useWsAuthToken();
  const queryClient = useQueryClient();
  const { showMessage } = useSnackbar();

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
      const platform = isTikTokUrl(trimmed) ? 'TikTok' : isInstagramUrl(trimmed) ? 'Instagram' : 'Unknown';
      track('Beta Video Added', { boardType, climbUuid, platform });
      showMessage('Video added to beta', 'success');
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
      showMessage(serverMessage ?? 'Couldn’t add video. Try again.', 'error');
    },
  });

  const canSubmit = !!trimmed && !validationError && !mutation.isPending;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: compact ? 1.25 : 1.5 }}>
      <TextField
        autoFocus={autoFocus}
        fullWidth
        placeholder="Instagram or TikTok URL"
        label={climbName ? `Beta video URL for ${climbName}` : 'Beta video URL'}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        error={!!validationError}
        helperText={
          validationError ??
          helperText ??
          (climbName
            ? `Paste a public Instagram reel or post that mentions ${climbName}, or a TikTok URL.`
            : 'Paste a public Instagram reel/post or TikTok URL so others can see your beta.')
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canSubmit) {
            e.preventDefault();
            mutation.mutate();
          }
        }}
      />

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        {showCancel && onCancel && (
          <Button onClick={onCancel} disabled={mutation.isPending}>
            Cancel
          </Button>
        )}
        <Button
          variant="contained"
          onClick={() => mutation.mutate()}
          disabled={!canSubmit}
          startIcon={mutation.isPending ? <CircularProgress size={16} /> : undefined}
        >
          {submitLabel}
        </Button>
      </Box>
    </Box>
  );
};

export default AttachBetaLinkForm;

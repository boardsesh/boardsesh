'use client';

import React, { useState, useEffect } from 'react';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import {
  ATTACH_BETA_LINK,
  type AttachBetaLinkMutationVariables,
  type AttachBetaLinkMutationResponse,
} from '@/app/lib/graphql/operations';
import { isInstagramUrl } from '@/app/lib/instagram-url';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';

interface AttachBetaLinkFormProps {
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
}

export const AttachBetaLinkForm: React.FC<AttachBetaLinkFormProps> = ({
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
  const validationError =
    trimmed && !isInstagramUrl(trimmed)
      ? 'Needs to be an Instagram post or reel URL'
      : null;

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
      queryClient.invalidateQueries({ queryKey: ['betaLinks', boardType, climbUuid] });
      showMessage('Video added to beta', 'success');
      setUrl('');
      onSuccess?.();
    },
    onError: (error) => {
      let message = 'Couldn’t add video. Try again.';
      if (error instanceof Error) {
        if ('response' in error && typeof error.response === 'object' && error.response !== null) {
          const response = error.response as { errors?: Array<{ message: string }> };
          if (response.errors?.length) {
            message = response.errors[0].message;
          }
        } else {
          message = error.message;
        }
      }
      showMessage(message, 'error');
    },
  });

  const canSubmit = !!trimmed && !validationError && !mutation.isPending;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: compact ? 1.25 : 1.5 }}>
      <TextField
        autoFocus={autoFocus}
        fullWidth
        placeholder="https://www.instagram.com/reel/..."
        label={climbName ? `Instagram URL for ${climbName}` : 'Instagram URL'}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        error={!!validationError}
        helperText={
          validationError ??
          helperText ??
          (climbName
            ? `Paste a public Instagram reel or post that mentions ${climbName}.`
            : 'Paste a public Instagram reel or post URL.')
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

'use client';

import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import MuiButton from '@mui/material/Button';
import MuiTypography from '@mui/material/Typography';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import { themeTokens } from '@/app/theme/theme-config';

const MAX_BODY_LENGTH = 2000;
const COUNTER_THRESHOLD = 1800;

interface CommentFormProps {
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  initialBody?: string;
  placeholder?: string;
  autoFocus?: boolean;
  submitLabel?: string;
  isPrivateUser?: boolean;
  isPublic?: boolean;
  onIsPublicChange?: (value: boolean) => void;
}

export default function CommentForm({
  onSubmit,
  onCancel,
  initialBody = '',
  placeholder = 'Add a comment...',
  autoFocus = false,
  submitLabel = 'Post',
  isPrivateUser = false,
  isPublic = false,
  onIsPublicChange,
}: CommentFormProps) {
  const [body, setBody] = useState(initialBody);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit(trimmed);
      if (!initialBody) {
        setBody('');
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [body, isSubmitting, onSubmit, initialBody]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const isOverLimit = body.length > MAX_BODY_LENGTH;
  const showCounter = body.length > COUNTER_THRESHOLD;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <TextField
        multiline
        minRows={2}
        maxRows={6}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={isSubmitting}
        size="small"
        fullWidth
      />
      {isPrivateUser && (
        <Box>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={isPublic}
                onChange={(e) => onIsPublicChange?.(e.target.checked)}
                disabled={isSubmitting}
              />
            }
            label="Post publicly"
            slotProps={{ typography: { variant: 'body2' } }}
          />
          <FormHelperText sx={{ mt: -0.5, ml: 4 }}>
            Lets climbers who don&apos;t follow you see this comment.
          </FormHelperText>
        </Box>
      )}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          {showCounter && (
            <MuiTypography
              variant="caption"
              sx={{ color: isOverLimit ? themeTokens.colors.error : 'var(--neutral-400)' }}
            >
              {body.length}/{MAX_BODY_LENGTH}
            </MuiTypography>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          {onCancel && (
            <MuiButton size="small" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </MuiButton>
          )}
          <MuiButton
            size="small"
            variant="contained"
            onClick={handleSubmit}
            disabled={!body.trim() || isOverLimit || isSubmitting}
          >
            {submitLabel}
          </MuiButton>
        </Box>
      </Box>
    </Box>
  );
}

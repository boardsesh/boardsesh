'use client';

import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import MuiButton from '@mui/material/Button';
import MuiTypography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';

const MAX_BODY_LENGTH = 2000;
const COUNTER_THRESHOLD = 1800;

type CommentFormProps = {
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  initialBody?: string;
  placeholder?: string;
  autoFocus?: boolean;
  submitLabel?: string;
};

export default function CommentForm({
  onSubmit,
  onCancel,
  initialBody = '',
  placeholder,
  autoFocus = false,
  submitLabel,
}: CommentFormProps) {
  const { t } = useTranslation('common');
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
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  const isOverLimit = body.length > MAX_BODY_LENGTH;
  const showCounter = body.length > COUNTER_THRESHOLD;
  const resolvedPlaceholder = placeholder ?? t('comment.placeholder');
  const resolvedSubmitLabel = submitLabel ?? t('comment.submit');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <TextField
        multiline
        minRows={2}
        maxRows={6}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={resolvedPlaceholder}
        autoFocus={autoFocus}
        disabled={isSubmitting}
        size="small"
        fullWidth
      />
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          {showCounter && (
            <MuiTypography variant="caption" sx={{ color: isOverLimit ? 'var(--color-error)' : 'var(--neutral-400)' }}>
              {body.length}/{MAX_BODY_LENGTH}
            </MuiTypography>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          {onCancel && (
            <MuiButton size="small" onClick={onCancel} disabled={isSubmitting}>
              {t('comment.cancel')}
            </MuiButton>
          )}
          <MuiButton
            size="small"
            variant="contained"
            onClick={handleSubmit}
            disabled={!body.trim() || isOverLimit || isSubmitting}
          >
            {resolvedSubmitLabel}
          </MuiButton>
        </Box>
      </Box>
    </Box>
  );
}

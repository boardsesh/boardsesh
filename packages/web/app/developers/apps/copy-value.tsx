'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';

const COPIED_RESET_MS = 2_000;

export const MONOSPACE_SX = {
  fontFamily: "Monaco, Menlo, 'Ubuntu Mono', monospace",
  fontSize: themeTokens.typography.fontSize.sm,
  overflowWrap: 'anywhere',
} as const;

type CopyValueProps = {
  value: string;
  /** Accessible name of the value's box, such as "Client secret". */
  label: string;
  /** The copy button's text. Defaults to "Copy". */
  copyLabel?: string;
  onCopyFailed: () => void;
};

/**
 * A value to copy, shown as plain selectable text rather than in an input, so
 * no browser offers to save it and no form ever submits it. One click selects
 * the whole value for a manual copy when the clipboard is refused.
 */
export default function CopyValue({ value, label, copyLabel, onCopyFailed }: CopyValueProps) {
  const { t } = useTranslation('developers');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      onCopyFailed();
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
      <Box
        role="textbox"
        aria-readonly="true"
        aria-label={label}
        tabIndex={0}
        sx={{
          ...MONOSPACE_SX,
          flex: '1 1 16rem',
          minWidth: 0,
          px: 1.5,
          py: 1.25,
          borderRadius: `${themeTokens.borderRadius.md}px`,
          backgroundColor: themeTokens.semantic.inputSurface,
          border: `1px solid ${themeTokens.semantic.controlBorder}`,
          color: themeTokens.neutral[900],
          userSelect: 'all',
        }}
      >
        {value}
      </Box>
      <Button
        variant="outlined"
        onClick={copy}
        startIcon={copied ? <CheckOutlined /> : <ContentCopyOutlined />}
        aria-live="polite"
        sx={{ flex: { xs: '1 1 100%', sm: '0 0 auto' }, minHeight: 44 }}
      >
        {copied ? t('secret.copied') : (copyLabel ?? t('secret.copy'))}
      </Button>
    </Box>
  );
}

'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import LockOutlined from '@mui/icons-material/LockOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';

type SetPasswordSectionProps = {
  hasPassword: boolean;
  userEmail: string;
  linkedProviders: string[];
  onPasswordSet: () => void;
};

function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    google: 'Google',
    apple: 'Apple',
    facebook: 'Facebook',
  };
  return names[provider] || provider;
}

export default function SetPasswordSection({
  hasPassword,
  userEmail,
  linkedProviders,
  onPasswordSet,
}: SetPasswordSectionProps) {
  const { t } = useTranslation('settings');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [saving, setSaving] = useState(false);
  const { showMessage } = useSnackbar();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Client-side validation
    let hasError = false;

    if (!password) {
      setPasswordError(t('password.validation.enterPassword'));
      hasError = true;
    } else if (password.length < 8) {
      setPasswordError(t('password.validation.tooShort'));
      hasError = true;
    } else if (password.length > 128) {
      setPasswordError(t('password.validation.tooLong'));
      hasError = true;
    } else {
      setPasswordError('');
    }

    if (!confirmPassword) {
      setConfirmError(t('password.validation.confirmRequired'));
      hasError = true;
    } else if (confirmPassword !== password) {
      setConfirmError(t('password.validation.mismatch'));
      hasError = true;
    } else {
      setConfirmError('');
    }

    if (hasError) return;

    try {
      setSaving(true);
      const response = await fetch('/api/internal/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, confirmPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        showMessage(data.error || t('password.validation.saveError'), 'error');
        return;
      }

      showMessage(t('password.success'), 'success');
      setPassword('');
      setConfirmPassword('');
      onPasswordSet();
    } catch (error) {
      console.error('Set password error:', error);
      showMessage(t('password.validation.retryError'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (hasPassword) {
    return (
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CheckCircleOutlined color="success" />
            <Typography variant="h5">{t('password.enabledTitle')}</Typography>
          </Box>
          <Typography variant="body2" component="span" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {t('password.enabledDescription', { email: userEmail })}
          </Typography>
        </CardContent>
      </Card>
    );
  }

  const providerNames = linkedProviders.map(formatProviderName);
  const providersJoined = providerNames.join(', ');

  return (
    <Card>
      <CardContent>
        <Typography variant="h5">{t('password.title')}</Typography>
        <Typography variant="body2" component="span" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {t('password.description')}
        </Typography>

        {providerNames.length > 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t('password.linkedProviderInfo', {
              count: providerNames.length,
              providers: providersJoined,
            })}
          </Alert>
        )}

        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label={t('password.passwordLabel')}
            type="password"
            autoComplete="new-password"
            placeholder={t('password.passwordPlaceholder')}
            variant="outlined"
            size="small"
            fullWidth
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (passwordError) setPasswordError('');
            }}
            error={!!passwordError}
            helperText={passwordError}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <LockOutlined />
                  </InputAdornment>
                ),
              },
            }}
          />

          <TextField
            label={t('password.confirmLabel')}
            type="password"
            autoComplete="new-password"
            placeholder={t('password.confirmPlaceholder')}
            variant="outlined"
            size="small"
            fullWidth
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              if (confirmError) setConfirmError('');
            }}
            error={!!confirmError}
            helperText={confirmError}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <LockOutlined />
                  </InputAdornment>
                ),
              },
            }}
          />

          <Button
            variant="contained"
            type="submit"
            disabled={saving}
            startIcon={saving ? <CircularProgress size={16} /> : <LockOutlined />}
            fullWidth
          >
            {t('password.submit')}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}

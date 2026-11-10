'use client';

import React from 'react';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import MuiLink from '@mui/material/Link';
import LockOutlined from '@mui/icons-material/LockOutlined';
import MailOutlined from '@mui/icons-material/MailOutlined';
import { useTranslation } from 'react-i18next';
import { FormSection, FormField } from '@/app/components/form';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { LoginErrors, LoginValues } from './validate-fields';

type PasswordSignInFieldsProps = {
  values: LoginValues;
  errors: LoginErrors;
  /** Called on every edit; the form clears that field's error and any server error. */
  onFieldChange: (field: keyof LoginValues, value: string) => void;
};

/**
 * The email and password fields of the password sign-in, with the
 * forgot-password link. Shared by `/auth/login` and the partner app sign-in at
 * `/oauth/sign-in`; each owns its form, validation and submit.
 */
export function PasswordSignInFields({ values, errors, onFieldChange }: PasswordSignInFieldsProps) {
  const { t } = useTranslation('auth');
  return (
    <FormSection>
      <FormField label={t('login.fields.email')} error={errors.email}>
        {(field) => (
          <TextField
            id={field.id}
            type="email"
            autoComplete="username"
            placeholder={t('login.placeholders.email')}
            fullWidth
            value={values.email}
            onChange={(event) => onFieldChange('email', event.target.value)}
            error={Boolean(field.error)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <MailOutlined />
                  </InputAdornment>
                ),
              },
              htmlInput: { autoCapitalize: 'none', 'aria-describedby': field.describedBy },
            }}
          />
        )}
      </FormField>

      <FormField
        label={t('login.fields.password')}
        error={errors.password}
        labelAccessory={
          <MuiLink component={LocaleLink} href="/auth/forgot-password" variant="body2">
            {t('login.links.forgotPassword')}
          </MuiLink>
        }
      >
        {(field) => (
          <TextField
            id={field.id}
            type="password"
            autoComplete="current-password"
            placeholder={t('login.placeholders.password')}
            fullWidth
            value={values.password}
            onChange={(event) => onFieldChange('password', event.target.value)}
            error={Boolean(field.error)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <LockOutlined />
                  </InputAdornment>
                ),
              },
              htmlInput: { 'aria-describedby': field.describedBy },
            }}
          />
        )}
      </FormField>
    </FormSection>
  );
}

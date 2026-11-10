'use client';

import React, { useId, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import MuiLink from '@mui/material/Link';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import type { OAuthClient } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import {
  EMPTY_APP_FORM,
  formFromApp,
  MAX_REDIRECT_URIS,
  missingAppFormFields,
  type AppClientType,
  type AppFormField,
  type AppFormState,
  type AppSecretMethod,
} from '@/app/lib/developer-apps/app-form';
import { MONOSPACE_SX } from './copy-value';

/** Full screen on a phone, a centred dialog from `sm` up. CSS breakpoints, no JS. */
export const RESPONSIVE_DIALOG_SX = {
  '& .MuiDialog-paper': {
    m: { xs: 0, sm: 4 },
    width: { xs: '100%', sm: 'calc(100% - 64px)' },
    maxHeight: { xs: '100%', sm: 'calc(100% - 64px)' },
    height: { xs: '100%', sm: 'auto' },
    borderRadius: { xs: 0, sm: undefined },
  },
} as const;

type RadioChoice<Value extends string> = { value: Value; label: string; help?: string };

function ChoiceGroup<Value extends string>({
  label,
  value,
  choices,
  disabled,
  onChange,
}: {
  label: string;
  value: Value;
  choices: RadioChoice<Value>[];
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  const labelId = useId();
  return (
    <FormControl disabled={disabled}>
      <FormLabel id={labelId} sx={{ mb: 0.5 }}>
        {label}
      </FormLabel>
      <RadioGroup
        aria-labelledby={labelId}
        value={value}
        onChange={(event) => {
          const next = choices.find((choice) => choice.value === event.target.value);
          if (next) onChange(next.value);
        }}
      >
        {choices.map((choice) => (
          <FormControlLabel
            key={choice.value}
            value={choice.value}
            control={<Radio />}
            sx={{ alignItems: 'flex-start', mb: 1, '& .MuiRadio-root': { mt: -1 } }}
            label={
              <>
                <Typography variant="body2">{choice.label}</Typography>
                {choice.help ? (
                  <Typography variant="caption" color="text.secondary" component="p">
                    {choice.help}
                  </Typography>
                ) : null}
              </>
            }
          />
        ))}
      </RadioGroup>
    </FormControl>
  );
}

type AppFormDialogProps = {
  /** Null registers a new app; an app edits it. */
  app: OAuthClient | null;
  onClose: () => void;
  /** Resolves with the server's own refusal text, or null once the app is saved. */
  onSubmit: (state: AppFormState) => Promise<string | null>;
};

/** Mounted once per opening, so a fresh state is taken from the app every time. */
export default function AppFormDialog({ app, onClose, onSubmit }: AppFormDialogProps) {
  const { t } = useTranslation('developers');
  const [state, setState] = useState<AppFormState>(() => (app ? formFromApp(app) : EMPTY_APP_FORM));
  const [missing, setMissing] = useState<ReadonlySet<AppFormField>>(new Set());
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const editing = app !== null;

  const update = <Key extends keyof AppFormState>(key: Key, value: AppFormState[Key]) => {
    setState((current) => ({ ...current, [key]: value }));
    if (missing.size > 0) setMissing(new Set());
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const missingFields = missingAppFormFields(state, { registering: !editing });
    if (missingFields.length > 0) {
      setMissing(new Set(missingFields));
      return;
    }
    setSaving(true);
    setRefusal(null);
    const refused = await onSubmit(state);
    setSaving(false);
    if (refused) setRefusal(refused);
  };

  const fieldProps = (field: AppFormField, help: string) => ({
    required: true,
    error: missing.has(field),
    helperText: missing.has(field) ? t('form.required') : help,
  });

  return (
    <Dialog
      open
      onClose={saving ? undefined : onClose}
      aria-labelledby={titleId}
      maxWidth="sm"
      fullWidth
      sx={RESPONSIVE_DIALOG_SX}
    >
      <Box component="form" onSubmit={submit} noValidate sx={{ display: 'contents' }}>
        <DialogTitle id={titleId}>
          {editing ? t('form.editTitle', { app: app.name }) : t('form.createTitle')}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5}>
            {refusal ? (
              <Alert severity="error" role="alert">
                <AlertTitle>{t('form.refused')}</AlertTitle>
                {refusal}
              </Alert>
            ) : null}
            <TextField
              label={t('form.name')}
              value={state.name}
              onChange={(event) => update('name', event.target.value)}
              autoComplete="off"
              autoFocus
              slotProps={{ htmlInput: { maxLength: 100 } }}
              {...fieldProps('name', t('form.nameHelp'))}
            />
            <TextField
              label={t('form.publisher')}
              value={state.publisherName}
              onChange={(event) => update('publisherName', event.target.value)}
              autoComplete="organization"
              slotProps={{ htmlInput: { maxLength: 100 } }}
              {...fieldProps('publisherName', t('form.publisherHelp'))}
            />
            <TextField
              label={t('form.homepage')}
              value={state.homepageUrl}
              onChange={(event) => update('homepageUrl', event.target.value)}
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://"
              helperText={t('form.urlHelp')}
            />
            <TextField
              label={t('form.privacyPolicy')}
              value={state.privacyPolicyUrl}
              onChange={(event) => update('privacyPolicyUrl', event.target.value)}
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://"
              {...fieldProps('privacyPolicyUrl', t('form.urlHelp'))}
            />

            {editing ? (
              <Typography variant="body2" color="text.secondary">
                {t('form.fixed', {
                  kind: t(`app.kind.${app.applicationType}`),
                  auth: t(`app.auth.${app.tokenEndpointAuthMethod}`),
                })}
              </Typography>
            ) : (
              <>
                <ChoiceGroup
                  label={t('form.applicationType')}
                  value={state.applicationType}
                  disabled={saving}
                  onChange={(value) => update('applicationType', value)}
                  choices={[
                    { value: 'WEB', label: t('form.applicationTypeWeb'), help: t('form.applicationTypeWebHelp') },
                    {
                      value: 'NATIVE',
                      label: t('form.applicationTypeNative'),
                      help: t('form.applicationTypeNativeHelp'),
                    },
                  ]}
                />
                <ChoiceGroup<AppClientType>
                  label={t('form.clientType')}
                  value={state.clientType}
                  disabled={saving}
                  onChange={(value) => update('clientType', value)}
                  choices={[
                    {
                      value: 'confidential',
                      label: t('form.clientTypeConfidential'),
                      help: t('form.clientTypeConfidentialHelp'),
                    },
                    { value: 'public', label: t('form.clientTypePublic'), help: t('form.clientTypePublicHelp') },
                  ]}
                />
                {state.clientType === 'confidential' ? (
                  <ChoiceGroup<AppSecretMethod>
                    label={t('form.secretMethod')}
                    value={state.secretMethod}
                    disabled={saving}
                    onChange={(value) => update('secretMethod', value)}
                    choices={[
                      { value: 'CLIENT_SECRET_BASIC', label: t('form.secretMethodBasic') },
                      { value: 'CLIENT_SECRET_POST', label: t('form.secretMethodPost') },
                    ]}
                  />
                ) : null}
              </>
            )}

            <TextField
              label={t('form.redirectUris')}
              value={state.redirectUris}
              onChange={(event) => update('redirectUris', event.target.value)}
              multiline
              minRows={3}
              maxRows={MAX_REDIRECT_URIS}
              autoComplete="off"
              placeholder={
                state.applicationType === 'NATIVE'
                  ? 'com.example.app:/oauth/boardsesh\nhttp://127.0.0.1/callback'
                  : 'https://app.example.com/oauth/boardsesh'
              }
              slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'none' }, input: { sx: MONOSPACE_SX } }}
              {...fieldProps('redirectUris', t('form.redirectUrisHelp'))}
            />

            {editing ? null : (
              <Stack spacing={0.5}>
                <MuiLink component={LocaleLink} href="/developers/terms" target="_blank" rel="noopener" variant="body2">
                  {t('form.readTerms')}
                </MuiLink>
                <FormControl required error={missing.has('acceptedTerms')} disabled={saving}>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={state.acceptedTerms}
                        onChange={(event) => update('acceptedTerms', event.target.checked)}
                      />
                    }
                    label={<Typography variant="body2">{t('form.acceptTerms')}</Typography>}
                  />
                  {missing.has('acceptedTerms') ? (
                    <FormHelperText>{t('form.acceptTermsRequired')}</FormHelperText>
                  ) : null}
                </FormControl>
              </Stack>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2, gap: 1, '& .MuiButton-root': { minHeight: 44 } }}>
          <Button onClick={onClose} disabled={saving}>
            {t('form.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={saving}
            startIcon={saving ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
          >
            {saving ? (editing ? t('form.saving') : t('form.creating')) : editing ? t('form.save') : t('form.create')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

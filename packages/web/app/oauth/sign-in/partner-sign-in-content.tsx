'use client';

import React, { useId, useState } from 'react';
import MuiDivider from '@mui/material/Divider';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { AUTH_BACKEND_UNAVAILABLE, isAuthBackendUnavailable } from '@boardsesh/auth-protocol/client-errors';
import SocialLoginButtons from '@/app/components/auth/social-login-buttons';
import { PasswordSignInFields } from '@/app/components/auth/password-sign-in-fields';
import {
  EMAIL_REGEX,
  initialLoginValues,
  validateLoginFields,
  type LoginErrors,
  type LoginValues,
} from '@/app/components/auth/validate-fields';
import { FormActions, FormShell, focusFirstInvalidAfterRender } from '@/app/components/form';
import LocaleLink from '@/app/components/i18n/locale-link';
import { signInWithSessionIntent as signIn } from '@/app/lib/auth/web-session-events';
import type { PartnerSignInReason, PartnerSignInView } from '@/app/lib/partner-oauth/page-views';
import { PartnerOAuthMessage, PartnerOAuthTitle } from '../partner-oauth-layout';

type SignInFormView = Extract<PartnerSignInView, { kind: 'sign-in' }>;

/** A NextAuth code on the page's URL, from a failed social sign-in, as the alert's text. */
function useSignInErrorMessage(errorCode: string | null): string | null {
  const { t } = useTranslation('oauth');
  switch (errorCode) {
    case null:
      return null;
    case 'CredentialsSignin':
      return t('signIn.errors.invalidCredentials');
    case 'OAuthAccountNotLinked':
      return t('signIn.errors.accountNotLinked');
    // The link guard: a provider account that is not linked yet cannot be
    // added to a session too old to approve an app (oauth-link-guard.server.ts).
    case 'Callback':
      return t('signIn.errors.linkRefused');
    case 'Configuration':
    case AUTH_BACKEND_UNAVAILABLE:
      return t('signIn.errors.unavailable');
    default:
      return t('signIn.errors.generic');
  }
}

function SignInIntro({ reason, account, signOutPath }: Pick<SignInFormView, 'reason' | 'account' | 'signOutPath'>) {
  const { t } = useTranslation('oauth');
  const copy: Record<PartnerSignInReason, { title: string; body: string }> = {
    'signed-out': { title: t('signIn.signedOut.title'), body: t('signIn.signedOut.body') },
    stale: { title: t('signIn.stale.title'), body: t('signIn.stale.body') },
    'just-signed-in': { title: t('signIn.justSignedIn.title'), body: t('signIn.justSignedIn.body') },
  };
  return (
    <Stack spacing={1.5}>
      <PartnerOAuthTitle>{copy[reason].title}</PartnerOAuthTitle>
      <Typography variant="body1" color="text.secondary">
        {copy[reason].body}
      </Typography>
      {reason === 'stale' ? (
        <Typography variant="body2" color="text.secondary">
          {t('signIn.stale.detail')}
        </Typography>
      ) : null}
      {account ? (
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {t('signIn.signedInAs', { account })}{' '}
          <MuiLink component={LocaleLink} href={signOutPath}>
            {t('signIn.signOut')}
          </MuiLink>
        </Typography>
      ) : null}
    </Stack>
  );
}

function PartnerSignInForm({ view }: { view: SignInFormView }) {
  const { t } = useTranslation('oauth');
  const { t: tAuth } = useTranslation('auth');
  const formId = useId();
  // Signing in again is usually as the same climber, so start from their email.
  const [values, setValues] = useState<LoginValues>(() => ({
    ...initialLoginValues,
    email: view.account && EMAIL_REGEX.test(view.account) ? view.account : '',
  }));
  const [errors, setErrors] = useState<LoginErrors>({});
  const urlError = useSignInErrorMessage(view.errorCode);
  const [serverError, setServerError] = useState<string | null>(urlError);
  const [submitting, setSubmitting] = useState(false);

  const updateField = (field: keyof LoginValues, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    if (errors[field]) setErrors((previous) => ({ ...previous, [field]: undefined }));
    if (serverError) setServerError(null);
  };

  const handleSubmit = async () => {
    setServerError(null);
    const fieldErrors = validateLoginFields(values, tAuth);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      focusFirstInvalidAfterRender(formId);
      return;
    }
    setSubmitting(true);
    try {
      const result = await signIn('credentials', { email: values.email, password: values.password, redirect: false });
      if (result?.ok && !result.error) {
        // A full load, so the page's server half sees the new cookie and sends
        // the browser back to authorize. Keep the button busy until it leaves.
        window.location.assign(view.returnPath);
        return;
      }
      setServerError(
        isAuthBackendUnavailable(result?.error)
          ? t('signIn.errors.unavailable')
          : t('signIn.errors.invalidCredentials'),
      );
    } catch {
      setServerError(t('signIn.errors.unavailable'));
    }
    setSubmitting(false);
  };

  return (
    <Stack spacing={3}>
      <SignInIntro reason={view.reason} account={view.account} signOutPath={view.signOutPath} />
      <FormShell
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
        error={serverError}
        maxWidth={false}
      >
        <PasswordSignInFields values={values} errors={errors} onFieldChange={updateField} />
        <FormActions submitLabel={t('signIn.submit')} submitting={submitting} layout="stacked" />
      </FormShell>
      <MuiDivider>
        <Typography variant="body2" component="span" color="text.secondary">
          {tAuth('login.divider')}
        </Typography>
      </MuiDivider>
      {/* NextAuth returns here after the provider, or, on a failure, to this page with ?error= (sign-in-failure-return.ts). */}
      <SocialLoginButtons callbackUrl={view.returnPath} disabled={submitting} />
    </Stack>
  );
}

/** `/oauth/sign-in`: the sign-in a partner app's request waits on. */
export default function PartnerSignInContent({ view }: { view: PartnerSignInView }) {
  const { t } = useTranslation('oauth');
  if (view.kind === 'unavailable') {
    return (
      <PartnerOAuthMessage tone="info" title={t('states.unavailable.title')} body={t('states.unavailable.body')} />
    );
  }
  if (view.kind === 'invalid') {
    return (
      <PartnerOAuthMessage tone="problem" title={t('states.invalidLink.title')} body={t('states.invalidLink.body')} />
    );
  }
  return <PartnerSignInForm view={view} />;
}

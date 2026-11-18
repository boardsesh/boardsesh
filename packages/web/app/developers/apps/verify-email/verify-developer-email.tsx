'use client';

import React, { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import { CONFIRM_PARTNER_DEVELOPER_EMAIL } from '@boardsesh/graphql/operations';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

export default function VerifyDeveloperEmail() {
  const { t } = useTranslation('developers');
  const { data: session, status } = useSession();
  const { token: authToken } = useWsAuthToken();
  const captured = useRef(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [result, setResult] = useState<'idle' | 'working' | 'verified' | 'failed'>('idle');
  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    const emailToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
    setChallenge(emailToken);
    // Remove the secret before any further navigation; it never enters a request URL or persistent storage.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);
  const confirm = async () => {
    if (!challenge || !authToken) return;
    setResult('working');
    try {
      const response = await createGraphQLHttpClient(authToken).request<{ confirmPartnerDeveloperEmail: boolean }>(
        CONFIRM_PARTNER_DEVELOPER_EMAIL,
        { token: challenge },
      );
      setResult(response.confirmPartnerDeveloperEmail ? 'verified' : 'failed');
      if (response.confirmPartnerDeveloperEmail) setChallenge(null);
    } catch {
      setResult('failed');
    }
  };
  return (
    <Stack spacing={2}>
      {result === 'verified' ? (
        <Alert severity="success">{t('emailVerification.verified')}</Alert>
      ) : (
        <>
          <Typography>{t('emailVerification.confirmDescription')}</Typography>
          {status === 'unauthenticated' ? (
            <>
              <Alert severity="info">{t('emailVerification.signInHelp')}</Alert>
              <MuiLink component={LocaleLink} href="/auth/login" target="_blank" rel="noopener noreferrer">
                {t('emailVerification.signIn')}
              </MuiLink>
            </>
          ) : null}
          <Button
            variant="contained"
            disabled={!challenge || !authToken || !session || result === 'working'}
            onClick={() => void confirm()}
          >
            {result === 'working' ? t('emailVerification.confirming') : t('emailVerification.confirm')}
          </Button>
          {result === 'failed' ? <Alert severity="error">{t('emailVerification.invalid')}</Alert> : null}
        </>
      )}
      <MuiLink component={LocaleLink} href="/developers/apps">
        {t('emailVerification.back')}
      </MuiLink>
    </Stack>
  );
}

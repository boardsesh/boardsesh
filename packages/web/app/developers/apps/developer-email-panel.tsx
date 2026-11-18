'use client';

import React, { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useSession } from 'next-auth/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  GET_PARTNER_DEVELOPER_EMAIL_STATUS,
  REQUEST_PARTNER_DEVELOPER_EMAIL,
  type PartnerDeveloperEmailStatusResponse,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

/** Kept visible when open registration asks for independent email proof. */
export default function DeveloperEmailPanel() {
  const { t } = useTranslation('developers');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const status = useQuery({
    queryKey: ['partnerDeveloperEmailStatus', session?.user?.id],
    queryFn: () =>
      createGraphQLHttpClient(token).request<PartnerDeveloperEmailStatusResponse>(GET_PARTNER_DEVELOPER_EMAIL_STATUS),
    enabled: Boolean(token),
    retry: false,
  });
  const request = async () => {
    setSending(true);
    setFailed(false);
    try {
      await createGraphQLHttpClient(token).request(REQUEST_PARTNER_DEVELOPER_EMAIL);
      setSent(true);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  return (
    <Stack spacing={2}>
      <Typography variant="h2">{t('emailVerification.title')}</Typography>
      <Typography>
        {t('emailVerification.description', { email: status.data?.partnerDeveloperEmailStatus.email ?? '' })}
      </Typography>
      {sent ? <Alert severity="success">{t('emailVerification.sent')}</Alert> : null}
      {failed ? <Alert severity="error">{t('emailVerification.failed')}</Alert> : null}
      <Button variant="contained" onClick={() => void request()} disabled={sending || !token}>
        {sending ? t('emailVerification.sending') : t('emailVerification.send')}
      </Button>
    </Stack>
  );
}

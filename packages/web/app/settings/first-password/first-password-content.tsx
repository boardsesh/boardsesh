'use client';

import React, { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import {
  FIRST_PASSWORD_PATH,
  answerStatus,
  postAccountSecurity,
  refusalOf,
} from '@/app/lib/auth/account-security-client';

type Phase = 'idle' | 'sent' | 'notEligible' | 'tryAgainSoon';

/** Asks for the email that lets this browser choose a first password (#7596 B5e2). */
export default function FirstPasswordContent({ email }: { email: string }) {
  const { t } = useTranslation('settings');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, setPending] = useState(false);

  async function requestLink() {
    setPending(true);
    try {
      const answer = await postAccountSecurity(`${FIRST_PASSWORD_PATH}/request`);
      const refusal = refusalOf(answer);
      if (answerStatus(answer) === 'sent') setPhase('sent');
      else if (refusal?.code === 'not_eligible' || refusal?.code === 'already_set') setPhase('notEligible');
      else setPhase('tryAgainSoon');
    } catch {
      setPhase('tryAgainSoon');
    } finally {
      setPending(false);
    }
  }

  return (
    <Box
      component="main"
      sx={{
        padding: '24px',
        maxWidth: 600,
        margin: '0 auto',
        width: '100%',
        paddingTop: 'var(--global-header-height)',
      }}
    >
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h3" component="h1">
              {t('firstPassword.title')}
            </Typography>
            <Typography>{t('firstPassword.description', { email })}</Typography>
            {phase === 'sent' && <Alert severity="success">{t('firstPassword.sent', { email })}</Alert>}
            {phase === 'notEligible' && <Alert severity="info">{t('firstPassword.notEligible')}</Alert>}
            {phase === 'tryAgainSoon' && <Alert severity="error">{t('firstPassword.tryAgainSoon')}</Alert>}
            {phase !== 'notEligible' && (
              <Button variant="contained" disabled={pending} onClick={() => void requestLink()}>
                {phase === 'sent' ? t('firstPassword.sendAgain') : t('firstPassword.send')}
              </Button>
            )}
            <Button variant="text" component={LocaleLink} href="/settings">
              {t('firstPassword.back')}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

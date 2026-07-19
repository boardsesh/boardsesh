'use client';

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import MuiAlert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import Logo from '@/app/components/brand/logo';
import { guardedNextAuthSignOut } from '@/app/lib/auth/nextauth-cookie-fetch-lock';
import { safeCallbackUrl } from './safe-callback-url';

export default function SignOutContent() {
  const { t } = useTranslation('auth');
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const [failed, setFailed] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (status === 'loading' || startedRef.current) return;
    const callbackUrl = safeCallbackUrl(searchParams.get('callbackUrl'));

    // Never render NextAuth's built-in confirmation form (its POST omits the
    // identity fields the guarded route now requires). Drive the same guarded
    // sign-out the account menu uses; it redirects on success.
    const userId = session?.user?.id;
    const authSessionId = session?.authSessionId;
    if (status !== 'authenticated' || !userId || !authSessionId) {
      window.location.href = callbackUrl;
      return;
    }

    startedRef.current = true;
    void guardedNextAuthSignOut({ userId, authSessionId }, { callbackUrl }).catch(() => {
      startedRef.current = false;
      setFailed(true);
    });
  }, [searchParams, session, status]);

  return (
    <Box
      sx={{
        minHeight: '100vh',
        background: 'var(--semantic-background)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '24px',
        paddingTop: '48px',
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>
        <CardContent>
          <Stack spacing={3} sx={{ width: '100%', alignItems: 'center' }}>
            <Logo size="sm" showText={false} />
            {failed ? (
              <MuiAlert severity="error">{t('signOut.error')}</MuiAlert>
            ) : (
              <>
                <CircularProgress aria-hidden />
                <Typography variant="h3">{t('signOut.title')}</Typography>
                <Typography variant="body1" component="p" color="text.secondary">
                  {t('signOut.description')}
                </Typography>
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

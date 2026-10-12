import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';

/**
 * What a signed-out visitor sees on a board's share link: the board's name and
 * a sign-in that comes straight back here, where they can explicitly confirm Join.
 *
 * The name and nothing else. The board is Followers or Invite-only, so its
 * location, its climbers and everything else stay behind the sign-in.
 *
 * `prefetch={false}`: the sign-in URL carries this page's own URL, token
 * included, and a prefetch would send it before anyone asked to sign in.
 */
export default async function BoardInviteSignIn({ boardName, returnPath }: { boardName: string; returnPath: string }) {
  const { t } = await getServerTranslation('boards');
  const signInHref = `/auth/login?callbackUrl=${encodeURIComponent(returnPath)}`;

  return (
    <Container maxWidth="sm">
      <Box sx={{ py: 8, display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
        <Typography variant="h4" component="h1">
          {t('boardShareLink.heading', { name: boardName })}
        </Typography>
        <Typography variant="body1" color="text.secondary">
          {t('boardShareLink.body')}
        </Typography>
        <Button variant="contained" size="large" component={LocaleLink} href={signInHref} prefetch={false}>
          {t('boardShareLink.signIn')}
        </Button>
      </Box>
    </Container>
  );
}

'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { joinBoardInvite } from './join-board-invite';

/** Only a deliberate button tap sends the grant mutation. */
export default function BoardInviteJoin({ boardName, inviteToken }: { boardName: string; inviteToken: string }) {
  const { t } = useTranslation('boards');
  const [joining, setJoining] = useState(false);
  const [failed, setFailed] = useState(false);
  const handleJoin = async () => {
    if (joining) return;
    setJoining(true);
    setFailed(false);
    try {
      await joinBoardInvite(inviteToken);
      setFailed(true);
    } catch {
      // Server-action errors must not report the token argument.
      setFailed(true);
    } finally {
      setJoining(false);
    }
  };
  return (
    <Container maxWidth="sm">
      <Box sx={{ py: 8, display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
        <Typography variant="h4" component="h1">
          {t('boardShareLink.joinHeading', { name: boardName })}
        </Typography>
        <Typography variant="body1" color="text.secondary">
          {t('boardShareLink.joinBody')}
        </Typography>
        {failed && (
          <Typography role="alert" color="error">
            {t('boardShareLink.joinFailed')}
          </Typography>
        )}
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant="contained" size="large" disabled={joining} onClick={handleJoin}>
            {t('boardShareLink.join')}
          </Button>
          <Button component={LocaleLink} href="/" disabled={joining} prefetch={false}>
            {t('boardShareLink.cancel')}
          </Button>
        </Box>
      </Box>
    </Container>
  );
}

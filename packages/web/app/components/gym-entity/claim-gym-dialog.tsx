'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MuiButton from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutline';
import {
  extractDomain,
  isClaimableDomain,
  emailDomainMatchesWebsite,
  GYM_CLAIM_MESSAGE_MAX_LENGTH,
} from '@boardsesh/gym-claim';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  REQUEST_GYM_CLAIM,
  type RequestGymClaimMutationResponse,
  type RequestGymClaimMutationVariables,
} from '@boardsesh/graphql/operations';

type ClaimGymDialogProps = {
  gymUuid: string;
  gymName: string;
  website?: string | null;
  open: boolean;
  onClose: () => void;
};

type Mode = 'domain' | 'admin';

function graphqlErrorMessage(error: unknown): string | null {
  const response = (error as { response?: { errors?: Array<{ message?: string }> } })?.response;
  return response?.errors?.[0]?.message ?? null;
}

export default function ClaimGymDialog({ gymUuid, gymName, website, open, onClose }: ClaimGymDialogProps) {
  const { t } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const domain = extractDomain(website);
  const canUseDomain = isClaimableDomain(website);

  const [mode, setMode] = useState<Mode>(canUseDomain ? 'domain' : 'admin');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [adminSent, setAdminSent] = useState(false);

  const reset = useCallback(() => {
    setMode(canUseDomain ? 'domain' : 'admin');
    setEmail('');
    setMessage('');
    setSubmitting(false);
    setError(null);
    setSentTo(null);
    setAdminSent(false);
  }, [canUseDomain]);

  // A single GymDetail/ClaimGymDialog instance is reused across gyms, so re-init
  // every time it opens — otherwise mode/inputs leak from the previously shown gym.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const handleClose = () => {
    reset();
    onClose();
  };

  const submit = async (variables: RequestGymClaimMutationVariables) => {
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<RequestGymClaimMutationResponse, RequestGymClaimMutationVariables>(
        REQUEST_GYM_CLAIM,
        variables,
      );
      if (data.requestGymClaim.status === 'email_sent') {
        setSentTo(data.requestGymClaim.email ?? email);
      } else {
        setAdminSent(true);
      }
    } catch (err) {
      setError(graphqlErrorMessage(err) ?? t('claimGym.errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  // Check the domain match client-side so es/fr users get a localized error
  // instead of the backend's English message for the common mismatch case.
  const submitDomainClaim = () => {
    const trimmed = email.trim();
    if (!emailDomainMatchesWebsite(trimmed, website)) {
      setError(t('claimGym.domain.mismatch', { domain: domain ?? '' }));
      return;
    }
    void submit({ input: { gymUuid, claimEmail: trimmed } });
  };

  const succeeded = sentTo !== null || adminSent;

  let body: React.ReactNode;
  if (sentTo) {
    body = (
      <Box
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 2, textAlign: 'center' }}
      >
        <CheckCircleOutlined color="success" sx={{ fontSize: 40 }} />
        <DialogContentText>{t('claimGym.domain.sent', { email: sentTo })}</DialogContentText>
      </Box>
    );
  } else if (adminSent) {
    body = (
      <Box
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 2, textAlign: 'center' }}
      >
        <CheckCircleOutlined color="success" sx={{ fontSize: 40 }} />
        <DialogContentText>{t('claimGym.admin.sent')}</DialogContentText>
      </Box>
    );
  } else if (mode === 'domain' && canUseDomain && domain) {
    body = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <DialogContentText>{t('claimGym.domain.description', { gym: gymName, domain })}</DialogContentText>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label={t('claimGym.domain.emailLabel')}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          fullWidth
          size="small"
          placeholder={t('claimGym.domain.emailPlaceholder', { domain })}
          autoFocus
        />
        <MuiLink
          component="button"
          type="button"
          variant="body2"
          onClick={() => setMode('admin')}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('claimGym.switchToAdmin')}
        </MuiLink>
      </Box>
    );
  } else {
    body = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <DialogContentText>{t('claimGym.admin.description', { gym: gymName })}</DialogContentText>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label={t('claimGym.admin.messageLabel')}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          fullWidth
          size="small"
          multiline
          minRows={2}
          maxRows={5}
          placeholder={t('claimGym.admin.messagePlaceholder')}
          slotProps={{ htmlInput: { maxLength: GYM_CLAIM_MESSAGE_MAX_LENGTH } }}
        />
        {canUseDomain && (
          <MuiLink
            component="button"
            type="button"
            variant="body2"
            onClick={() => setMode('domain')}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t('claimGym.switchToDomain')}
          </MuiLink>
        )}
      </Box>
    );
  }

  let primaryAction: React.ReactNode = null;
  if (!succeeded) {
    if (mode === 'domain' && canUseDomain && domain) {
      primaryAction = (
        <MuiButton
          variant="contained"
          onClick={submitDomainClaim}
          disabled={submitting || !email.trim()}
          sx={{ textTransform: 'none' }}
        >
          {submitting ? <CircularProgress size={18} color="inherit" /> : t('claimGym.domain.submit')}
        </MuiButton>
      );
    } else {
      primaryAction = (
        <MuiButton
          variant="contained"
          onClick={() => submit({ input: { gymUuid, message: message.trim() || undefined } })}
          disabled={submitting}
          sx={{ textTransform: 'none' }}
        >
          {submitting ? <CircularProgress size={18} color="inherit" /> : t('claimGym.admin.submit')}
        </MuiButton>
      );
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('claimGym.title', { gym: gymName })}</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>
        <MuiButton onClick={handleClose} sx={{ textTransform: 'none' }}>
          {succeeded ? t('claimGym.done') : t('claimGym.cancel')}
        </MuiButton>
        {primaryAction}
      </DialogActions>
    </Dialog>
  );
}

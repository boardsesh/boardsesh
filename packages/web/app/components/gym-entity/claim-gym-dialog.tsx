'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
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
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutline';
import {
  extractDomain,
  emailDomainMatchesWebsite,
  GYM_CLAIM_MESSAGE_MAX_LENGTH,
  GYM_CLAIM_SUPPORT_EMAIL,
} from '@boardsesh/gym-claim';
import { gymClaimResult, gymClaimSubmitted } from '@boardsesh/analytics';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import LocaleLink from '@/app/components/i18n/locale-link';
import {
  REQUEST_GYM_CLAIM,
  type RequestGymClaimMutationResponse,
  type RequestGymClaimMutationVariables,
} from '@boardsesh/graphql/operations';

type ClaimGymDialogProps = {
  gymUuid: string;
  gymName: string;
  website?: string | null;
  /**
   * `Gym.canClaimByDomain`, straight off the server. BOTH halves of the rule
   * requestGymClaim enforces: the website is a real (non-free-provider) domain
   * AND the gym's own owner put it there. Deriving it here from `website` alone
   * — as this dialog used to — opens the email form on a gym whose website
   * nobody with ownership vouched for, so the climber fills in a work address
   * and only the mutation says no (#4018). Required, not defaulted: a missing
   * value must be a compile error, never a silent `false` that hides the email
   * path from a gym that can use it.
   */
  canClaimByDomain: boolean;
  open: boolean;
  onClose: () => void;
};

type Mode = 'domain' | 'admin';

function graphqlErrorMessage(error: unknown): string | null {
  const response = (error as { response?: { errors?: Array<{ message?: string }> } })?.response;
  return response?.errors?.[0]?.message ?? null;
}

export default function ClaimGymDialog({
  gymUuid,
  gymName,
  website,
  canClaimByDomain,
  open,
  onClose,
}: ClaimGymDialogProps) {
  const { t } = useTranslation('boards');
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const router = useRouter();
  const queryClient = useQueryClient();
  // Still derived locally, and only for display: the domain we print in the
  // copy and the placeholder. The routing decision is the server's.
  const domain = extractDomain(website);

  const [mode, setMode] = useState<Mode>(canClaimByDomain ? 'domain' : 'admin');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [adminSent, setAdminSent] = useState(false);
  const [approved, setApproved] = useState(false);

  const reset = useCallback(() => {
    setMode(canClaimByDomain ? 'domain' : 'admin');
    setEmail('');
    setMessage('');
    setSubmitting(false);
    setError(null);
    setSentTo(null);
    setAdminSent(false);
    setApproved(false);
  }, [canClaimByDomain]);

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

    // `method` comes from what is actually on the wire, not from `mode` state.
    // The two diverge: the admin branch is also what renders when `mode` is
    // 'domain' but the gym has no claimable domain, and a submit built by an
    // earlier render can outlive a mode switch. `gymUuid` is read from props at
    // fire time for the same reason — one dialog instance is reused across gyms
    // (see the re-init effect above).
    trackGymFunnelEvent(gymClaimSubmitted({ method: variables.input.claimEmail ? 'domain' : 'admin', gymUuid }));

    setSubmitting(true);
    setError(null);
    try {
      const client = createGraphQLHttpClient(token);
      const data = await client.request<RequestGymClaimMutationResponse, RequestGymClaimMutationVariables>(
        REQUEST_GYM_CLAIM,
        variables,
      );
      if (data.requestGymClaim.status === 'email_sent') {
        trackGymFunnelEvent(gymClaimResult({ status: 'email_sent', gymUuid }));
        setSentTo(data.requestGymClaim.email ?? email);
      } else if (data.requestGymClaim.status === 'approved') {
        trackGymFunnelEvent(gymClaimResult({ status: 'approved', gymUuid }));
        setApproved(true);
        // Ownership just moved, so everything the viewer sees about this gym is
        // stale. `canClaim` is computed server-side on the gym page, so a cache
        // invalidation alone wouldn't clear the claim CTA — refresh the server
        // component. `myGyms` is the one React Query key on web that this
        // affects (there is no per-gym key here, unlike mobile).
        router.refresh();
        void queryClient.invalidateQueries({ queryKey: ['myGyms'] });
      } else {
        // The only remaining GymClaimRequestStatus the backend returns.
        trackGymFunnelEvent(gymClaimResult({ status: 'admin_review', gymUuid }));
        setAdminSent(true);
      }
    } catch (err) {
      // `error` is ours, not a backend status: the mutation threw or the
      // network failed, so there is no claim status to report.
      trackGymFunnelEvent(gymClaimResult({ status: 'error', gymUuid }));
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

  const succeeded = sentTo !== null || adminSent || approved;

  // The submit buttons below are disabled without a token, and `useWsAuthToken`
  // gives up after three retries — so a dead /api/internal/ws-auth would leave
  // a permanently dead button with nothing on screen to explain it. Say so.
  const tokenUnavailable = !token && !tokenLoading;
  const blockingError = error ?? (tokenUnavailable ? t('claimGym.errors.tokenUnavailable') : null);

  let body: React.ReactNode;
  if (approved) {
    body = (
      <Box
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 2, textAlign: 'center' }}
      >
        <CheckCircleOutlined color="success" sx={{ fontSize: 40 }} />
        <DialogContentText>{t('claimGym.approved.body', { gym: gymName })}</DialogContentText>
        <MuiButton component={LocaleLink} href={`/gym/${gymUuid}/manage`} variant="contained" sx={{ mt: 1 }}>
          {t('claimGym.approved.manageCta')}
        </MuiButton>
      </Box>
    );
  } else if (sentTo) {
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
  } else if (mode === 'domain' && canClaimByDomain && domain) {
    body = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <DialogContentText>{t('claimGym.domain.description', { gym: gymName, domain })}</DialogContentText>
        {blockingError && <Alert severity="error">{blockingError}</Alert>}
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
        {blockingError && <Alert severity="error">{blockingError}</Alert>}
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
        {canClaimByDomain && (
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
    if (mode === 'domain' && canClaimByDomain && domain) {
      primaryAction = (
        <MuiButton
          variant="contained"
          onClick={submitDomainClaim}
          // `!token` matters here: `submit()` bails on a missing token, and
          // useWsAuthToken's query key includes the session status, so right
          // after signing in through the auth modal the token is still in
          // flight. Without this the first tap is a silent no-op.
          disabled={submitting || !token || !email.trim()}
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
          disabled={submitting || !token}
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
      <DialogContent>
        {body}
        {/* Two things every claimant asks before they commit, so they sit under
            both forms rather than in a confirmation nobody reads twice: what
            taking the listing protects, and what happens when the gym changes
            hands. Hidden once submitted — the confirmation is about what comes
            next, not about the terms. */}
        {!succeeded && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 2.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t('claimGym.protections.syncFreeze')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('claimGym.protections.transfer', { email: GYM_CLAIM_SUPPORT_EMAIL })}
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <MuiButton onClick={handleClose} sx={{ textTransform: 'none' }}>
          {succeeded ? t('claimGym.done') : t('claimGym.cancel')}
        </MuiButton>
        {primaryAction}
      </DialogActions>
    </Dialog>
  );
}

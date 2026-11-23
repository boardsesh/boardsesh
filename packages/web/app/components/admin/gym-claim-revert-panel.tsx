'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  AUTO_APPROVED_GYM_CLAIMS,
  REVERT_GYM_CLAIM,
  type AutoApprovedGymClaimsQueryResponse,
  type AutoApprovedGymClaimsQueryVariables,
  type RevertGymClaimMutationResponse,
  type RevertGymClaimMutationVariables,
} from '@boardsesh/graphql/operations';
import type { GymClaim } from '@boardsesh/shared-schema';
import { GYM_CLAIM_MESSAGE_MAX_LENGTH } from '@boardsesh/gym-claim';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { themeTokens } from '@/app/theme/theme-config';
import { revertRefusal, type GymClaimRevertRefusal } from './gym-claim-revert-logic';

const PAGE_SIZE = 20;

/** What the digest link found, when it didn't open a confirm. */
type LinkOutcome = { kind: 'missing' | 'alreadyReverted'; claimId: string } | null;

function claimantName(claim: GymClaim): string {
  return claim.claimantDisplayName || claim.claimantUserId;
}

/**
 * Claims that approved themselves, with a Revert on each one still approved
 * (docs/product/gym-claims.md, "Revert"). The daily digest links each
 * auto-approval to `/admin/gym-claims?revert=<claim id>`; that id arrives as
 * `revertClaimId` and opens its confirm straight away.
 *
 * Revert hands the gym back to SYSTEM, so the backend refuses it for a claim
 * that took the gym from a person or a gym that has moved since. Each refusal
 * says why and points at Move gym ownership, the panel below this one.
 */
export default function GymClaimRevertPanel({ revertClaimId = null }: { revertClaimId?: string | null }) {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [claims, setClaims] = useState<GymClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<GymClaim | null>(null);
  const [reason, setReason] = useState('');
  const [reverting, setReverting] = useState(false);
  const [refusal, setRefusal] = useState<GymClaimRevertRefusal | null>(null);
  const [linkOutcome, setLinkOutcome] = useState<LinkOutcome>(null);
  const [snackbar, setSnackbar] = useState('');

  // The auth token refreshes every few minutes. Reading it through a ref keeps
  // that from re-running the list and the digest lookup: a refresh must not
  // drop the pages already loaded, reopen a confirm the admin closed, wipe a
  // half-typed reason, or call a claim reverted a moment ago "already reverted".
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  const hasToken = Boolean(token);

  const fetchClaims = useCallback(async (offset = 0) => {
    const currentToken = tokenRef.current;
    if (!currentToken) return;
    setLoading(true);
    setLoadError(null);
    try {
      const client = createGraphQLHttpClient(currentToken);
      const result = await client.request<AutoApprovedGymClaimsQueryResponse, AutoApprovedGymClaimsQueryVariables>(
        AUTO_APPROVED_GYM_CLAIMS,
        { input: { limit: PAGE_SIZE, offset } },
      );
      setClaims((previous) =>
        offset === 0 ? result.autoApprovedGymClaims.claims : [...previous, ...result.autoApprovedGymClaims.claims],
      );
      setHasMore(result.autoApprovedGymClaims.hasMore);
    } catch (error) {
      console.error('[GymClaimRevertPanel] Failed to fetch claims:', error);
      setLoadError(offset);
    } finally {
      setLoading(false);
    }
  }, []);

  // The first page, once there is a token: again only after a sign-in, never on a refresh.
  useEffect(() => {
    if (hasToken) void fetchClaims();
  }, [hasToken, fetchClaims]);

  const openConfirm = useCallback((claim: GymClaim) => {
    setReason('');
    setRefusal(null);
    setConfirming(claim);
  }, []);

  // The digest link names one claim, and it is handled once: looked up (it may
  // be older than the first page), then its confirm opens or a line says why
  // there is nothing to confirm. A lookup cut short (unmount, sign-out) runs
  // again; a finished one never does.
  const handledRevertId = useRef<string | null>(null);
  useEffect(() => {
    if (!hasToken || !revertClaimId || handledRevertId.current === revertClaimId) return;
    const currentToken = tokenRef.current;
    if (!currentToken) return;
    handledRevertId.current = revertClaimId;
    let cancelled = false;
    let settled = false;
    void (async () => {
      try {
        const client = createGraphQLHttpClient(currentToken);
        const result = await client.request<AutoApprovedGymClaimsQueryResponse, AutoApprovedGymClaimsQueryVariables>(
          AUTO_APPROVED_GYM_CLAIMS,
          { input: { claimId: revertClaimId, limit: 1 } },
        );
        if (cancelled) return;
        const [linked] = result.autoApprovedGymClaims.claims;
        if (!linked) setLinkOutcome({ kind: 'missing', claimId: revertClaimId });
        else if (linked.status !== 'approved') setLinkOutcome({ kind: 'alreadyReverted', claimId: revertClaimId });
        else openConfirm(linked);
      } catch (error) {
        console.error('[GymClaimRevertPanel] Failed to look up the linked claim:', error);
        if (!cancelled) setLinkOutcome({ kind: 'missing', claimId: revertClaimId });
      } finally {
        settled = true;
      }
    })();
    return () => {
      cancelled = true;
      if (!settled && handledRevertId.current === revertClaimId) handledRevertId.current = null;
    };
  }, [hasToken, revertClaimId, openConfirm]);

  const closeConfirm = useCallback(() => {
    if (reverting) return;
    setConfirming(null);
  }, [reverting]);

  const revert = useCallback(async () => {
    const currentToken = tokenRef.current;
    if (!currentToken || !confirming) return;
    setReverting(true);
    setRefusal(null);
    try {
      const client = createGraphQLHttpClient(currentToken);
      const result = await client.request<RevertGymClaimMutationResponse, RevertGymClaimMutationVariables>(
        REVERT_GYM_CLAIM,
        { input: { claimId: confirming.id, reason: reason.trim() || null } },
      );
      const revertedId = confirming.id;
      setClaims((previous) =>
        previous.map((claim) => (claim.id === revertedId ? { ...claim, status: 'revoked' as const } : claim)),
      );
      setConfirming(null);
      setSnackbar(t('gymClaims.revert.done', { gym: result.revertGymClaim.gymName }));
    } catch (error) {
      // The dialog stays open on the refusal, which says what to do instead.
      setRefusal(revertRefusal(error));
    } finally {
      setReverting(false);
    }
  }, [confirming, reason, t]);

  const refusalMessage = (kind: GymClaimRevertRefusal): string => {
    switch (kind) {
      case 'notFound':
        return t('gymClaims.revert.errors.notFound');
      case 'notApproved':
        return t('gymClaims.revert.errors.notApproved');
      case 'notTransferred':
        return t('gymClaims.revert.errors.notTransferred');
      case 'ownerChanged':
        return t('gymClaims.revert.errors.ownerChanged');
      case 'priorOwner':
        return t('gymClaims.revert.errors.priorOwner');
      case 'failed':
        return t('gymClaims.revert.errors.failed');
    }
  };

  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="h6" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 0.5 }}>
        {t('gymClaims.autoApproved.heading')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('gymClaims.autoApproved.intro')}
      </Typography>

      {linkOutcome && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setLinkOutcome(null)}>
          {linkOutcome.kind === 'missing'
            ? t('gymClaims.revert.missing', { claimId: linkOutcome.claimId })
            : t('gymClaims.revert.alreadyReverted', { claimId: linkOutcome.claimId })}
        </Alert>
      )}

      {loadError !== null && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => fetchClaims(loadError)} sx={{ textTransform: 'none' }}>
              {t('gymClaims.retry')}
            </Button>
          }
        >
          {t('gymClaims.autoApproved.error')}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('gymClaims.table.claimant')}</TableCell>
              <TableCell>{t('gymClaims.table.gym')}</TableCell>
              <TableCell>{t('gymClaims.table.date')}</TableCell>
              <TableCell align="right">{t('gymClaims.table.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {claims.map((claim) => (
              <TableRow key={claim.id}>
                <TableCell>
                  <Typography variant="body2">{claimantName(claim)}</Typography>
                  {claim.claimantAccountAgeDays != null && (
                    <Typography variant="caption" color="text.secondary">
                      {t('gymClaims.claimantHistory', {
                        days: claim.claimantAccountAgeDays,
                        ticks: claim.claimantTickCount ?? 0,
                        gyms: claim.claimantGymsHeld ?? 0,
                      })}
                    </Typography>
                  )}
                </TableCell>
                <TableCell>{claim.gymName}</TableCell>
                <TableCell>
                  {t('gymClaims.autoApproved.approvedOn', {
                    date: new Date(claim.approvedAt ?? claim.createdAt).toLocaleDateString(),
                  })}
                </TableCell>
                <TableCell align="right">
                  {claim.status === 'approved' ? (
                    <Button
                      size="small"
                      color="error"
                      onClick={() => openConfirm(claim)}
                      aria-label={t('gymClaims.autoApproved.revertAria', {
                        claimant: claimantName(claim),
                        gym: claim.gymName,
                      })}
                      sx={{ textTransform: 'none' }}
                    >
                      {t('gymClaims.autoApproved.revert')}
                    </Button>
                  ) : (
                    <Chip size="small" variant="outlined" label={t('gymClaims.autoApproved.reverted')} />
                  )}
                </TableCell>
              </TableRow>
            ))}
            {claims.length === 0 && !loading && loadError === null && (
              <TableRow>
                <TableCell colSpan={4} align="center">
                  <Typography variant="body2" sx={{ color: themeTokens.neutral[400], py: 2 }}>
                    {t('gymClaims.autoApproved.empty')}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {loading && (
              <TableRow>
                <TableCell colSpan={4} align="center">
                  <CircularProgress size={20} sx={{ my: 2 }} />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {hasMore && (
        <Box sx={{ mt: 2, textAlign: 'center' }}>
          <Button
            variant="outlined"
            onClick={() => fetchClaims(claims.length)}
            disabled={loading}
            sx={{ textTransform: 'none' }}
          >
            {t('gymClaims.loadMore')}
          </Button>
        </Box>
      )}

      <Dialog open={confirming !== null} onClose={closeConfirm} maxWidth="sm" fullWidth>
        {confirming && (
          <>
            <DialogTitle>
              {t('gymClaims.revert.title', { claimant: claimantName(confirming), gym: confirming.gymName })}
            </DialogTitle>
            <DialogContent>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                {t('gymClaims.revert.body', { claimant: claimantName(confirming), gym: confirming.gymName })}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t('gymClaims.revert.notUndone')}
              </Typography>
              <TextField
                label={t('gymClaims.revert.reasonLabel')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                fullWidth
                multiline
                minRows={2}
                slotProps={{ htmlInput: { maxLength: GYM_CLAIM_MESSAGE_MAX_LENGTH } }}
              />
              {refusal && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  {refusalMessage(refusal)}
                </Alert>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={closeConfirm} disabled={reverting} sx={{ textTransform: 'none' }}>
                {t('gymClaims.revert.cancel')}
              </Button>
              <Button
                onClick={() => void revert()}
                color="error"
                variant="contained"
                disabled={reverting}
                sx={{ textTransform: 'none' }}
              >
                {t('gymClaims.revert.confirm')}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Snackbar open={!!snackbar} autoHideDuration={4000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}

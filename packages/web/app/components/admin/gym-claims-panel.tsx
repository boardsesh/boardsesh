'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Paper from '@mui/material/Paper';
import Button from '@mui/material/Button';
import Avatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  PENDING_GYM_CLAIMS,
  REVIEW_GYM_CLAIM,
  type PendingGymClaimsQueryResponse,
  type PendingGymClaimsQueryVariables,
  type ReviewGymClaimMutationResponse,
  type ReviewGymClaimMutationVariables,
} from '@boardsesh/graphql/operations';
import type { GymClaim } from '@boardsesh/shared-schema';

type GraphqlErrorLike = { extensions?: { code?: unknown } | null };

/**
 * The `extensions.code` the backend tags a rejected review with, read the same
 * way the handover panel next door reads its own codes. Only one code needs its
 * own line today: a claim the gym's ownership has already moved past, where the
 * fix is to deny it or run a deliberate handover — not to retry.
 */
function failureCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { errors?: GraphqlErrorLike[] } }).response;
  const graphqlErrors = Array.isArray(response?.errors) ? response.errors : [];
  for (const graphqlError of graphqlErrors) {
    const code = graphqlError.extensions?.code;
    if (typeof code === 'string') return code;
  }
  return null;
}

export default function GymClaimsPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [claims, setClaims] = useState<GymClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState('');
  // Track the last offset so the error state's Retry re-runs the same page.
  const [error, setError] = useState<number | null>(null);

  const fetchClaims = useCallback(
    async (offset = 0) => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<PendingGymClaimsQueryResponse, PendingGymClaimsQueryVariables>(
          PENDING_GYM_CLAIMS,
          { input: { limit: 50, offset } },
        );
        setClaims((prev) =>
          offset === 0 ? result.pendingGymClaims.claims : [...prev, ...result.pendingGymClaims.claims],
        );
        setHasMore(result.pendingGymClaims.hasMore);
      } catch (err) {
        console.error('[GymClaimsPanel] Failed to fetch claims:', err);
        // Surface the failure so an admin can tell an empty queue from a dead
        // fetch. Remember the offset so Retry re-requests the same page.
        setError(offset);
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void fetchClaims();
  }, [fetchClaims]);

  const review = useCallback(
    async (claimId: string, decision: 'approve' | 'deny') => {
      if (!token) return;
      setPendingId(claimId);
      try {
        const client = createGraphQLHttpClient(token);
        await client.request<ReviewGymClaimMutationResponse, ReviewGymClaimMutationVariables>(REVIEW_GYM_CLAIM, {
          input: { claimId, decision },
        });
        setClaims((prev) => prev.filter((claim) => claim.id !== claimId));
        setSnackbar(decision === 'approve' ? t('gymClaims.snackbar.approved') : t('gymClaims.snackbar.denied'));
      } catch (err) {
        // A superseded claim is still pending and Deny is the next action, so
        // the row deliberately stays in the table.
        setSnackbar(
          failureCode(err) === 'GYM_CLAIM_SUPERSEDED'
            ? t('gymClaims.snackbar.superseded')
            : t('gymClaims.snackbar.failed'),
        );
      } finally {
        setPendingId(null);
      }
    },
    [token, t],
  );

  return (
    <Box>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
        {t('gymClaims.heading')}
      </Typography>

      {error !== null && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => fetchClaims(error)} sx={{ textTransform: 'none' }}>
              {t('gymClaims.retry')}
            </Button>
          }
        >
          {t('gymClaims.error')}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('gymClaims.table.claimant')}</TableCell>
              <TableCell>{t('gymClaims.table.gym')}</TableCell>
              <TableCell>{t('gymClaims.table.method')}</TableCell>
              <TableCell>{t('gymClaims.table.detail')}</TableCell>
              <TableCell>{t('gymClaims.table.date')}</TableCell>
              <TableCell align="right">{t('gymClaims.table.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {claims.map((claim) => (
              <TableRow key={claim.id}>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Avatar src={claim.claimantAvatarUrl || undefined} sx={{ width: 28, height: 28, fontSize: 12 }}>
                      {claim.claimantDisplayName?.[0]?.toUpperCase()}
                    </Avatar>
                    <Typography variant="body2">{claim.claimantDisplayName || claim.claimantUserId}</Typography>
                  </Box>
                </TableCell>
                <TableCell>{claim.gymName}</TableCell>
                <TableCell>
                  <Chip
                    label={claim.method === 'domain' ? t('gymClaims.method.domain') : t('gymClaims.method.admin')}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: 11 }}
                  />
                </TableCell>
                <TableCell sx={{ maxWidth: 220, wordBreak: 'break-word' }}>
                  <Typography variant="body2" color="text.secondary">
                    {claim.claimEmail || claim.message || '—'}
                  </Typography>
                </TableCell>
                <TableCell>{new Date(claim.createdAt).toLocaleDateString()}</TableCell>
                <TableCell align="right">
                  <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                    <Button
                      size="small"
                      variant="contained"
                      disabled={pendingId === claim.id}
                      onClick={() => review(claim.id, 'approve')}
                      sx={{ textTransform: 'none' }}
                    >
                      {t('gymClaims.approve')}
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      disabled={pendingId === claim.id}
                      onClick={() => review(claim.id, 'deny')}
                      sx={{ textTransform: 'none' }}
                    >
                      {t('gymClaims.deny')}
                    </Button>
                  </Box>
                </TableCell>
              </TableRow>
            ))}
            {claims.length === 0 && !loading && error === null && (
              <TableRow>
                <TableCell colSpan={6} align="center">
                  <Typography variant="body2" sx={{ color: themeTokens.neutral[400], py: 2 }}>
                    {t('gymClaims.empty')}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {loading && (
              <TableRow>
                <TableCell colSpan={6} align="center">
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

      {/* 4s to match the two sibling admin panels — the rejection lines here are
          a sentence of instruction, not a one-word confirmation. */}
      <Snackbar open={!!snackbar} autoHideDuration={4000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}

'use client';

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { GymOwnershipSummary, GymOwnershipUserSummary } from '@boardsesh/shared-schema';
import {
  GYM_OWNERSHIP_LOOKUP,
  REASSIGN_GYM_OWNER,
  type GymOwnershipLookupQueryResponse,
  type GymOwnershipLookupQueryVariables,
  type ReassignGymOwnerMutationResponse,
  type ReassignGymOwnerMutationVariables,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { themeTokens } from '@/app/theme/theme-config';

const MIN_REASON_LENGTH = 10;

type Resolved = {
  gym: GymOwnershipSummary | null;
  newOwner: GymOwnershipUserSummary | null;
};

type GraphqlErrorLike = { extensions?: { code?: unknown } | null };

/**
 * The `extensions.code` the backend tags every handover rejection with. Reading
 * it is what makes the optimistic-concurrency design usable: the common failure
 * is a stale confirmation (`OWNER_CHANGED`), whose fix is "re-run the lookup",
 * and a generic "try again" tells the admin nothing about that.
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

/**
 * Admin-only ownership handover, mounted next to the claim review queue because
 * that is where a mis-approved claim gets noticed. Nothing here is reachable
 * without a global admin session — the mutation is gated server-side too.
 */
export default function GymOwnerReassignPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [gymQuery, setGymQuery] = useState('');
  const [newOwnerQuery, setNewOwnerQuery] = useState('');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [looking, setLooking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [snackbar, setSnackbar] = useState('');

  const lookup = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!token || gymQuery.trim().length === 0 || newOwnerQuery.trim().length === 0) return;
      setLooking(true);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<GymOwnershipLookupQueryResponse, GymOwnershipLookupQueryVariables>(
          GYM_OWNERSHIP_LOOKUP,
          { input: { gymQuery: gymQuery.trim(), newOwnerQuery: newOwnerQuery.trim() } },
        );
        setResolved({
          gym: result.gymOwnershipLookup.gym ?? null,
          newOwner: result.gymOwnershipLookup.newOwner ?? null,
        });
      } catch (lookupError) {
        console.error('[GymOwnerReassignPanel] Ownership lookup failed:', lookupError);
        setResolved(null);
        setSnackbar(t('gymOwnerReassign.snackbar.lookupFailed'));
      } finally {
        setLooking(false);
      }
    },
    [gymQuery, newOwnerQuery, t, token],
  );

  const gym = resolved?.gym ?? null;
  const newOwner = resolved?.newOwner ?? null;
  const ownersAreSame = gym !== null && newOwner !== null && gym.currentOwnerId === newOwner.userId;
  const canReassign =
    gym !== null && newOwner !== null && !gym.isDeleted && !gym.isMerged && !ownersAreSame && !submitting;
  const outgoingLabel = gym?.currentOwnerLabel ?? gym?.currentOwnerId ?? '';

  // Each rejection gets its own line so the admin knows whether to re-run the
  // lookup, pick another account, or stop. Keys are literals — the i18n linter
  // rejects `t(variable)`.
  const failureMessage = useCallback(
    (error: unknown): string => {
      switch (failureCode(error)) {
        case 'GYM_REASSIGN_OWNER_CHANGED':
          return t('gymOwnerReassign.snackbar.ownerChanged');
        case 'GYM_REASSIGN_NEW_OWNER_NOT_FOUND':
          return t('gymOwnerReassign.snackbar.newOwnerGone');
        case 'GYM_REASSIGN_TARGET_MERGED':
          return t('gymOwnerReassign.snackbar.merged');
        case 'GYM_REASSIGN_TARGET_NOT_FOUND':
          return t('gymOwnerReassign.snackbar.gymGone');
        case 'GYM_REASSIGN_OWNER_UNCHANGED':
          return t('gymOwnerReassign.snackbar.ownerUnchanged');
        default:
          return t('gymOwnerReassign.snackbar.failed');
      }
    },
    [t],
  );

  // Does not reset `reason`: a rejected handover closes the dialog but keeps the
  // justification, so reopening after a fresh lookup is one click, not a retype.
  const openConfirm = useCallback(() => {
    setConfirmOpen(true);
  }, []);

  const closeConfirm = useCallback(() => {
    if (submitting) return;
    setConfirmOpen(false);
    setReason('');
  }, [submitting]);

  const reassign = useCallback(async () => {
    if (!token || !gym || !newOwner || reason.trim().length < MIN_REASON_LENGTH) return;
    setSubmitting(true);
    try {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<ReassignGymOwnerMutationResponse, ReassignGymOwnerMutationVariables>(
        REASSIGN_GYM_OWNER,
        {
          input: {
            gymUuid: gym.gymUuid,
            expectedCurrentOwnerId: gym.currentOwnerId,
            newOwnerId: newOwner.userId,
            reason: reason.trim(),
          },
        },
      );
      setSnackbar(t('gymOwnerReassign.snackbar.moved', { gym: result.reassignGymOwner.gymName }));
      setConfirmOpen(false);
      setReason('');
      setResolved(null);
    } catch (mutationError) {
      console.error('[GymOwnerReassignPanel] Ownership handover failed:', mutationError);
      setSnackbar(failureMessage(mutationError));
      setConfirmOpen(false);
      // Deliberately NOT clearing `reason`: the common rejection is a stale
      // confirmation, whose fix is to re-run the lookup and confirm again.
      // Wiping the justification would make the admin retype 10+ characters
      // for a retry that is otherwise one click away.
    } finally {
      setSubmitting(false);
    }
  }, [failureMessage, gym, newOwner, reason, t, token]);

  return (
    <Box sx={{ mt: 5 }}>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
        {t('gymOwnerReassign.title')}
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        {t('gymOwnerReassign.intro')}
      </Alert>

      <Box component="form" onSubmit={lookup} sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
        <TextField
          size="small"
          value={gymQuery}
          onChange={(event) => setGymQuery(event.target.value)}
          label={t('gymOwnerReassign.form.gymLabel')}
          placeholder={t('gymOwnerReassign.form.gymPlaceholder')}
          inputProps={{ maxLength: 200 }}
          sx={{ flex: '1 1 260px' }}
        />
        <TextField
          size="small"
          value={newOwnerQuery}
          onChange={(event) => setNewOwnerQuery(event.target.value)}
          label={t('gymOwnerReassign.form.ownerLabel')}
          placeholder={t('gymOwnerReassign.form.ownerPlaceholder')}
          inputProps={{ maxLength: 255 }}
          sx={{ flex: '1 1 260px' }}
        />
        <Button type="submit" variant="outlined" disabled={looking} sx={{ textTransform: 'none', flexShrink: 0 }}>
          {looking ? t('gymOwnerReassign.form.searching') : t('gymOwnerReassign.form.submit')}
        </Button>
      </Box>

      {resolved !== null && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle2" sx={{ color: themeTokens.neutral[600] }}>
                {t('gymOwnerReassign.result.gymHeading')}
              </Typography>
              {gym === null ? (
                <Typography variant="body2">{t('gymOwnerReassign.result.noGym')}</Typography>
              ) : (
                <Stack spacing={0.5}>
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>
                    {gym.name}
                  </Typography>
                  <Typography variant="caption" sx={{ color: themeTokens.neutral[500], wordBreak: 'break-all' }}>
                    {gym.gymUuid}
                  </Typography>
                  <Typography variant="body2">
                    {t('gymOwnerReassign.result.currentOwner', {
                      owner: gym.currentOwnerLabel ?? t('gymOwnerReassign.result.unknownOwner'),
                    })}
                  </Typography>
                  <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={
                        gym.syncFrozenAt ? t('gymOwnerReassign.result.frozen') : t('gymOwnerReassign.result.notFrozen')
                      }
                    />
                    {gym.currentOwnerIsSystem && (
                      <Chip size="small" variant="outlined" label={t('gymOwnerReassign.result.systemOwned')} />
                    )}
                  </Stack>
                </Stack>
              )}
            </Box>

            <Box>
              <Typography variant="subtitle2" sx={{ color: themeTokens.neutral[600] }}>
                {t('gymOwnerReassign.result.ownerHeading')}
              </Typography>
              {newOwner === null ? (
                <Typography variant="body2">{t('gymOwnerReassign.result.noOwner')}</Typography>
              ) : (
                <Stack spacing={0.25}>
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>
                    {newOwner.label}
                  </Typography>
                  <Typography variant="caption" sx={{ color: themeTokens.neutral[500], wordBreak: 'break-all' }}>
                    {newOwner.email ?? newOwner.userId}
                  </Typography>
                </Stack>
              )}
            </Box>

            {gym?.isDeleted && <Alert severity="error">{t('gymOwnerReassign.result.deleted')}</Alert>}
            {gym?.isMerged && <Alert severity="error">{t('gymOwnerReassign.result.merged')}</Alert>}
            {ownersAreSame && <Alert severity="warning">{t('gymOwnerReassign.result.sameOwner')}</Alert>}

            <Box>
              <Button
                variant="contained"
                color="warning"
                disabled={!canReassign}
                onClick={openConfirm}
                sx={{ textTransform: 'none' }}
              >
                {t('gymOwnerReassign.actions.reassign')}
              </Button>
            </Box>
          </Stack>
        </Paper>
      )}

      <Dialog open={confirmOpen} onClose={closeConfirm} fullWidth maxWidth="sm">
        <DialogTitle>{t('gymOwnerReassign.confirm.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {t('gymOwnerReassign.confirm.body', {
              gym: gym?.name ?? '',
              from: outgoingLabel,
              to: newOwner?.label ?? '',
            })}
          </DialogContentText>
          <Alert severity="info" sx={{ mb: 2 }}>
            {t('gymOwnerReassign.confirm.freezeNote')}
          </Alert>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            label={t('gymOwnerReassign.confirm.reasonLabel')}
            placeholder={t('gymOwnerReassign.confirm.reasonPlaceholder')}
            helperText={
              reason.trim().length < MIN_REASON_LENGTH
                ? t('gymOwnerReassign.confirm.reasonRemaining', { count: MIN_REASON_LENGTH - reason.trim().length })
                : t('gymOwnerReassign.confirm.reasonStored')
            }
            inputProps={{ maxLength: 500 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeConfirm} disabled={submitting} sx={{ textTransform: 'none' }}>
            {t('gymOwnerReassign.confirm.cancel')}
          </Button>
          <Button
            onClick={reassign}
            variant="contained"
            color="warning"
            disabled={submitting || reason.trim().length < MIN_REASON_LENGTH}
            sx={{ textTransform: 'none' }}
          >
            {submitting ? t('gymOwnerReassign.confirm.submitting') : t('gymOwnerReassign.confirm.submit')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snackbar.length > 0} autoHideDuration={4000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}

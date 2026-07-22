'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Paper from '@mui/material/Paper';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormControlLabel from '@mui/material/FormControlLabel';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  DUPLICATE_GYM_CLUSTERS,
  ORPHAN_GYMS,
  MERGE_GYMS,
  DISMISS_GYM_CLUSTER,
  type DuplicateGymClustersQueryResponse,
  type DuplicateGymClustersQueryVariables,
  type OrphanGymsQueryResponse,
  type OrphanGymsQueryVariables,
  type MergeGymsMutationResponse,
  type MergeGymsMutationVariables,
  type DismissGymClusterMutationResponse,
  type DismissGymClusterMutationVariables,
} from '@boardsesh/graphql/operations';
import type { DuplicateGymCluster, DuplicateGymMember, OrphanGym, KioskSlugWarning } from '@boardsesh/shared-schema';

const PAGE_SIZE = 20;

// Sum the FK counts an admin is about to move off the duplicates onto the survivor.
function sumDuplicateCounts(duplicates: DuplicateGymMember[]) {
  return duplicates.reduce(
    (totals, member) => ({
      boards: totals.boards + member.boardCount,
      follows: totals.follows + member.followerCount,
      members: totals.members + member.memberCount,
      kiosks: totals.kiosks + member.kioskCount,
      claims: totals.claims + member.claimCount,
    }),
    { boards: 0, follows: 0, members: 0, kiosks: 0, claims: 0 },
  );
}

function DuplicatesQueue() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [clusters, setClusters] = useState<DuplicateGymCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  // `null` = no error; otherwise the offset to retry. Wrapped in an object so a
  // 0 offset is never mistaken for "no error" by a truthiness check.
  const [error, setError] = useState<{ offset: number } | null>(null);
  const [snackbar, setSnackbar] = useState('');
  // Per-cluster canonical survivor selection, keyed by cluster signature.
  const [selection, setSelection] = useState<Record<string, string>>({});
  // The cluster awaiting a merge confirmation, or null when the dialog is closed.
  const [mergeTarget, setMergeTarget] = useState<DuplicateGymCluster | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  // Kiosk slug moves surfaced from the most recent merge — kept until dismissed.
  const [kioskWarnings, setKioskWarnings] = useState<KioskSlugWarning[]>([]);

  const fetchClusters = useCallback(
    async (offset = 0) => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<DuplicateGymClustersQueryResponse, DuplicateGymClustersQueryVariables>(
          DUPLICATE_GYM_CLUSTERS,
          { input: { limit: PAGE_SIZE, offset } },
        );
        const incoming = result.duplicateGymClusters.clusters;
        setClusters((prev) => (offset === 0 ? incoming : [...prev, ...incoming]));
        setSelection((prev) => {
          const next = { ...prev };
          for (const cluster of incoming) {
            if (next[cluster.signature] === undefined) {
              next[cluster.signature] = cluster.suggestedCanonicalGymUuid;
            }
          }
          return next;
        });
        setHasMore(result.duplicateGymClusters.hasMore);
      } catch (err) {
        console.error('[GymDuplicatesPanel] Failed to fetch duplicate clusters:', err);
        setError({ offset });
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void fetchClusters();
  }, [fetchClusters]);

  const selectCanonical = useCallback((signature: string, gymUuid: string) => {
    setSelection((prev) => ({ ...prev, [signature]: gymUuid }));
  }, []);

  const confirmMerge = useCallback(async () => {
    if (!token || !mergeTarget) return;
    const canonicalGymUuid = selection[mergeTarget.signature] ?? mergeTarget.suggestedCanonicalGymUuid;
    const duplicates = mergeTarget.members.filter((member) => member.gymUuid !== canonicalGymUuid);
    const duplicateGymUuids = duplicates.map((member) => member.gymUuid);
    // Keeping a SYSTEM listing as the survivor over a user-owned / claim-approved
    // duplicate inverts the pre-selection; the backend rejects it without this flag.
    const canonicalMember = mergeTarget.members.find((member) => member.gymUuid === canonicalGymUuid);
    const allowSystemCanonicalOverride =
      canonicalMember?.ownerType === 'system' &&
      duplicates.some((member) => member.ownerType === 'user' || member.claimStatus === 'approved');
    setSubmitting(true);
    try {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<MergeGymsMutationResponse, MergeGymsMutationVariables>(MERGE_GYMS, {
        input: { canonicalGymUuid, duplicateGymUuids, allowSystemCanonicalOverride },
      });
      const warnings = result.mergeGyms.results.flatMap((duplicate) => duplicate.warnings);
      if (warnings.length > 0) setKioskWarnings((prev) => [...prev, ...warnings]);
      setClusters((prev) => prev.filter((cluster) => cluster.signature !== mergeTarget.signature));
      setSnackbar(t('gymDuplicates.snackbar.merged'));
      setMergeTarget(null);
    } catch {
      setSnackbar(t('gymDuplicates.snackbar.mergeFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [token, mergeTarget, selection, t]);

  const dismissCluster = useCallback(
    async (cluster: DuplicateGymCluster) => {
      if (!token) return;
      const canonicalGymUuid = selection[cluster.signature] ?? cluster.suggestedCanonicalGymUuid;
      setPendingSignature(cluster.signature);
      try {
        const client = createGraphQLHttpClient(token);
        await client.request<DismissGymClusterMutationResponse, DismissGymClusterMutationVariables>(
          DISMISS_GYM_CLUSTER,
          { input: { gymUuids: cluster.members.map((member) => member.gymUuid), canonicalGymUuid } },
        );
        setClusters((prev) => prev.filter((entry) => entry.signature !== cluster.signature));
        setSnackbar(t('gymDuplicates.snackbar.dismissed'));
      } catch {
        setSnackbar(t('gymDuplicates.snackbar.dismissFailed'));
      } finally {
        setPendingSignature(null);
      }
    },
    [token, selection, t],
  );

  const mergeCanonicalUuid = mergeTarget
    ? (selection[mergeTarget.signature] ?? mergeTarget.suggestedCanonicalGymUuid)
    : null;
  const mergeDuplicates = mergeTarget
    ? mergeTarget.members.filter((member) => member.gymUuid !== mergeCanonicalUuid)
    : [];
  const mergeCanonicalMember = mergeTarget
    ? mergeTarget.members.find((member) => member.gymUuid === mergeCanonicalUuid)
    : undefined;
  const mergeTotals = sumDuplicateCounts(mergeDuplicates);
  // The admin has inverted the pre-selection: a SYSTEM listing survives over a
  // user-owned or claim-approved duplicate. Warn and require confirmation.
  const mergeOverrideRequired =
    mergeCanonicalMember?.ownerType === 'system' &&
    mergeDuplicates.some((member) => member.ownerType === 'user' || member.claimStatus === 'approved');

  return (
    <Box>
      {/* Owner-reported duplicates arrive as team emails (see reportGymDuplicate);
          there's no persisted reports table yet, so surface where to find them. */}
      <Alert severity="info" sx={{ mb: 2 }}>
        {t('gymDuplicates.ownerReports.note')}
      </Alert>

      {kioskWarnings.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }} onClose={() => setKioskWarnings([])}>
          <Stack spacing={0.5}>
            {kioskWarnings.map((warning) => (
              <Typography key={warning.kioskUuid} variant="body2">
                {t('gymDuplicates.kioskWarning', {
                  name: warning.kioskName,
                  previous: warning.previousSlug,
                  next: warning.newSlug,
                })}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}

      {error !== null && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => error !== null && fetchClusters(error.offset)}
              sx={{ textTransform: 'none' }}
            >
              {t('gymDuplicates.retry')}
            </Button>
          }
        >
          {t('gymDuplicates.error')}
        </Alert>
      )}

      <Stack spacing={2}>
        {clusters.map((cluster) => {
          const selected = selection[cluster.signature] ?? cluster.suggestedCanonicalGymUuid;
          return (
            <Card key={cluster.signature} variant="outlined">
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    {cluster.normalizedName}
                  </Typography>
                  <Chip
                    label={cluster.tier === 'A' ? t('gymDuplicates.tier.a') : t('gymDuplicates.tier.b')}
                    size="small"
                    color={cluster.tier === 'A' ? 'success' : 'warning'}
                    variant="outlined"
                    sx={{ fontSize: 11 }}
                  />
                  <Typography variant="caption" sx={{ color: themeTokens.neutral[500] }}>
                    {t('gymDuplicates.maxDistance', { meters: Math.round(cluster.maxDistanceMeters) })}
                  </Typography>
                </Box>

                <RadioGroup
                  value={selected}
                  onChange={(event) => selectCanonical(cluster.signature, event.target.value)}
                >
                  <Stack divider={<Divider flexItem />} spacing={1}>
                    {cluster.members.map((member) => (
                      <FormControlLabel
                        key={member.gymUuid}
                        value={member.gymUuid}
                        control={<Radio size="small" />}
                        sx={{ alignItems: 'flex-start', m: 0 }}
                        slotProps={{ typography: { sx: { width: '100%' } } }}
                        label={
                          <Box sx={{ pt: 0.5 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {member.name}
                              </Typography>
                              <Chip
                                label={
                                  member.ownerType === 'system'
                                    ? t('gymDuplicates.owner.system')
                                    : t('gymDuplicates.owner.user')
                                }
                                size="small"
                                color={member.ownerType === 'system' ? 'default' : 'success'}
                                variant="outlined"
                                sx={{ fontSize: 10 }}
                              />
                              {member.claimStatus !== 'none' && (
                                <Chip
                                  label={
                                    member.claimStatus === 'approved'
                                      ? t('gymDuplicates.claim.approved')
                                      : t('gymDuplicates.claim.pending')
                                  }
                                  size="small"
                                  color="primary"
                                  variant="outlined"
                                  sx={{ fontSize: 10 }}
                                />
                              )}
                              {member.providerOrigins.map((provider) => (
                                <Chip key={provider} label={provider} size="small" sx={{ fontSize: 10 }} />
                              ))}
                            </Box>
                            <Typography variant="caption" sx={{ display: 'block', color: themeTokens.neutral[500] }}>
                              {member.address || '—'}
                            </Typography>
                            <Typography variant="caption" sx={{ display: 'block', color: themeTokens.neutral[500] }}>
                              {t('gymDuplicates.counts', {
                                boards: member.boardCount,
                                follows: member.followerCount,
                                members: member.memberCount,
                                kiosks: member.kioskCount,
                                claims: member.claimCount,
                              })}
                              {' · '}
                              {t('gymDuplicates.distance', {
                                meters: Math.round(member.distanceToCanonicalMeters),
                              })}
                            </Typography>
                          </Box>
                        }
                      />
                    ))}
                  </Stack>
                </RadioGroup>

                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 2 }}>
                  <Button
                    color="error"
                    onClick={() => dismissCluster(cluster)}
                    disabled={pendingSignature === cluster.signature}
                    sx={{ textTransform: 'none' }}
                  >
                    {t('gymDuplicates.dismiss')}
                  </Button>
                  <Button
                    variant="contained"
                    onClick={() => setMergeTarget(cluster)}
                    disabled={pendingSignature === cluster.signature}
                    sx={{ textTransform: 'none' }}
                  >
                    {t('gymDuplicates.merge')}
                  </Button>
                </Box>
              </CardContent>
            </Card>
          );
        })}

        {clusters.length === 0 && !loading && error === null && (
          <Typography variant="body2" sx={{ color: themeTokens.neutral[400], py: 2, textAlign: 'center' }}>
            {t('gymDuplicates.empty')}
          </Typography>
        )}

        {loading && (
          <Box sx={{ textAlign: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        )}
      </Stack>

      {hasMore && (
        <Box sx={{ mt: 2, textAlign: 'center' }}>
          <Button
            variant="outlined"
            onClick={() => fetchClusters(clusters.length)}
            disabled={loading}
            sx={{ textTransform: 'none' }}
          >
            {t('gymDuplicates.loadMore')}
          </Button>
        </Box>
      )}

      <Dialog open={mergeTarget !== null} onClose={() => (submitting ? undefined : setMergeTarget(null))}>
        <DialogTitle>{t('gymDuplicates.confirm.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('gymDuplicates.confirm.body', {
              count: mergeDuplicates.length,
              canonical: mergeCanonicalMember?.name ?? '',
              boards: mergeTotals.boards,
              follows: mergeTotals.follows,
              members: mergeTotals.members,
              kiosks: mergeTotals.kiosks,
              claims: mergeTotals.claims,
            })}
          </DialogContentText>
          {mergeOverrideRequired && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {t('gymDuplicates.confirm.overrideWarning')}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMergeTarget(null)} disabled={submitting} sx={{ textTransform: 'none' }}>
            {t('gymDuplicates.confirm.cancel')}
          </Button>
          <Button
            variant="contained"
            color={mergeOverrideRequired ? 'warning' : 'primary'}
            onClick={confirmMerge}
            disabled={submitting}
            sx={{ textTransform: 'none' }}
          >
            {mergeOverrideRequired ? t('gymDuplicates.confirm.confirmOverride') : t('gymDuplicates.confirm.confirm')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}

function OrphanAudit() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [orphans, setOrphans] = useState<OrphanGym[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  // `null` = no error; otherwise the offset to retry (wrapped so offset 0 isn't
  // mistaken for "no error").
  const [error, setError] = useState<{ offset: number } | null>(null);

  const fetchOrphans = useCallback(
    async (offset = 0) => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<OrphanGymsQueryResponse, OrphanGymsQueryVariables>(ORPHAN_GYMS, {
          input: { limit: PAGE_SIZE, offset },
        });
        setOrphans((prev) => (offset === 0 ? result.orphanGyms.gyms : [...prev, ...result.orphanGyms.gyms]));
        setTotalCount(result.orphanGyms.totalCount);
        setHasMore(result.orphanGyms.hasMore);
      } catch (err) {
        console.error('[GymDuplicatesPanel] Failed to fetch orphan gyms:', err);
        setError({ offset });
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void fetchOrphans();
  }, [fetchOrphans]);

  return (
    <Box>
      {error !== null && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => error !== null && fetchOrphans(error.offset)}
              sx={{ textTransform: 'none' }}
            >
              {t('gymDuplicates.retry')}
            </Button>
          }
        >
          {t('gymDuplicates.error')}
        </Alert>
      )}

      <Typography variant="body2" sx={{ mb: 2, color: themeTokens.neutral[600] }}>
        {t('gymDuplicates.orphans.summary', { count: totalCount })}
      </Typography>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('gymDuplicates.orphans.name')}</TableCell>
              <TableCell>{t('gymDuplicates.orphans.address')}</TableCell>
              <TableCell>{t('gymDuplicates.orphans.counts')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {orphans.map((orphan) => (
              <TableRow key={orphan.gymUuid}>
                <TableCell>
                  <MuiLink
                    component={LocaleLink}
                    href={`/gym/${orphan.slug ?? orphan.gymUuid}`}
                    underline="hover"
                    variant="body2"
                    sx={{ color: themeTokens.colors.primary }}
                  >
                    {orphan.name}
                  </MuiLink>
                </TableCell>
                <TableCell sx={{ color: themeTokens.neutral[500] }}>{orphan.address || '—'}</TableCell>
                <TableCell sx={{ color: themeTokens.neutral[500] }}>
                  {t('gymDuplicates.orphanCounts', {
                    boards: orphan.boardCount,
                    follows: orphan.followerCount,
                    members: orphan.memberCount,
                    kiosks: orphan.kioskCount,
                  })}
                </TableCell>
              </TableRow>
            ))}
            {orphans.length === 0 && !loading && error === null && (
              <TableRow>
                <TableCell colSpan={3} align="center">
                  <Typography variant="body2" sx={{ color: themeTokens.neutral[400], py: 2 }}>
                    {t('gymDuplicates.orphans.empty')}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {loading && (
              <TableRow>
                <TableCell colSpan={3} align="center">
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
            onClick={() => fetchOrphans(orphans.length)}
            disabled={loading}
            sx={{ textTransform: 'none' }}
          >
            {t('gymDuplicates.loadMore')}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default function GymDuplicatesPanel() {
  const { t } = useTranslation('admin');
  const [tab, setTab] = useState(0);

  return (
    <Box>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
        {t('gymDuplicates.heading')}
      </Typography>

      <Box sx={{ borderBottom: 1, borderColor: themeTokens.neutral[200], mb: 3 }}>
        <Tabs value={tab} onChange={(_, value) => setTab(value)}>
          <Tab label={t('gymDuplicates.tabs.duplicates')} sx={{ textTransform: 'none' }} />
          <Tab label={t('gymDuplicates.tabs.orphans')} sx={{ textTransform: 'none' }} />
        </Tabs>
      </Box>

      {/* Keep the duplicates queue mounted so merge selections survive a tab switch;
          the orphan audit mounts lazily on first open. */}
      <Box sx={{ display: tab === 0 ? 'block' : 'none' }}>
        <DuplicatesQueue />
      </Box>
      {tab === 1 && <OrphanAudit />}
    </Box>
  );
}

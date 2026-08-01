'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import MuiLink from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { FrozenLocationSyncEntity, LocationSyncEntityType } from '@boardsesh/shared-schema';
import {
  CLEAR_LOCATION_SYNC_FREEZE,
  FROZEN_LOCATION_SYNC_ENTITIES,
  type ClearLocationSyncFreezeMutationResponse,
  type ClearLocationSyncFreezeMutationVariables,
  type FrozenLocationSyncEntitiesQueryResponse,
  type FrozenLocationSyncEntitiesQueryVariables,
} from '@boardsesh/graphql/operations';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { themeTokens } from '@/app/theme/theme-config';

const PAGE_SIZE = 20;
const MIN_REASON_LENGTH = 10;

export default function LocationSyncFreezesPanel() {
  const { t, i18n } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [entityType, setEntityType] = useState<LocationSyncEntityType>('GYM');
  const [entities, setEntities] = useState<FrozenLocationSyncEntity[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ offset: number } | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<FrozenLocationSyncEntity | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [snackbar, setSnackbar] = useState('');
  const requestGenerationRef = useRef(0);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );

  const fetchEntities = useCallback(
    async (offset = 0) => {
      const requestGeneration = ++requestGenerationRef.current;
      if (!token) {
        if (requestGeneration === requestGenerationRef.current) {
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<
          FrozenLocationSyncEntitiesQueryResponse,
          FrozenLocationSyncEntitiesQueryVariables
        >(FROZEN_LOCATION_SYNC_ENTITIES, {
          input: { entityType, query: query || undefined, limit: PAGE_SIZE, offset },
        });
        if (requestGeneration !== requestGenerationRef.current) return;
        const connection = result.frozenLocationSyncEntities;
        setEntities((previous) => (offset === 0 ? connection.entities : [...previous, ...connection.entities]));
        setTotalCount(connection.totalCount);
        setHasMore(connection.hasMore);
      } catch (fetchError) {
        if (requestGeneration !== requestGenerationRef.current) return;
        console.error('[LocationSyncFreezesPanel] Failed to fetch frozen entities:', fetchError);
        setError({ offset });
      } finally {
        if (requestGeneration === requestGenerationRef.current) {
          setLoading(false);
        }
      }
    },
    [entityType, query, token],
  );

  useEffect(() => {
    void fetchEntities();
    return () => {
      // Dependency changes and unmounts invalidate a request before its promise
      // can publish results for an obsolete tab/search generation.
      requestGenerationRef.current += 1;
    };
  }, [fetchEntities]);

  const changeEntityType = useCallback((_: React.SyntheticEvent, nextEntityType: LocationSyncEntityType) => {
    requestGenerationRef.current += 1;
    setEntityType(nextEntityType);
    setEntities([]);
    setTotalCount(0);
    setHasMore(false);
    setError(null);
  }, []);

  const submitSearch = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const nextQuery = searchInput.trim();
      if (nextQuery === query) {
        void fetchEntities();
      } else {
        requestGenerationRef.current += 1;
        setEntities([]);
        setTotalCount(0);
        setHasMore(false);
        setError(null);
        setLoading(true);
        setQuery(nextQuery);
      }
    },
    [fetchEntities, query, searchInput],
  );

  const openConfirmation = useCallback((entity: FrozenLocationSyncEntity) => {
    setTarget(entity);
    setReason('');
  }, []);

  const closeConfirmation = useCallback(() => {
    if (submitting) return;
    setTarget(null);
    setReason('');
  }, [submitting]);

  const clearFreeze = useCallback(async () => {
    if (!token || !target || reason.trim().length < MIN_REASON_LENGTH) return;
    // A list refresh can still be in flight while its existing rows remain
    // actionable. Invalidate it before clearing so a late response cannot put
    // the released row back into the table.
    const mutationListGeneration = ++requestGenerationRef.current;
    setLoading(false);
    setSubmitting(true);
    try {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<
        ClearLocationSyncFreezeMutationResponse,
        ClearLocationSyncFreezeMutationVariables
      >(CLEAR_LOCATION_SYNC_FREEZE, {
        input: {
          entityType: target.entityType,
          entityUuid: target.entityUuid,
          expectedSyncFrozenAt: target.syncFrozenAt,
          reason: reason.trim(),
        },
      });
      const listViewIsStillCurrent = requestGenerationRef.current === mutationListGeneration;
      if (listViewIsStillCurrent) {
        setEntities((previous) => previous.filter((entity) => entity.entityUuid !== target.entityUuid));
        setTotalCount((previous) => Math.max(0, previous - 1));
      }
      setSnackbar(
        result.clearLocationSyncFreeze.status === 'ALREADY_UNFROZEN'
          ? t('locationSync.snackbar.alreadyReleased')
          : t('locationSync.snackbar.released'),
      );
      setTarget(null);
      setReason('');
      if (listViewIsStillCurrent) {
        await fetchEntities();
      }
    } catch (mutationError) {
      console.error('[LocationSyncFreezesPanel] Failed to clear location-sync freeze:', mutationError);
      setSnackbar(t('locationSync.snackbar.failed'));
      setTarget(null);
      setReason('');
      // The common failure is a stale confirmation after another human edit.
      // Reloading also reconciles an already-cleared target after a network race.
      if (requestGenerationRef.current === mutationListGeneration) {
        await fetchEntities();
      }
    } finally {
      setSubmitting(false);
    }
  }, [fetchEntities, reason, t, target, token]);

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 3 }}>
        {t('locationSync.intro')}
      </Alert>

      <Tabs
        value={entityType}
        onChange={changeEntityType}
        aria-label={t('locationSync.tabs.label')}
        sx={{ borderBottom: 1, borderColor: themeTokens.neutral[200], mb: 2 }}
      >
        <Tab value="GYM" label={t('locationSync.tabs.gyms')} sx={{ textTransform: 'none' }} />
        <Tab value="BOARD" label={t('locationSync.tabs.boards')} sx={{ textTransform: 'none' }} />
      </Tabs>

      <Box component="form" onSubmit={submitSearch} sx={{ display: 'flex', gap: 1, mb: 2 }}>
        <TextField
          fullWidth
          size="small"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          label={t('locationSync.search.label')}
          placeholder={t('locationSync.search.placeholder')}
          inputProps={{ maxLength: 200 }}
        />
        <Button type="submit" variant="outlined" sx={{ textTransform: 'none', flexShrink: 0 }}>
          {t('locationSync.search.submit')}
        </Button>
      </Box>

      <Typography variant="body2" sx={{ color: themeTokens.neutral[600], mb: 1 }}>
        {t('locationSync.summary', { shown: entities.length, total: totalCount })}
      </Typography>

      {error !== null && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => fetchEntities(error.offset)}
              sx={{ textTransform: 'none' }}
            >
              {t('locationSync.retry')}
            </Button>
          }
        >
          {t('locationSync.error')}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('locationSync.table.listing')}</TableCell>
              <TableCell>{t('locationSync.table.state')}</TableCell>
              <TableCell>{t('locationSync.table.frozenAt')}</TableCell>
              <TableCell>{t('locationSync.table.sources')}</TableCell>
              <TableCell align="right">{t('locationSync.table.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {entities.map((entity) => {
              const destination =
                entity.entityType === 'GYM'
                  ? `/gym/${entity.slug ?? entity.entityUuid}`
                  : `/b/${entity.slug ?? entity.entityUuid}`;
              return (
                <TableRow key={`${entity.entityType}:${entity.entityUuid}`}>
                  <TableCell>
                    <Stack spacing={0.25}>
                      {entity.isDeleted ? (
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {entity.name}
                        </Typography>
                      ) : (
                        <MuiLink
                          component={LocaleLink}
                          href={destination}
                          underline="hover"
                          sx={{ color: themeTokens.colors.primary, fontWeight: 600 }}
                        >
                          {entity.name}
                        </MuiLink>
                      )}
                      <Typography variant="caption" sx={{ color: themeTokens.neutral[500], wordBreak: 'break-all' }}>
                        {entity.entityUuid}
                      </Typography>
                      {entity.boardType && (
                        <Typography variant="caption" sx={{ color: themeTokens.neutral[500] }}>
                          {entity.boardType}
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      <Chip
                        size="small"
                        label={entity.isDeleted ? t('locationSync.state.deleted') : t('locationSync.state.live')}
                        color={entity.isDeleted ? 'warning' : 'default'}
                        variant="outlined"
                      />
                      <Chip
                        size="small"
                        label={
                          entity.isSystemOwned ? t('locationSync.state.systemOwned') : t('locationSync.state.userOwned')
                        }
                        variant="outlined"
                      />
                      {entity.ownerProtected && (
                        <Chip
                          size="small"
                          color="warning"
                          label={t('locationSync.state.ownerProtected')}
                          variant="outlined"
                        />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>{dateFormatter.format(new Date(entity.syncFrozenAt))}</TableCell>
                  <TableCell sx={{ maxWidth: 240, wordBreak: 'break-word' }}>
                    {entity.sourceKeys.length > 0
                      ? entity.sourceKeys.join(', ')
                      : t('locationSync.table.noRecordedSources')}
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => openConfirmation(entity)}
                      sx={{ textTransform: 'none' }}
                    >
                      {t('locationSync.actions.release')}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {entities.length === 0 && !loading && error === null && (
              <TableRow>
                <TableCell colSpan={5} align="center">
                  <Typography variant="body2" sx={{ color: themeTokens.neutral[500], py: 3 }}>
                    {t('locationSync.empty')}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {loading && (
              <TableRow>
                <TableCell colSpan={5} align="center">
                  <CircularProgress size={22} sx={{ my: 3 }} />
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
            onClick={() => fetchEntities(entities.length)}
            disabled={loading}
            sx={{ textTransform: 'none' }}
          >
            {t('locationSync.loadMore')}
          </Button>
        </Box>
      )}

      <Dialog open={target !== null} onClose={closeConfirmation} fullWidth maxWidth="sm">
        <DialogTitle>{t('locationSync.confirm.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {t('locationSync.confirm.body', { name: target?.name ?? t('locationSync.notAvailable') })}
          </DialogContentText>
          {target?.isDeleted && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {t('locationSync.confirm.deletedWarning')}
            </Alert>
          )}
          {target?.ownerProtected && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {t('locationSync.confirm.ownerProtectedWarning')}
            </Alert>
          )}
          {target?.entityType === 'GYM' && target.sourceKeys.length === 0 && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {t('locationSync.confirm.noSourceWarning')}
            </Alert>
          )}
          {target?.entityType === 'BOARD' && target.boardType === 'moonboard' && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {t('locationSync.confirm.moonBoardWarning')}
            </Alert>
          )}
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            label={t('locationSync.confirm.reasonLabel')}
            placeholder={t('locationSync.confirm.reasonPlaceholder')}
            helperText={
              reason.trim().length < MIN_REASON_LENGTH
                ? t('locationSync.confirm.reasonRemaining', {
                    count: MIN_REASON_LENGTH - reason.trim().length,
                  })
                : t('locationSync.confirm.reasonStored')
            }
            inputProps={{ maxLength: 500 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeConfirmation} disabled={submitting} sx={{ textTransform: 'none' }}>
            {t('locationSync.confirm.cancel')}
          </Button>
          <Button
            onClick={clearFreeze}
            variant="contained"
            color="warning"
            disabled={submitting || reason.trim().length < MIN_REASON_LENGTH}
            sx={{ textTransform: 'none' }}
          >
            {submitting ? t('locationSync.confirm.releasing') : t('locationSync.confirm.release')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snackbar.length > 0} autoHideDuration={4000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}

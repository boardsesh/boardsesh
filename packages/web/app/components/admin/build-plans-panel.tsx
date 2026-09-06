'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { getBoardDisplayName } from '@boardsesh/climb-actions';
import {
  ADMIN_CNC_ORDERS,
  REGENERATE_CNC_PACK,
  type AdminCncOrdersQueryResponse,
  type AdminCncOrdersQueryVariables,
  type RegenerateCncPackMutationResponse,
  type RegenerateCncPackMutationVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import type { CncAdminOrder, CncCatalog, CncOrderStatus } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { createOrderDateFormatter } from '@/app/build-plans/format-date';
import { orderStatusChipColor, wallLabel } from '@/app/build-plans/order-display';

/**
 * The operator's view of every build-pack order.
 *
 * It exists for the one job the buyer's own order page cannot do: when a pack
 * fails, somebody has to see whose it was, what the generator actually said,
 * and whether the retry budget is spent — then requeue it. Everything else on
 * this screen is context for that decision.
 *
 * Status colour and wall label are imported from the buyer-facing
 * `app/build-plans/order-display.ts` rather than restated, so a status cannot
 * read green here and grey on the page the buyer is looking at while support is
 * on the phone with them.
 */

const PAGE_SIZE = 50;
const COLUMN_COUNT = 8;

/**
 * The statuses worth filtering to, in lifecycle order.
 *
 * `pending_payment` and `cancelled` are on the list because "did this checkout
 * ever complete" is a real support question, even though neither ever reaches
 * the generator.
 */
const STATUS_ORDER: CncOrderStatus[] = [
  'pending_payment',
  'queued',
  'generating',
  'ready',
  'failed',
  'cancelled',
  'refunded',
];

/** Only a generated or failed pack can be rebuilt; the resolver enforces the same rule. */
const REGENERATABLE: ReadonlySet<CncOrderStatus> = new Set<CncOrderStatus>(['ready', 'failed']);

type StatusFilter = CncOrderStatus | 'all';
type Translate = ReturnType<typeof useTranslation>['t'];

/**
 * Status wording comes from the buyer's own `cnc` catalogue rather than a
 * second admin copy: one phrase per status, wherever it is shown.
 */
function statusLabel(tCnc: Translate, status: CncOrderStatus): string {
  // i18n-keep cnc:status.pending_payment
  return tCnc(`status.${status}`);
}

export default function BuildPlansPanel({ catalog, locale }: { catalog: CncCatalog | null; locale: string }) {
  const { t } = useTranslation('admin');
  const { t: tCnc } = useTranslation('cnc');
  const { token } = useWsAuthToken();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [entries, setEntries] = useState<CncAdminOrder[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<CncAdminOrder | null>(null);
  const [pendingLicenceId, setPendingLicenceId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState('');

  const dateFormat = useMemo(
    () => createOrderDateFormatter(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  const fetchOrders = useCallback(
    async (nextCursor: string | null) => {
      if (!token) return;
      setLoading(true);
      setFailed(false);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<AdminCncOrdersQueryResponse, AdminCncOrdersQueryVariables>(
          ADMIN_CNC_ORDERS,
          { status: statusFilter === 'all' ? null : statusFilter, limit: PAGE_SIZE, cursor: nextCursor },
        );
        const page = result.adminCncOrders;
        // A cursor means "append". The first page of a new filter passes null,
        // so there is no separate reset flag to get wrong.
        setEntries((previous) => (nextCursor ? [...previous, ...page.orders] : page.orders));
        setCursor(page.cursor);
        setHasMore(page.hasMore);
      } catch (error) {
        console.error('[BuildPlansPanel] Failed to fetch orders:', error);
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [token, statusFilter],
  );

  useEffect(() => {
    void fetchOrders(null);
  }, [fetchOrders]);

  const regenerate = useCallback(
    async (entry: CncAdminOrder) => {
      if (!token) return;
      setPendingLicenceId(entry.order.licenceId);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<RegenerateCncPackMutationResponse, RegenerateCncPackMutationVariables>(
          REGENERATE_CNC_PACK,
          { licenceId: entry.order.licenceId },
        );
        const requeued = result.regenerateCncPack;
        // Patch the one row rather than refetching the page. The sort is by
        // creation so nothing would move, but a refetch would throw away the
        // operator's scroll position in the middle of triage — and the
        // resolver has already told us the row's new state.
        setEntries((previous) =>
          previous.map((candidate) =>
            candidate.order.licenceId === requeued.licenceId
              ? // A requeue resets the attempt budget and clears the error, and
                // the admin fields are not on the mutation's payload, so they
                // are mirrored here from what the transition is defined to do.
                { ...candidate, order: requeued, attempts: 0, lastError: null }
              : candidate,
          ),
        );
        setSnackbar(t('buildPlans.snackbar.regenerated'));
      } catch (error) {
        console.error('[BuildPlansPanel] Regenerate failed:', error);
        setSnackbar(t('buildPlans.snackbar.regenerateFailed'));
      } finally {
        setPendingLicenceId(null);
        setConfirming(null);
      }
    },
    [token, t],
  );

  const filters: StatusFilter[] = ['all', ...STATUS_ORDER];

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
        {filters.map((option) => (
          <Chip
            key={option}
            label={option === 'all' ? t('buildPlans.statusFilter.all') : statusLabel(tCnc, option)}
            size="small"
            variant={statusFilter === option ? 'filled' : 'outlined'}
            color={statusFilter === option ? 'primary' : 'default'}
            onClick={() => setStatusFilter(option)}
            sx={{ cursor: 'pointer' }}
          />
        ))}
      </Box>

      {failed && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => fetchOrders(null)} sx={{ textTransform: 'none' }}>
              {t('buildPlans.retry')}
            </Button>
          }
        >
          {t('buildPlans.error')}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('buildPlans.table.licence')}</TableCell>
              <TableCell>{t('buildPlans.table.licensee')}</TableCell>
              <TableCell>{t('buildPlans.table.tier')}</TableCell>
              <TableCell>{t('buildPlans.table.wall')}</TableCell>
              <TableCell>{t('buildPlans.table.status')}</TableCell>
              <TableCell align="right">{t('buildPlans.table.attempts')}</TableCell>
              <TableCell>{t('buildPlans.table.created')}</TableCell>
              <TableCell>{t('buildPlans.table.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {entries.map((entry) => (
              <React.Fragment key={entry.order.licenceId}>
                <TableRow hover>
                  <TableCell>
                    <MuiLink
                      component={LocaleLink}
                      href={`/build-plans/orders/${entry.order.licenceId}`}
                      underline="hover"
                      sx={{ color: 'var(--color-primary)', fontFamily: 'monospace' }}
                    >
                      {entry.order.licenceId}
                    </MuiLink>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{entry.order.licenseeName ?? t('buildPlans.unknown')}</Typography>
                    <Typography variant="caption" sx={{ color: 'var(--neutral-500)', wordBreak: 'break-all' }}>
                      {entry.licenseeEmail ?? t('buildPlans.unknown')}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {entry.order.tier === 'personal'
                      ? tCnc('tiers.personal.name')
                      : /* i18n-keep cnc:tiers.commercial.name */ tCnc('tiers.commercial.name')}
                  </TableCell>
                  <TableCell>
                    {`${getBoardDisplayName(entry.order.boardName)} ${wallLabel(catalog, entry.order)}`}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={orderStatusChipColor(entry.order.status)}
                      label={statusLabel(tCnc, entry.order.status)}
                    />
                  </TableCell>
                  <TableCell align="right">{entry.attempts}</TableCell>
                  <TableCell>{dateFormat.format(new Date(entry.order.createdAt))}</TableCell>
                  <TableCell>
                    {REGENERATABLE.has(entry.order.status) && (
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={pendingLicenceId === entry.order.licenceId}
                        onClick={() => setConfirming(entry)}
                        sx={{ textTransform: 'none' }}
                      >
                        {t('buildPlans.actions.regenerate')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>

                {/*
                  The generator's real error gets its own full-width row under
                  the order it belongs to. These messages carry module names and
                  config keys and run to a couple of hundred characters; folded
                  into an eight-column row they either truncate the only useful
                  part or wreck the table.
                */}
                {entry.lastError && (
                  <TableRow>
                    <TableCell colSpan={COLUMN_COUNT} sx={{ borderTop: 0, pt: 0 }}>
                      <Typography
                        variant="caption"
                        component="pre"
                        sx={{ m: 0, color: 'var(--color-error)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                      >
                        {entry.lastError}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))}

            {entries.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT}>
                  <Typography variant="body2" sx={{ color: 'var(--neutral-500)', py: 2 }}>
                    {t('buildPlans.empty')}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2, mt: 2 }}>
        {loading && <CircularProgress size={20} />}
        {hasMore && !loading && (
          <Button onClick={() => fetchOrders(cursor)} sx={{ textTransform: 'none' }}>
            {t('buildPlans.loadMore')}
          </Button>
        )}
      </Box>

      {/*
        Regenerating overwrites the zip the buyer may already have downloaded,
        under the same licence id — recoverable, but not something to trigger by
        misclicking a row, so it is confirmed by licence id first.
      */}
      <Dialog open={confirming !== null} onClose={() => setConfirming(null)}>
        <DialogTitle>{t('buildPlans.confirm.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('buildPlans.confirm.body', { licenceId: confirming?.order.licenceId ?? '' })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(null)} sx={{ textTransform: 'none' }}>
            {t('buildPlans.confirm.cancel')}
          </Button>
          <Button
            variant="contained"
            disabled={pendingLicenceId !== null}
            onClick={() => confirming && regenerate(confirming)}
            sx={{ textTransform: 'none' }}
          >
            {t('buildPlans.confirm.confirm')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar !== ''}
        autoHideDuration={4000}
        onClose={() => setSnackbar('')}
        message={snackbar}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

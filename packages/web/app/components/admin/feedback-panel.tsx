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
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import MuiLink from '@mui/material/Link';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  ADMIN_APP_FEEDBACK,
  UPDATE_APP_FEEDBACK_STATUS,
  type AdminAppFeedbackQueryResponse,
  type AdminAppFeedbackQueryVariables,
  type UpdateAppFeedbackStatusMutationResponse,
  type UpdateAppFeedbackStatusMutationVariables,
} from '@boardsesh/graphql/operations';
import type {
  AppFeedbackReport,
  AppFeedbackStatus,
  AppFeedbackStatusCounts,
  AppFeedbackTypeFilter,
} from '@boardsesh/shared-schema';

const PAGE_SIZE = 50;
const COLUMN_COUNT = 8;
const STATUS_ORDER: AppFeedbackStatus[] = ['new', 'in_progress', 'resolved', 'wont_fix'];
const TYPE_ORDER: AppFeedbackTypeFilter[] = ['bugs', 'ratings', 'all'];
const EMPTY_COUNTS: AppFeedbackStatusCounts = { new: 0, inProgress: 0, resolved: 0, wontFix: 0 };
const BUG_SOURCES = new Set(['shake-bug', 'drawer-bug']);

type StatusFilter = AppFeedbackStatus | 'all';
type Translate = ReturnType<typeof useTranslation>['t'];

function statusCountKey(status: AppFeedbackStatus): keyof AppFeedbackStatusCounts {
  switch (status) {
    case 'new':
      return 'new';
    case 'in_progress':
      return 'inProgress';
    case 'resolved':
      return 'resolved';
    case 'wont_fix':
      return 'wontFix';
  }
}

// Literal t() lookups only — the i18n linter rejects dynamic keys.
function statusLabel(t: Translate, status: AppFeedbackStatus): string {
  switch (status) {
    case 'new':
      return t('feedback.status.new');
    case 'in_progress':
      return t('feedback.status.in_progress');
    case 'resolved':
      return t('feedback.status.resolved');
    case 'wont_fix':
      return t('feedback.status.wont_fix');
  }
}

function typeTabLabel(t: Translate, type: AppFeedbackTypeFilter): string {
  switch (type) {
    case 'bugs':
      return t('feedback.type.bugs');
    case 'ratings':
      return t('feedback.type.ratings');
    case 'all':
      return t('feedback.type.all');
  }
}

function statusChipColor(status: AppFeedbackStatus): 'info' | 'warning' | 'success' | 'default' {
  switch (status) {
    case 'new':
      return 'info';
    case 'in_progress':
      return 'warning';
    case 'resolved':
      return 'success';
    case 'wont_fix':
      return 'default';
  }
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
      <Typography variant="caption" sx={{ fontWeight: 600, color: 'var(--neutral-500)', minWidth: 90 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ color: 'var(--neutral-700)', wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Box>
  );
}

export default function FeedbackPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();

  const [type, setType] = useState<AppFeedbackTypeFilter>('bugs');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [reports, setReports] = useState<AppFeedbackReport[]>([]);
  const [counts, setCounts] = useState<AppFeedbackStatusCounts>(EMPTY_COUNTS);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorOffset, setErrorOffset] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState('');

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const fetchReports = useCallback(
    async (offset = 0) => {
      if (!token) return;
      setLoading(true);
      setErrorOffset(null);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<AdminAppFeedbackQueryResponse, AdminAppFeedbackQueryVariables>(
          ADMIN_APP_FEEDBACK,
          {
            input: {
              type,
              status: statusFilter === 'all' ? null : statusFilter,
              search: debouncedSearch || null,
              limit: PAGE_SIZE,
              offset,
            },
          },
        );
        const data = result.adminAppFeedback;
        setReports((prev) => (offset === 0 ? data.reports : [...prev, ...data.reports]));
        setHasMore(data.hasMore);
        setTotalCount(data.totalCount);
        setCounts(data.statusCounts);
      } catch (err) {
        console.error('[FeedbackPanel] Failed to fetch feedback:', err);
        setErrorOffset(offset);
      } finally {
        setLoading(false);
      }
    },
    [token, type, statusFilter, debouncedSearch],
  );

  useEffect(() => {
    void fetchReports(0);
  }, [fetchReports]);

  const changeStatus = useCallback(
    async (report: AppFeedbackReport, next: AppFeedbackStatus) => {
      if (!token || report.status === next) return;
      setPendingId(report.id);
      const prevStatus = report.status;
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<
          UpdateAppFeedbackStatusMutationResponse,
          UpdateAppFeedbackStatusMutationVariables
        >(UPDATE_APP_FEEDBACK_STATUS, { input: { id: report.id, status: next } });
        const updated = result.updateAppFeedbackStatus;

        // If a specific status filter is active and the row no longer matches,
        // drop it from the visible page (and the total); otherwise patch it.
        const dropsOut = statusFilter !== 'all' && updated.status !== statusFilter;
        setReports((prev) =>
          dropsOut ? prev.filter((r) => r.id !== updated.id) : prev.map((r) => (r.id === updated.id ? updated : r)),
        );
        if (dropsOut) setTotalCount((current) => Math.max(0, current - 1));

        // Move the row between count buckets (type/platform/search unchanged).
        if (prevStatus !== updated.status) {
          setCounts((prev) => ({
            ...prev,
            [statusCountKey(prevStatus)]: Math.max(0, prev[statusCountKey(prevStatus)] - 1),
            [statusCountKey(updated.status)]: prev[statusCountKey(updated.status)] + 1,
          }));
        }
        setSnackbar(t('feedback.snackbar.statusUpdated'));
      } catch {
        setSnackbar(t('feedback.snackbar.updateFailed'));
      } finally {
        setPendingId(null);
      }
    },
    [token, statusFilter, t],
  );

  const copyEmail = useCallback(
    async (email: string) => {
      try {
        await navigator.clipboard.writeText(email);
        setSnackbar(t('feedback.snackbar.emailCopied'));
      } catch {
        setSnackbar(t('feedback.snackbar.copyFailed'));
      }
    },
    [t],
  );

  const statusFilters: StatusFilter[] = ['all', ...STATUS_ORDER];
  // The 'All' chip counts every status (counts are independent of the active
  // status filter), not `totalCount` — which is narrowed to the current filter.
  const allCount = counts.new + counts.inProgress + counts.resolved + counts.wontFix;

  return (
    <Box>
      {/* Type tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'var(--neutral-200)', mb: 2 }}>
        <Tabs
          value={TYPE_ORDER.indexOf(type)}
          onChange={(_, value: number) => setType(TYPE_ORDER[value])}
          variant="scrollable"
          scrollButtons="auto"
        >
          {TYPE_ORDER.map((option) => (
            <Tab key={option} label={typeTabLabel(t, option)} sx={{ textTransform: 'none' }} />
          ))}
        </Tabs>
      </Box>

      {/* Status filter + search */}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
        {statusFilters.map((option) => {
          const label =
            option === 'all'
              ? `${t('feedback.statusFilter.all')} (${allCount})`
              : `${statusLabel(t, option)} (${counts[statusCountKey(option)]})`;
          const active = statusFilter === option;
          return (
            <Chip
              key={option}
              label={label}
              size="small"
              variant={active ? 'filled' : 'outlined'}
              color={active ? 'primary' : 'default'}
              onClick={() => setStatusFilter(option)}
              sx={{ cursor: 'pointer' }}
            />
          );
        })}
        <Box sx={{ flexGrow: 1 }} />
        <TextField
          size="small"
          placeholder={t('feedback.search.placeholder')}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          sx={{ minWidth: 220 }}
        />
      </Box>

      {errorOffset !== null && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => fetchReports(errorOffset)}
              sx={{ textTransform: 'none' }}
            >
              {t('feedback.retry')}
            </Button>
          }
        >
          {t('feedback.error')}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('feedback.table.date')}</TableCell>
              <TableCell>{t('feedback.table.type')}</TableCell>
              <TableCell>{t('feedback.table.platform')}</TableCell>
              <TableCell>{t('feedback.table.comment')}</TableCell>
              <TableCell>{t('feedback.table.reporter')}</TableCell>
              <TableCell>{t('feedback.table.status')}</TableCell>
              <TableCell>{t('feedback.table.github')}</TableCell>
              <TableCell align="right">{t('feedback.table.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {reports.map((report) => {
              const isBug = BUG_SOURCES.has(report.source);
              const expanded = expandedId === report.id;
              return (
                <React.Fragment key={report.id}>
                  <TableRow hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {new Date(report.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={isBug ? t('feedback.type.bug') : t('feedback.type.rating')}
                        size="small"
                        color={isBug ? 'error' : 'default'}
                        variant="outlined"
                        sx={{ fontSize: 11 }}
                      />
                      {!isBug && report.rating != null && (
                        <Typography variant="caption" sx={{ display: 'block', color: 'var(--neutral-600)', mt: 0.5 }}>
                          {t('feedback.rating.value', { rating: report.rating })}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{report.platform}</Typography>
                      {report.appVersion && (
                        <Typography variant="caption" sx={{ color: 'var(--neutral-500)' }}>
                          {report.appVersion}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 280 }}>
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
                        <Typography
                          variant="body2"
                          sx={{
                            color: 'var(--neutral-700)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            display: '-webkit-box',
                            WebkitLineClamp: expanded ? 'unset' : 2,
                            WebkitBoxOrient: 'vertical',
                          }}
                        >
                          {report.comment || '—'}
                        </Typography>
                        <IconButton
                          size="small"
                          onClick={() => setExpandedId(expanded ? null : report.id)}
                          aria-label={t('feedback.detail.toggle')}
                        >
                          {expanded ? (
                            <KeyboardArrowUpIcon fontSize="small" />
                          ) : (
                            <KeyboardArrowDownIcon fontSize="small" />
                          )}
                        </IconButton>
                      </Box>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 200 }}>
                      {report.reporter?.email ? (
                        <Box>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                              {report.reporter.email}
                            </Typography>
                            <Tooltip title={t('feedback.reporter.copyEmail')}>
                              <IconButton size="small" onClick={() => copyEmail(report.reporter?.email ?? '')}>
                                <ContentCopyIcon sx={{ fontSize: 14 }} />
                              </IconButton>
                            </Tooltip>
                          </Box>
                          <Chip
                            label={
                              report.contactConsent
                                ? t('feedback.reporter.consentYes')
                                : t('feedback.reporter.consentNo')
                            }
                            size="small"
                            color={report.contactConsent ? 'success' : 'default'}
                            variant="outlined"
                            sx={{ fontSize: 10, height: 18 }}
                          />
                        </Box>
                      ) : (
                        <Typography variant="body2" sx={{ color: 'var(--neutral-400)' }}>
                          {t('feedback.reporter.anonymous')}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={statusLabel(t, report.status)}
                        size="small"
                        color={statusChipColor(report.status)}
                        sx={{ fontSize: 11 }}
                      />
                    </TableCell>
                    <TableCell>
                      {report.githubIssueUrl && report.githubIssueNumber != null ? (
                        <MuiLink
                          href={report.githubIssueUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          underline="hover"
                          sx={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 0.25,
                            color: 'var(--color-primary)',
                          }}
                        >
                          {t('feedback.github.view', { number: report.githubIssueNumber })}
                          <OpenInNewIcon sx={{ fontSize: 13 }} />
                        </MuiLink>
                      ) : (
                        <Typography variant="caption" sx={{ color: 'var(--neutral-400)' }}>
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center">
                        <Select
                          size="small"
                          value={report.status}
                          onChange={(event) => changeStatus(report, event.target.value as AppFeedbackStatus)}
                          disabled={pendingId === report.id}
                          sx={{ minWidth: 132, fontSize: 13 }}
                        >
                          {STATUS_ORDER.map((option) => (
                            <MenuItem key={option} value={option} sx={{ fontSize: 13 }}>
                              {statusLabel(t, option)}
                            </MenuItem>
                          ))}
                        </Select>
                        {report.status !== 'resolved' && (
                          <Button
                            size="small"
                            variant="contained"
                            disabled={pendingId === report.id}
                            onClick={() => changeStatus(report, 'resolved')}
                            sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
                          >
                            {t('feedback.actions.markDone')}
                          </Button>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={COLUMN_COUNT} sx={{ py: 0, borderBottom: expanded ? undefined : 'none' }}>
                      <Collapse in={expanded} timeout="auto" unmountOnExit>
                        <Box sx={{ py: 2, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                          <DetailRow label={t('feedback.detail.comment')} value={report.comment} />
                          <DetailRow
                            label={t('feedback.detail.board')}
                            value={
                              report.boardName
                                ? report.angle != null
                                  ? `${report.boardName} @ ${report.angle}°`
                                  : report.boardName
                                : null
                            }
                          />
                          <DetailRow
                            label={t('feedback.detail.climb')}
                            value={
                              report.context?.climbName
                                ? report.context.difficulty
                                  ? `${report.context.climbName} (${report.context.difficulty})`
                                  : report.context.climbName
                                : report.context?.climbUuid
                            }
                          />
                          <DetailRow label={t('feedback.detail.session')} value={report.context?.sessionName} />
                          <DetailRow label={t('feedback.detail.url')} value={report.context?.url} />
                          <DetailRow label={t('feedback.detail.userAgent')} value={report.context?.userAgent} />
                          {report.screenshotUrls.length > 0 && (
                            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                              <Typography
                                variant="caption"
                                sx={{ fontWeight: 600, color: 'var(--neutral-500)', minWidth: 90 }}
                              >
                                {t('feedback.detail.screenshots')}
                              </Typography>
                              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                                {report.screenshotUrls.map((url, index) => (
                                  <MuiLink
                                    key={url}
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={t('feedback.detail.screenshotAlt', { index: index + 1 })}
                                  >
                                    <Box
                                      component="img"
                                      src={url}
                                      alt={t('feedback.detail.screenshotAlt', { index: index + 1 })}
                                      sx={{
                                        width: 72,
                                        height: 72,
                                        objectFit: 'cover',
                                        borderRadius: 'var(--border-radius-sm)',
                                        border: '1px solid var(--neutral-200)',
                                        display: 'block',
                                      }}
                                    />
                                  </MuiLink>
                                ))}
                              </Box>
                            </Box>
                          )}
                          {report.resolvedBy && (
                            <DetailRow label={t('feedback.detail.resolvedBy')} value={report.resolvedBy} />
                          )}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              );
            })}

            {reports.length === 0 && !loading && errorOffset === null && (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} align="center">
                  <Typography variant="body2" sx={{ color: 'var(--neutral-400)', py: 2 }}>
                    {t('feedback.empty')}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {loading && (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} align="center">
                  <CircularProgress size={20} sx={{ my: 2 }} />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
        <Typography variant="caption" sx={{ color: 'var(--neutral-500)' }}>
          {t('feedback.showing', { shown: reports.length, total: totalCount })}
        </Typography>
        {hasMore && (
          <Button
            variant="outlined"
            onClick={() => fetchReports(reports.length)}
            disabled={loading}
            sx={{ textTransform: 'none' }}
          >
            {t('feedback.loadMore')}
          </Button>
        )}
      </Box>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}

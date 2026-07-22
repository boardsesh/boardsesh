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
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs from 'dayjs';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  COST_ENTRIES,
  CREATE_COST_ENTRY,
  UPDATE_COST_ENTRY,
  DELETE_COST_ENTRY,
  type CostEntriesQueryResponse,
  type CreateCostEntryMutationResponse,
  type CreateCostEntryMutationVariables,
  type UpdateCostEntryMutationResponse,
  type UpdateCostEntryMutationVariables,
  type DeleteCostEntryMutationResponse,
  type DeleteCostEntryMutationVariables,
} from '@boardsesh/graphql/operations';
import type { CostEntry, CostEntryKind, CostCategory, CreateCostEntryInput } from '@boardsesh/shared-schema';

const MONTH_FORMAT = 'YYYY-MM';
const KIND_OPTIONS: CostEntryKind[] = ['recurring', 'incidental'];
const CATEGORY_OPTIONS: CostCategory[] = ['hosting', 'ai', 'domain', 'other'];
// USD only: every Boardsesh bill is billed in USD, and the public rollup sums a
// single currency. Offering other currencies here would let a mixed-currency
// entry silently corrupt the "$X/month" transparency figure. Widen this (and the
// rollup) together if we ever take on a non-USD bill.
const CURRENCY_OPTIONS = ['USD'];
const DEFAULT_CURRENCY = 'USD';
const MAX_AMOUNT_DOLLARS = 1_000_000;
const COLUMN_COUNT = 7;

type Translate = ReturnType<typeof useTranslation>['t'];
type SnackState = { text: string; severity: 'success' | 'error' };

// Literal t() lookups only — the i18n linter rejects dynamic keys. Falls back to
// the raw value so an unexpected server-side kind/category still renders.
function kindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'recurring':
      return t('costs.kind.recurring');
    case 'incidental':
      return t('costs.kind.incidental');
    default:
      return kind;
  }
}

function categoryLabel(t: Translate, category: string): string {
  switch (category) {
    case 'hosting':
      return t('costs.category.hosting');
    case 'ai':
      return t('costs.category.ai');
    case 'domain':
      return t('costs.category.domain');
    case 'other':
      return t('costs.category.other');
    default:
      return category;
  }
}

// amountCents is integer cents; render in the entry's own currency's major unit.
function formatAmount(amountCents: number, currency: string): string {
  const amount = amountCents / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// Recurring entries with no end date run forever ("ongoing"); one-offs have no
// end at all ("—").
function endLabel(t: Translate, entry: CostEntry): string {
  if (entry.endMonth) return entry.endMonth;
  if (entry.kind === 'recurring') return t('costs.table.ongoing');
  return t('costs.table.none');
}

// Match the server ordering (newest start month first) so optimistic create/edit
// updates don't drift the row position until the next refetch.
function sortEntries(list: CostEntry[]): CostEntry[] {
  return [...list].sort((a, b) => b.startMonth.localeCompare(a.startMonth) || Number(b.id) - Number(a.id));
}

export default function CostsPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();

  const [entries, setEntries] = useState<CostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [snack, setSnack] = useState<SnackState | null>(null);

  // Add/edit form state — editingId null means "creating".
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<CostEntryKind>('recurring');
  const [category, setCategory] = useState<CostCategory>('hosting');
  const [amountDollars, setAmountDollars] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete confirmation state.
  const [deleteTarget, setDeleteTarget] = useState<CostEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchEntries = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setLoadError(false);
    try {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<CostEntriesQueryResponse>(COST_ENTRIES);
      setEntries(result.costEntries);
    } catch (err) {
      console.error('[CostsPanel] Failed to fetch cost entries:', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setLabel('');
    setKind('recurring');
    setCategory('hosting');
    setAmountDollars('');
    setCurrency(DEFAULT_CURRENCY);
    setStartMonth(dayjs().format(MONTH_FORMAT));
    setEndMonth('');
    setNote('');
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((entry: CostEntry) => {
    setEditingId(entry.id);
    setLabel(entry.label);
    setKind(entry.kind === 'incidental' ? 'incidental' : 'recurring');
    setCategory(CATEGORY_OPTIONS.includes(entry.category as CostCategory) ? (entry.category as CostCategory) : 'other');
    setAmountDollars((entry.amountCents / 100).toString());
    setCurrency(entry.currency || DEFAULT_CURRENCY);
    setStartMonth(entry.startMonth ?? '');
    setEndMonth(entry.endMonth ?? '');
    setNote(entry.note ?? '');
    setFormOpen(true);
  }, []);

  // Switching to a one-off clears the end month — incidentals must not carry one.
  const handleKindChange = useCallback((next: CostEntryKind) => {
    setKind(next);
    if (next === 'incidental') setEndMonth('');
  }, []);

  const parsedAmount = Number(amountDollars);
  const amountValid =
    amountDollars.trim() !== '' &&
    Number.isFinite(parsedAmount) &&
    parsedAmount >= 0 &&
    parsedAmount <= MAX_AMOUNT_DOLLARS;
  const canSubmit = label.trim() !== '' && amountValid && startMonth !== '' && !saving;

  const handleSubmit = useCallback(async () => {
    if (!token || !canSubmit) return;
    setSaving(true);
    const input: CreateCostEntryInput = {
      kind,
      category,
      label: label.trim(),
      amountCents: Math.round(parsedAmount * 100),
      currency,
      startMonth,
      endMonth: kind === 'recurring' ? endMonth || null : null,
      note: note.trim() ? note.trim() : null,
    };
    try {
      const client = createGraphQLHttpClient(token);
      if (editingId) {
        const result = await client.request<UpdateCostEntryMutationResponse, UpdateCostEntryMutationVariables>(
          UPDATE_COST_ENTRY,
          { input: { ...input, id: editingId } },
        );
        const updated = result.updateCostEntry;
        setEntries((prev) => sortEntries(prev.map((entry) => (entry.id === updated.id ? updated : entry))));
        setSnack({ text: t('costs.snackbar.updated'), severity: 'success' });
      } else {
        const result = await client.request<CreateCostEntryMutationResponse, CreateCostEntryMutationVariables>(
          CREATE_COST_ENTRY,
          { input },
        );
        setEntries((prev) => sortEntries([...prev, result.createCostEntry]));
        setSnack({ text: t('costs.snackbar.created'), severity: 'success' });
      }
      setFormOpen(false);
    } catch (err) {
      console.error('[CostsPanel] Failed to save cost entry:', err);
      setSnack({ text: t('costs.snackbar.saveFailed'), severity: 'error' });
    } finally {
      setSaving(false);
    }
  }, [token, canSubmit, kind, category, label, parsedAmount, currency, startMonth, endMonth, note, editingId, t]);

  const handleDelete = useCallback(async () => {
    if (!token || !deleteTarget) return;
    setDeleting(true);
    try {
      const client = createGraphQLHttpClient(token);
      await client.request<DeleteCostEntryMutationResponse, DeleteCostEntryMutationVariables>(DELETE_COST_ENTRY, {
        input: { id: deleteTarget.id },
      });
      setEntries((prev) => prev.filter((entry) => entry.id !== deleteTarget.id));
      setSnack({ text: t('costs.snackbar.deleted'), severity: 'success' });
      setDeleteTarget(null);
    } catch (err) {
      console.error('[CostsPanel] Failed to delete cost entry:', err);
      setSnack({ text: t('costs.snackbar.deleteFailed'), severity: 'error' });
    } finally {
      setDeleting(false);
    }
  }, [token, deleteTarget, t]);

  const isRecurring = kind === 'recurring';

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openCreate}
          sx={{
            textTransform: 'none',
            bgcolor: 'var(--color-primary-fill)',
            '&:hover': { bgcolor: 'var(--color-primary-fill-hover)' },
          }}
        >
          {t('costs.newEntry')}
        </Button>
      </Box>

      {loadError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => void fetchEntries()} sx={{ textTransform: 'none' }}>
              {t('costs.retry')}
            </Button>
          }
        >
          {t('costs.error')}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('costs.table.kind')}</TableCell>
              <TableCell>{t('costs.table.category')}</TableCell>
              <TableCell>{t('costs.table.label')}</TableCell>
              <TableCell align="right">{t('costs.table.amount')}</TableCell>
              <TableCell>{t('costs.table.start')}</TableCell>
              <TableCell>{t('costs.table.end')}</TableCell>
              <TableCell align="right">{t('costs.table.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id} hover>
                <TableCell>
                  <Chip label={kindLabel(t, entry.kind)} size="small" variant="outlined" sx={{ fontSize: 11 }} />
                </TableCell>
                <TableCell>{categoryLabel(t, entry.category)}</TableCell>
                <TableCell sx={{ color: themeTokens.neutral[800] }}>{entry.label}</TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {formatAmount(entry.amountCents, entry.currency)}
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{entry.startMonth}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap', color: themeTokens.neutral[500] }}>
                  {endLabel(t, entry)}
                </TableCell>
                <TableCell align="right">
                  <Tooltip title={t('costs.actions.edit')}>
                    <IconButton size="small" onClick={() => openEdit(entry)} aria-label={t('costs.actions.edit')}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t('costs.actions.delete')}>
                    <IconButton
                      size="small"
                      onClick={() => setDeleteTarget(entry)}
                      aria-label={t('costs.actions.delete')}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}

            {entries.length === 0 && !loading && !loadError && (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} align="center">
                  <Typography variant="body2" sx={{ color: themeTokens.neutral[400], py: 2 }}>
                    {t('costs.empty')}
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

      {/* Add / edit dialog */}
      <Dialog open={formOpen} onClose={() => setFormOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? t('costs.dialog.editTitle') : t('costs.dialog.addTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label={t('costs.dialog.label')}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              size="small"
              fullWidth
            />
            <FormControl size="small" fullWidth>
              <InputLabel>{t('costs.dialog.kind')}</InputLabel>
              <Select
                value={kind}
                label={t('costs.dialog.kind')}
                onChange={(event) => handleKindChange(event.target.value as CostEntryKind)}
              >
                {KIND_OPTIONS.map((option) => (
                  <MenuItem key={option} value={option}>
                    {kindLabel(t, option)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>{t('costs.dialog.category')}</InputLabel>
              <Select
                value={category}
                label={t('costs.dialog.category')}
                onChange={(event) => setCategory(event.target.value as CostCategory)}
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <MenuItem key={option} value={option}>
                    {categoryLabel(t, option)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField
                label={t('costs.dialog.amount')}
                type="number"
                value={amountDollars}
                onChange={(event) => setAmountDollars(event.target.value)}
                size="small"
                fullWidth
                slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
              />
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <InputLabel>{t('costs.dialog.currency')}</InputLabel>
                <Select
                  value={currency}
                  label={t('costs.dialog.currency')}
                  onChange={(event) => setCurrency(event.target.value)}
                >
                  {CURRENCY_OPTIONS.map((option) => (
                    <MenuItem key={option} value={option}>
                      {option}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
            <DatePicker
              label={t('costs.dialog.startMonth')}
              views={['year', 'month']}
              openTo="month"
              format={MONTH_FORMAT}
              value={startMonth ? dayjs(startMonth) : null}
              onChange={(value) => setStartMonth(value ? value.format(MONTH_FORMAT) : '')}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            {isRecurring && (
              <DatePicker
                label={t('costs.dialog.endMonth')}
                views={['year', 'month']}
                openTo="month"
                format={MONTH_FORMAT}
                minDate={startMonth ? dayjs(startMonth) : undefined}
                value={endMonth ? dayjs(endMonth) : null}
                onChange={(value) => setEndMonth(value ? value.format(MONTH_FORMAT) : '')}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
              />
            )}
            <TextField
              label={t('costs.dialog.note')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              size="small"
              fullWidth
              multiline
              minRows={2}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFormOpen(false)} sx={{ textTransform: 'none' }}>
            {t('costs.dialog.cancel')}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            variant="contained"
            disabled={!canSubmit}
            sx={{
              textTransform: 'none',
              bgcolor: 'var(--color-primary-fill)',
              '&:hover': { bgcolor: 'var(--color-primary-fill-hover)' },
            }}
          >
            {t('costs.dialog.save')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('costs.delete.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: themeTokens.neutral[700] }}>
            {t('costs.delete.body', { label: deleteTarget?.label ?? '' })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} sx={{ textTransform: 'none' }}>
            {t('costs.delete.cancel')}
          </Button>
          <Button
            onClick={() => void handleDelete()}
            variant="contained"
            color="error"
            disabled={deleting}
            sx={{ textTransform: 'none' }}
          >
            {t('costs.delete.confirm')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snack !== null}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={snack?.severity ?? 'success'}
          variant="filled"
          onClose={() => setSnack(null)}
          sx={{ width: '100%' }}
        >
          {snack?.text ?? ''}
        </Alert>
      </Snackbar>
    </Box>
  );
}

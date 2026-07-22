'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MuiButton from '@mui/material/Button';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutline';
import type { SimilarGym } from '@boardsesh/shared-schema';
import {
  FIND_SIMILAR_GYMS,
  REPORT_GYM_DUPLICATE,
  type FindSimilarGymsQueryResponse,
  type FindSimilarGymsQueryVariables,
  type ReportGymDuplicateMutationResponse,
  type ReportGymDuplicateMutationVariables,
} from '@boardsesh/graphql/operations';
import { GYM_CLAIM_MESSAGE_MAX_LENGTH } from '@boardsesh/gym-claim';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useDebouncedValue } from '@/app/hooks/use-debounced-value';
import { themeTokens } from '@/app/theme/theme-config';

type ReportDuplicateDialogProps = {
  gymUuid: string;
  gymName: string;
  latitude?: number | null;
  longitude?: number | null;
  open: boolean;
  onClose: () => void;
};

const MIN_NAME_LENGTH = 2;

function graphqlErrorMessage(error: unknown): string | null {
  const response = (error as { response?: { errors?: Array<{ message?: string }> } })?.response;
  return response?.errors?.[0]?.message ?? null;
}

export default function ReportDuplicateDialog({
  gymUuid,
  gymName,
  latitude,
  longitude,
  open,
  onClose,
}: ReportDuplicateDialogProps) {
  const { t } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const [search, setSearch] = useState(gymName);
  const [selected, setSelected] = useState<SimilarGym | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'reported' | 'already_reported' | null>(null);

  // A single dialog instance is reused across gyms, so re-seed the search with the
  // current gym's name (its likely duplicates share it) every time it opens.
  useEffect(() => {
    if (open) {
      setSearch(gymName);
      setSelected(null);
      setNote('');
      setError(null);
      setOutcome(null);
      setSubmitting(false);
    }
  }, [open, gymName]);

  const debounced = useDebouncedValue(
    useMemo(() => ({ name: search.trim(), latitude, longitude }), [search, latitude, longitude]),
    400,
  );

  const enabled = open && Boolean(token) && debounced.name.length >= MIN_NAME_LENGTH;

  const { data, isFetching } = useQuery<SimilarGym[]>({
    queryKey: ['reportDuplicateSuggestions', debounced.name, debounced.latitude, debounced.longitude],
    enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<FindSimilarGymsQueryResponse, FindSimilarGymsQueryVariables>(
        FIND_SIMILAR_GYMS,
        {
          input: {
            name: debounced.name,
            latitude: debounced.latitude ?? undefined,
            longitude: debounced.longitude ?? undefined,
          },
        },
      );
      return response.findSimilarGyms;
    },
  });

  // Never offer the gym itself as its own duplicate.
  const candidates = (data ?? []).filter((candidate) => candidate.uuid !== gymUuid);

  const formatDistance = (distanceMeters: number | null | undefined): string | null => {
    if (distanceMeters == null) return null;
    if (distanceMeters < 1000) {
      return t('similarGyms.distanceMeters', { meters: Math.round(distanceMeters) });
    }
    return t('similarGyms.distanceKm', { km: (distanceMeters / 1000).toFixed(1) });
  };

  const submit = async () => {
    if (!token || !selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<ReportGymDuplicateMutationResponse, ReportGymDuplicateMutationVariables>(
        REPORT_GYM_DUPLICATE,
        { input: { gymUuid, duplicateGymUuid: selected.uuid, note: note.trim() || undefined } },
      );
      setOutcome(response.reportGymDuplicate.status);
    } catch (err) {
      setError(graphqlErrorMessage(err) ?? t('reportDuplicate.errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  let body: React.ReactNode;
  if (outcome) {
    body = (
      <Box
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 2, textAlign: 'center' }}
      >
        <CheckCircleOutlined color="success" sx={{ fontSize: 40 }} />
        <DialogContentText>
          {outcome === 'already_reported' ? t('reportDuplicate.alreadyReported') : t('reportDuplicate.sent')}
        </DialogContentText>
      </Box>
    );
  } else {
    body = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <DialogContentText>{t('reportDuplicate.description', { gym: gymName })}</DialogContentText>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label={t('reportDuplicate.searchLabel')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setSelected(null);
          }}
          fullWidth
          size="small"
          placeholder={t('reportDuplicate.searchPlaceholder')}
          autoFocus
        />

        {isFetching && candidates.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 1 }}>
            <CircularProgress size={20} />
          </Box>
        ) : candidates.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t('reportDuplicate.noResults')}
          </Typography>
        ) : (
          <Stack spacing={1}>
            {candidates.map((candidate) => {
              const isSelected = selected?.uuid === candidate.uuid;
              const distanceLabel = formatDistance(candidate.distanceMeters);
              return (
                <Card
                  key={candidate.uuid}
                  variant="outlined"
                  sx={{
                    borderRadius: `${themeTokens.borderRadius.md}px`,
                    borderColor: isSelected ? themeTokens.colors.primary : undefined,
                    borderWidth: isSelected ? 2 : 1,
                  }}
                >
                  <CardActionArea onClick={() => setSelected(candidate)} sx={{ p: 1.5 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                      <Typography
                        variant="subtitle2"
                        sx={{
                          fontWeight: themeTokens.typography.fontWeight.semibold,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {candidate.name}
                      </Typography>
                      {isSelected && <CheckCircleOutlined color="primary" sx={{ fontSize: 20, flexShrink: 0 }} />}
                    </Box>
                    {candidate.address && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
                        <LocationOnOutlined sx={{ fontSize: 14, color: themeTokens.neutral[400] }} />
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {candidate.address}
                        </Typography>
                      </Box>
                    )}
                    {distanceLabel && (
                      <Box sx={{ mt: 0.75 }}>
                        <Chip size="small" variant="outlined" label={distanceLabel} />
                      </Box>
                    )}
                  </CardActionArea>
                </Card>
              );
            })}
          </Stack>
        )}

        <TextField
          label={t('reportDuplicate.noteLabel')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          fullWidth
          size="small"
          multiline
          minRows={2}
          maxRows={5}
          placeholder={t('reportDuplicate.notePlaceholder')}
          slotProps={{ htmlInput: { maxLength: GYM_CLAIM_MESSAGE_MAX_LENGTH } }}
        />
      </Box>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('reportDuplicate.title')}</DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>
        <MuiButton onClick={onClose} sx={{ textTransform: 'none' }}>
          {outcome ? t('reportDuplicate.done') : t('reportDuplicate.cancel')}
        </MuiButton>
        {!outcome && (
          <MuiButton
            variant="contained"
            onClick={submit}
            disabled={submitting || !selected}
            sx={{ textTransform: 'none' }}
          >
            {submitting ? <CircularProgress size={18} color="inherit" /> : t('reportDuplicate.submit')}
          </MuiButton>
        )}
      </DialogActions>
    </Dialog>
  );
}

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import List from '@mui/material/List';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { parseGrantMonths, supporterGrantUntil } from '@/app/lib/admin/supporter-grant';
import {
  SEARCH_USERS,
  type SearchUsersQueryResponse,
  type SearchUsersQueryVariables,
} from '@boardsesh/graphql/operations/social';
import {
  GRANT_SUPPORTER,
  GRANTABLE_SUPPORTER_SOURCES,
  type GrantableSupporterSource,
  type GrantSupporterMutationResponse,
  type GrantSupporterMutationVariables,
} from '@boardsesh/graphql/operations/support-admin';

type UserResult = SearchUsersQueryResponse['searchUsers']['results'][number]['user'];

const SEARCH_DEBOUNCE_MS = 300;

type SupporterGrantPanelProps = {
  /** Injected so tests can pin the grant date; defaults to the wall clock. */
  getNow?: () => Date;
};

/**
 * Admin-only: record supporter status by hand, for a GitHub sponsor or a gift
 * made outside Stripe. Calls `grantSupporter`, which stores the end date as
 * given, so a later grant replaces an earlier one rather than adding to it.
 */
export default function SupporterGrantPanel({ getNow = () => new Date() }: SupporterGrantPanelProps) {
  const { t, i18n } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [userId, setUserId] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [source, setSource] = useState<GrantableSupporterSource>('github_sponsors');
  const [monthsText, setMonthsText] = useState('1');
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!token || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(async () => {
      setSearching(true);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<SearchUsersQueryResponse, SearchUsersQueryVariables>(SEARCH_USERS, {
          input: { query: searchQuery.trim(), limit: 5 },
        });
        setSearchResults(result.searchUsers.results.map((row) => row.user));
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(searchTimeout.current);
  }, [token, searchQuery]);

  const months = parseGrantMonths(monthsText);
  const trimmedUserId = userId.trim();
  const formatDate = useCallback(
    (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'medium', timeZone: 'UTC' }),
    [i18n.language],
  );

  const grant = useMutation({
    mutationFn: async (variables: GrantSupporterMutationVariables) => {
      if (!token) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(token);
      const result = await client.request<GrantSupporterMutationResponse, GrantSupporterMutationVariables>(
        GRANT_SUPPORTER,
        variables,
      );
      return result.grantSupporter;
    },
  });

  // A result shown under a different account would read as that account's
  // grant, so any change to the target clears it.
  const { reset: resetGrant } = grant;
  const handleSelect = useCallback(
    (user: UserResult) => {
      setUserId(user.id);
      setSelectedName(user.displayName ?? null);
      setSearchQuery('');
      setSearchResults([]);
      resetGrant();
    },
    [resetGrant],
  );

  const handleGrant = useCallback(() => {
    if (!trimmedUserId || months === null) return;
    grant.mutate({
      userId: trimmedUserId,
      source,
      creditUntil: supporterGrantUntil(getNow(), months).toISOString(),
    });
  }, [trimmedUserId, months, source, getNow, grant]);

  const previewUntil = months === null ? null : supporterGrantUntil(getNow(), months).toISOString();

  return (
    <Box>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
        {t('supporters.heading')}
      </Typography>
      <Typography variant="body2" sx={{ color: themeTokens.neutral[500], mb: 2 }}>
        {t('supporters.description')}
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField
          label={t('supporters.search.label')}
          placeholder={t('supporters.search.placeholder')}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          size="small"
          fullWidth
          slotProps={{
            input: { endAdornment: searching ? <CircularProgress size={16} /> : undefined },
          }}
        />
        {searchResults.length > 0 && (
          <List dense aria-label={t('supporters.search.resultsLabel')}>
            {searchResults.map((user) => (
              <ListItemButton key={user.id} onClick={() => handleSelect(user)}>
                <ListItemAvatar>
                  <Avatar src={user.avatarUrl ?? undefined} sx={{ width: 28, height: 28 }}>
                    {(user.displayName ?? '?').charAt(0)}
                  </Avatar>
                </ListItemAvatar>
                <ListItemText primary={user.displayName ?? user.id} secondary={user.id} />
              </ListItemButton>
            ))}
          </List>
        )}

        <TextField
          label={t('supporters.userId.label')}
          helperText={selectedName ? t('supporters.userId.selected', { name: selectedName }) : undefined}
          value={userId}
          onChange={(event) => {
            setUserId(event.target.value);
            setSelectedName(null);
            resetGrant();
          }}
          size="small"
          fullWidth
        />

        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel id="supporter-grant-source">{t('supporters.source.label')}</InputLabel>
            <Select
              labelId="supporter-grant-source"
              label={t('supporters.source.label')}
              value={source}
              onChange={(event) => setSource(event.target.value as GrantableSupporterSource)}
            >
              {GRANTABLE_SUPPORTER_SOURCES.map((option) => (
                <MenuItem key={option} value={option}>
                  {option === 'github_sponsors' ? t('supporters.source.githubSponsors') : t('supporters.source.admin')}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label={t('supporters.months.label')}
            value={monthsText}
            onChange={(event) => setMonthsText(event.target.value)}
            error={months === null}
            helperText={
              previewUntil
                ? t('supporters.months.until', { date: formatDate(previewUntil) })
                : t('supporters.months.invalid')
            }
            size="small"
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            sx={{ width: 200 }}
          />
        </Box>

        <Box>
          <Button
            variant="contained"
            onClick={handleGrant}
            disabled={!token || !trimmedUserId || months === null || grant.isPending}
            sx={{
              textTransform: 'none',
              bgcolor: 'var(--color-primary-fill)',
              '&:hover': { bgcolor: 'var(--color-primary-fill-hover)' },
            }}
          >
            {t('supporters.grant')}
          </Button>
        </Box>

        {grant.isSuccess && grant.data.creditUntil && (
          <Alert severity="success">{t('supporters.granted', { date: formatDate(grant.data.creditUntil) })}</Alert>
        )}
        {grant.isError && <Alert severity="error">{t('supporters.grantFailed')}</Alert>}
      </Paper>
    </Box>
  );
}

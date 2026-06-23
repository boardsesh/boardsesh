'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Chip from '@mui/material/Chip';
import Avatar from '@mui/material/Avatar';
import MuiTypography from '@mui/material/Typography';
import MuiButton from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import type { BoardLeaderboard as BoardLeaderboardType, BoardLeaderboardEntry } from '@boardsesh/shared-schema';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_BOARD_LEADERBOARD,
  type GetBoardLeaderboardQueryResponse,
  type GetBoardLeaderboardQueryVariables,
} from '@boardsesh/graphql/operations';
import { themeTokens } from '@/app/theme/theme-config';

type Period = 'week' | 'month' | 'year' | 'all';

type BoardLeaderboardProps = {
  boardUuid: string;
};

export default function BoardLeaderboard({ boardUuid }: BoardLeaderboardProps) {
  const { t } = useTranslation('boards');
  const periodOptions = useMemo<{ value: Period; label: string }[]>(
    () => [
      { value: 'week', label: t('boardLeaderboard.period.week') },
      { value: 'month', label: t('boardLeaderboard.period.month') },
      { value: 'year', label: t('boardLeaderboard.period.year') },
      { value: 'all', label: t('boardLeaderboard.period.all') },
    ],
    [t],
  );
  const [period, setPeriod] = useState<Period>('all');
  const [leaderboard, setLeaderboard] = useState<BoardLeaderboardType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const { token } = useWsAuthToken();

  const fetchLeaderboard = useCallback(
    async (offset = 0, append = false) => {
      if (!token) return;
      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }

      try {
        const client = createGraphQLHttpClient(token);
        const data = await client.request<GetBoardLeaderboardQueryResponse, GetBoardLeaderboardQueryVariables>(
          GET_BOARD_LEADERBOARD,
          {
            input: { boardUuid, period, limit: 20, offset },
          },
        );

        if (append) {
          setLeaderboard((prev) =>
            prev
              ? {
                  ...data.boardLeaderboard,
                  entries: [...prev.entries, ...data.boardLeaderboard.entries],
                }
              : data.boardLeaderboard,
          );
        } else {
          setLeaderboard(data.boardLeaderboard);
        }
      } catch (error) {
        console.error('Failed to fetch leaderboard:', error);
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [token, boardUuid, period],
  );

  useEffect(() => {
    void fetchLeaderboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, boardUuid, period]);

  const handleLoadMore = () => {
    if (leaderboard) {
      void fetchLeaderboard(leaderboard.entries.length, true);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        {periodOptions.map((opt) => (
          <Chip
            key={opt.value}
            label={opt.label}
            size="small"
            variant={period === opt.value ? 'filled' : 'outlined'}
            color={period === opt.value ? 'primary' : 'default'}
            onClick={() => setPeriod(opt.value)}
          />
        ))}
      </Box>

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {!isLoading && (!leaderboard || leaderboard.entries.length === 0) && (
        <MuiTypography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
          {t('boardLeaderboard.empty')}
        </MuiTypography>
      )}
      {!isLoading && leaderboard && leaderboard.entries.length > 0 && (
        <>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, width: 40 }}>#</TableCell>
                  <TableCell sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                    {t('boardLeaderboard.columns.climber')}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                    {t('boardLeaderboard.columns.sends')}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      fontWeight: themeTokens.typography.fontWeight.semibold,
                      display: { xs: 'none', sm: 'table-cell' },
                    }}
                  >
                    {t('boardLeaderboard.columns.flashes')}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                    {t('boardLeaderboard.columns.hardest')}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {leaderboard.entries.map((entry: BoardLeaderboardEntry) => (
                  <TableRow key={entry.userId}>
                    <TableCell>
                      <MuiTypography
                        variant="body2"
                        sx={{
                          fontWeight:
                            entry.rank <= 3
                              ? themeTokens.typography.fontWeight.bold
                              : themeTokens.typography.fontWeight.normal,
                          color: entry.rank <= 3 ? 'var(--color-primary)' : undefined,
                        }}
                      >
                        {entry.rank}
                      </MuiTypography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Avatar src={entry.userAvatarUrl ?? undefined} sx={{ width: 28, height: 28, fontSize: 12 }}>
                          {entry.userDisplayName?.[0]?.toUpperCase()}
                        </Avatar>
                        <MuiTypography
                          variant="body2"
                          sx={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {entry.userDisplayName}
                        </MuiTypography>
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <MuiTypography variant="body2">{entry.totalSends}</MuiTypography>
                    </TableCell>
                    <TableCell align="right" sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
                      <MuiTypography variant="body2">{entry.totalFlashes}</MuiTypography>
                    </TableCell>
                    <TableCell align="right">
                      <MuiTypography variant="body2">{entry.hardestGradeName || '-'}</MuiTypography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {leaderboard.hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <MuiButton variant="text" size="small" onClick={handleLoadMore} disabled={isLoadingMore}>
                {isLoadingMore ? <CircularProgress size={16} /> : 'Load more'}
              </MuiButton>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

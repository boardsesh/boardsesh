'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import MuiLink from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import EditOutlined from '@mui/icons-material/EditOutlined';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import { SUPPORTED_BOARDS, type AdminBoard } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import {
  ADMIN_BOARDS,
  ADMIN_BOARD,
  type AdminBoardsQueryResponse,
  type AdminBoardsQueryVariables,
  type AdminBoardQueryResponse,
  type AdminBoardQueryVariables,
} from '@boardsesh/graphql/operations';
import EditBoardForm from '@/app/components/board-entity/edit-board-form';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { themeTokens } from '@/app/theme/theme-config';

const PAGE_SIZE = 20;

function AdminBoardEditor({
  board,
  onSaved,
  onCancel,
}: {
  board: AdminBoard;
  onSaved: (board: AdminBoard) => Promise<void>;
  onCancel: () => void;
}) {
  // Background refetches must not move the baseline beneath unsaved inputs.
  const [initialBoard] = useState(board);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return (
    <EditBoardForm
      mode="admin"
      board={initialBoard}
      onSuccess={async (updatedBoard) => {
        if (mountedRef.current) await onSaved(updatedBoard);
      }}
      onCancel={onCancel}
    />
  );
}

export default function AdminBoardsPanel({ viewerUserId }: { viewerUserId: string }) {
  const { t } = useTranslation('admin');
  const { t: tBoards } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const { data: session } = useSession();
  const isCurrentViewer = session?.user?.id === viewerUserId;
  const queryClient = useQueryClient();
  const router = useLocaleRouter();
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [boardType, setBoardType] = useState('');
  const [page, setPage] = useState(0);
  const [editingUuid, setEditingUuid] = useState<string | null>(null);

  // Private admin records never enter the persisted or public board caches.
  const boardsQuery = useQuery({
    queryKey: ['adminBoards', viewerUserId, query, boardType, page],
    enabled: !!token && isCurrentViewer,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<AdminBoardsQueryResponse, AdminBoardsQueryVariables>(ADMIN_BOARDS, {
        input: {
          query: query || undefined,
          boardType: boardType || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
      });
      return response.adminBoards;
    },
  });

  const boardQuery = useQuery({
    queryKey: ['adminBoard', viewerUserId, editingUuid],
    enabled: !!token && isCurrentViewer && editingUuid !== null,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      if (!editingUuid) return null;
      const client = createGraphQLHttpClient(token);
      const response = await client.request<AdminBoardQueryResponse, AdminBoardQueryVariables>(ADMIN_BOARD, {
        boardUuid: editingUuid,
      });
      return response.adminBoard;
    },
  });

  const handleSaved = useCallback(
    async (_updatedBoard: AdminBoard) => {
      setEditingUuid(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['adminBoards', viewerUserId] }),
        queryClient.invalidateQueries({ queryKey: ['adminBoard', viewerUserId] }),
        queryClient.invalidateQueries({ queryKey: ['gymBoards'] }),
      ]);
      router.refresh();
    },
    [queryClient, router, viewerUserId],
  );

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const nextQuery = searchInput.trim();
    setPage(0);
    setQuery(nextQuery);
    if (nextQuery === query && page === 0) void boardsQuery.refetch();
  };

  if (!token || !isCurrentViewer) return <Alert severity="warning">{t('auth.signInRequired')}</Alert>;

  if (editingUuid) {
    if (boardQuery.isPending) return <CircularProgress aria-label={t('boards.loading')} />;
    if (boardQuery.isError || !boardQuery.data) {
      return (
        <Stack spacing={2}>
          <Alert severity="error">{t('boards.editLoadError')}</Alert>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button onClick={() => void boardQuery.refetch()}>{t('boards.retry')}</Button>
            <Button onClick={() => setEditingUuid(null)}>{t('boards.backToList')}</Button>
          </Box>
        </Stack>
      );
    }
    return (
      <AdminBoardEditor
        key={`${viewerUserId}:${editingUuid}`}
        board={boardQuery.data}
        onSaved={handleSaved}
        onCancel={() => setEditingUuid(null)}
      />
    );
  }

  const connection = boardsQuery.data;
  return (
    <Stack spacing={2}>
      <MuiLink component={LocaleLink} href="/admin" underline="hover" sx={{ alignSelf: 'flex-start' }}>
        {t('boards.backToAdmin')}
      </MuiLink>
      <Box component="form" onSubmit={submitSearch} sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <TextField
          label={t('boards.search')}
          placeholder={t('boards.searchPlaceholder')}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          size="small"
          slotProps={{ htmlInput: { maxLength: 200 } }}
          sx={{ flex: '1 1 280px' }}
        />
        <TextField
          select
          label={t('boards.boardType')}
          value={boardType}
          onChange={(event) => {
            setPage(0);
            setBoardType(event.target.value);
          }}
          size="small"
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">{t('boards.allTypes')}</MenuItem>
          {SUPPORTED_BOARDS.map((supportedBoard) => (
            <MenuItem key={supportedBoard} value={supportedBoard}>
              {boardTypeLabel(supportedBoard)}
            </MenuItem>
          ))}
        </TextField>
        <Button type="submit" variant="contained">
          {t('boards.searchAction')}
        </Button>
      </Box>

      {boardsQuery.isPending ? (
        <Box sx={{ py: 3 }}>
          <CircularProgress aria-label={t('boards.loading')} />
        </Box>
      ) : boardsQuery.isError ? (
        <Alert
          severity="error"
          action={<Button onClick={() => void boardsQuery.refetch()}>{t('boards.retry')}</Button>}
        >
          {t('boards.loadError')}
        </Alert>
      ) : connection?.boards.length === 0 ? (
        <Typography color="text.secondary">{t('boards.empty')}</Typography>
      ) : (
        <Stack component="ul" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {connection?.boards.map((board) => (
            <Paper component="li" key={board.uuid} variant="outlined" sx={{ p: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
                <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <Typography sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>{board.name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {boardTypeLabel(board.boardType)} · {board.angle}°
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t('boards.owner', { name: board.ownerDisplayName || board.ownerId || t('boards.systemOwner') })}
                  </Typography>
                  {board.gymSlug ? (
                    <MuiLink component={LocaleLink} href={`/gym/${encodeURIComponent(board.gymSlug)}`}>
                      {board.gymName}
                    </MuiLink>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {board.gymName || t('boards.noGym')}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {board.slug}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={
                      board.isUnlisted
                        ? t('boards.visibility.unlisted')
                        : board.isPublic
                          ? t('boards.visibility.public')
                          : t('boards.visibility.private')
                    }
                  />
                  <Button
                    size="small"
                    startIcon={<EditOutlined />}
                    onClick={() => setEditingUuid(board.uuid)}
                    aria-label={t('boards.editNamed', { name: board.name })}
                  >
                    {tBoards('boardEntity.actions.edit')}
                  </Button>
                </Box>
              </Box>
            </Paper>
          ))}
        </Stack>
      )}

      {connection && (
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Typography variant="body2" color="text.secondary">
            {t('boards.results', { count: connection.totalCount })}
          </Typography>
          <Button
            startIcon={<ArrowBackOutlined />}
            disabled={page === 0 || boardsQuery.isFetching}
            onClick={() => setPage((previous) => previous - 1)}
          >
            {t('boards.previous')}
          </Button>
          <Button
            disabled={!connection.hasMore || boardsQuery.isFetching}
            onClick={() => setPage((previous) => previous + 1)}
          >
            {t('boards.next')}
          </Button>
        </Box>
      )}
    </Stack>
  );
}

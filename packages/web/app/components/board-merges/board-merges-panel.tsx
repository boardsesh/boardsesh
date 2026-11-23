'use client';

import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBrowserSession } from '@/app/components/providers/session-provider';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type {
  UserBoard,
  BoardMergeRequest as MergeRequest,
  BoardMergePreview as MergePreview,
} from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import { boardTypeLabel, LAYOUTS, PRODUCT_SIZES, SETS } from '@boardsesh/board-constants';
import {
  BOARD_MERGE_CANDIDATES,
  BOARD_MERGE_PREVIEW,
  BOARD_MERGE_REQUESTS,
  REQUEST_BOARD_MERGE,
  MERGE_BOARDS,
  RESOLVE_BOARD_MERGE_REQUEST,
  GET_BOARD,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';

type CandidateConnection = { boards: UserBoard[]; hasMore: boolean };
type RequestConnection = { requests: MergeRequest[]; hasMore: boolean };
const PAGE_SIZE = 20;

export default function BoardMergesPanel({
  initialBoardUuid,
  initialGymUuid,
}: {
  initialBoardUuid?: string;
  initialGymUuid?: string;
}) {
  const { t } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const { data: session } = useBrowserSession();
  const viewerId = session?.user?.id;
  const queryClient = useQueryClient();
  const router = useLocaleRouter();
  const [gymUuid, setGymUuid] = useState(initialGymUuid);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selectedBoards, setSelectedBoards] = useState<UserBoard[]>([]);
  const [canonicalUuid, setCanonicalUuid] = useState('');
  const [reason, setReason] = useState('');
  const [reviewing, setReviewing] = useState<MergeRequest | null>(null);
  const [status, setStatus] = useState('open');
  const [boardType, setBoardType] = useState('');
  const [confirmation, setConfirmation] = useState<'merge' | 'approve' | 'reject' | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [outcome, setOutcome] = useState<'success' | 'requested' | null>(null);
  const [error, setError] = useState(false);
  const credentialRef = useRef({ token, viewerId });
  credentialRef.current = { token, viewerId };
  const enabled = Boolean(token && viewerId);
  const boardUuids = selectedBoards.map((board) => board.uuid).sort();

  useEffect(() => {
    let active = true;
    setSelectedBoards([]);
    setReviewing(null);
    setCanonicalUuid('');
    setReason('');
    setConfirmation(null);
    setOutcome(null);
    setError(false);
    if (initialBoardUuid && token && viewerId) {
      const client = createGraphQLHttpClient(token);
      void client
        .request<{ board: UserBoard | null }>(GET_BOARD, { boardUuid: initialBoardUuid })
        .then((response) => {
          if (active && response.board?.isPublic && response.board.boardType !== 'spray')
            setSelectedBoards([response.board]);
        })
        .catch(() => {
          if (active) setError(true);
        });
    }
    return () => {
      active = false;
    };
  }, [initialBoardUuid, token, viewerId]);

  const candidates = useInfiniteQuery({
    queryKey: ['boardMergeCandidates', viewerId, gymUuid, search, selectedBoards[0]?.uuid],
    enabled,
    gcTime: 0,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<{ boardMergeCandidates: CandidateConnection }>(BOARD_MERGE_CANDIDATES, {
        input: {
          gymUuid,
          query: search || undefined,
          boardUuid: selectedBoards[0]?.uuid,
          limit: PAGE_SIZE,
          offset: pageParam,
        },
      });
      return response.boardMergeCandidates;
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.reduce((count, page) => count + page.boards.length, 0) : undefined,
  });
  const preview = useQuery({
    queryKey: ['boardMergePreview', viewerId, boardUuids],
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: enabled && boardUuids.length >= 2,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      return (await client.request<{ boardMergePreview: MergePreview }>(BOARD_MERGE_PREVIEW, { boardUuids }))
        .boardMergePreview;
    },
  });
  const requests = useInfiniteQuery({
    queryKey: ['boardMergeRequests', viewerId, gymUuid, boardType, status],
    enabled,
    gcTime: 0,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(token);
      return (
        await client.request<{ boardMergeRequests: RequestConnection }>(BOARD_MERGE_REQUESTS, {
          input: {
            gymUuid,
            boardType: boardType || undefined,
            status: status || undefined,
            limit: PAGE_SIZE,
            offset: pageParam,
          },
        })
      ).boardMergeRequests;
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.reduce((count, page) => count + page.requests.length, 0) : undefined,
  });
  const survivorUuid = canonicalUuid || preview.data?.suggestedCanonicalBoardUuid || '';
  const displayedBoards = preview.data && boardUuids.length >= 2 ? preview.data.boards : selectedBoards;
  const survivor = displayedBoards.find((board) => board.uuid === survivorUuid);
  const canSubmit = Boolean(
    preview.data && !preview.isFetching && !preview.isError && survivor && reason.trim().length >= 10,
  );
  const resetSelection = () => {
    setSelectedBoards([]);
    setCanonicalUuid('');
    setReason('');
    setReviewing(null);
    setConfirmation(null);
  };
  const submit = async (action: 'request' | 'merge' | 'approve' | 'reject') => {
    if (!token || pendingRef.current || (action !== 'reject' && !canSubmit)) return;
    const credentials = credentialRef.current;
    pendingRef.current = true;
    setPending(true);
    setError(false);
    try {
      const client = createGraphQLHttpClient(token);
      if (action === 'request')
        await client.request(REQUEST_BOARD_MERGE, {
          input: { boardUuids, canonicalBoardUuid: survivorUuid, reason: reason.trim() },
        });
      else if (action === 'merge')
        await client.request(MERGE_BOARDS, {
          input: {
            boardUuids,
            canonicalBoardUuid: survivorUuid,
            version: preview.data?.version,
            reason: reason.trim(),
          },
        });
      else
        await client.request(RESOLVE_BOARD_MERGE_REQUEST, {
          input: {
            requestUuid: reviewing?.uuid,
            approve: action === 'approve',
            canonicalBoardUuid: action === 'approve' ? survivorUuid : undefined,
            version: action === 'approve' ? preview.data?.version : undefined,
            reason: reason.trim() || undefined,
          },
        });
      if (credentialRef.current.token !== credentials.token || credentialRef.current.viewerId !== credentials.viewerId)
        return;
      setOutcome(action === 'request' ? 'requested' : 'success');
      resetSelection();
      await Promise.all(
        ['boardMergeRequests', 'boardMergeCandidates', 'boardMergePreview', 'gymBoards', 'adminBoards', 'board'].map(
          (key) => queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      router.refresh();
    } catch {
      if (
        credentialRef.current.token === credentials.token &&
        credentialRef.current.viewerId === credentials.viewerId
      ) {
        setError(true);
        setConfirmation(null);
        void preview.refetch();
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const describeBoard = (board: UserBoard) =>
    t('merge.configuration', {
      type: boardTypeLabel(board.boardType),
      layout: LAYOUTS[board.boardType as BoardName]?.[board.layoutId]?.name ?? board.layoutId,
      size: PRODUCT_SIZES[board.boardType as BoardName]?.[board.sizeId]?.name ?? board.sizeId,
      sets: board.setIds
        .split(',')
        .map(
          (setId) =>
            SETS[board.boardType as BoardName]?.[`${board.layoutId}-${board.sizeId}`]?.find(
              (set) => set.id === Number(setId),
            )?.name ?? setId,
        )
        .join(', '),
      angle: board.angle,
    });
  const statusLabel = (requestStatus: string) => {
    switch (requestStatus) {
      case 'approved':
        return t('merge.statusApproved');
      case 'rejected':
        return t('merge.statusRejected');
      case 'superseded':
        return t('merge.statusSuperseded');
      default:
        return t('merge.statusOpen');
    }
  };
  if (!enabled) return <Alert severity="info">{t('merge.signIn')}</Alert>;
  return (
    <Stack spacing={3}>
      {outcome && (
        <Alert severity="success">{outcome === 'requested' ? t('merge.requested') : t('merge.success')}</Alert>
      )}
      {error && <Alert severity="error">{t('merge.error')}</Alert>}
      {gymUuid && <Button onClick={() => setGymUuid(undefined)}>{t('merge.clearGymFilter')}</Button>}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Typography component="h2" variant="h6">
            {t('merge.selectBoards')}
          </Typography>
          <Typography color="text.secondary">{t('merge.selectionHint')}</Typography>
          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchInput.trim());
            }}
            sx={{ display: 'flex', gap: 1 }}
          >
            <TextField
              label={t('merge.search')}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              size="small"
              fullWidth
            />
            <Button type="submit">{t('merge.searchAction')}</Button>
          </Box>
          {candidates.isPending && <CircularProgress aria-label={t('merge.loading')} />}
          {candidates.isError && (
            <Alert
              severity="error"
              action={<Button onClick={() => void candidates.refetch()}>{t('merge.retry')}</Button>}
            >
              {t('merge.error')}
            </Alert>
          )}
          <Stack>
            {candidates.data?.pages
              .flatMap((page) => page.boards)
              .map((board) => (
                <FormControlLabel
                  key={board.uuid}
                  disabled={pending || !!reviewing}
                  control={
                    <Checkbox
                      checked={boardUuids.includes(board.uuid)}
                      onChange={(_, checked) => {
                        setCanonicalUuid('');
                        setSelectedBoards((previous) =>
                          checked ? [...previous, board] : previous.filter((selected) => selected.uuid !== board.uuid),
                        );
                        setOutcome(null);
                      }}
                    />
                  }
                  label={
                    <Box>
                      <Typography>{board.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {describeBoard(board)}
                        {board.gymName ? ` · ${board.gymName}` : ''}
                      </Typography>
                    </Box>
                  }
                />
              ))}
          </Stack>
          {candidates.hasNextPage && (
            <Button disabled={candidates.isFetchingNextPage} onClick={() => void candidates.fetchNextPage()}>
              {t('merge.loadMore')}
            </Button>
          )}
          {selectedBoards.length > 0 && (
            <Typography>{t('merge.selected', { count: selectedBoards.length })}</Typography>
          )}
          {preview.isFetching && boardUuids.length >= 2 && <CircularProgress aria-label={t('merge.preview')} />}
          {preview.isError && (
            <Alert severity="error" action={<Button onClick={() => void preview.refetch()}>{t('merge.retry')}</Button>}>
              {t('merge.incompatible')}
            </Alert>
          )}
          {preview.data && boardUuids.length >= 2 && (
            <>
              <Typography component="h3" variant="subtitle1">
                {t('merge.selectSurvivor')}
              </Typography>
              <RadioGroup value={survivorUuid} onChange={(event) => setCanonicalUuid(event.target.value)}>
                {displayedBoards.map((board) => (
                  <FormControlLabel
                    disabled={pending}
                    key={board.uuid}
                    value={board.uuid}
                    control={<Radio />}
                    label={
                      <Box>
                        <Typography>{board.name}</Typography>
                        <Typography variant="caption">
                          {describeBoard(board)}
                          {board.gymName ? ` · ${board.gymName}` : ''}
                        </Typography>
                        {board.ownerDisplayName && (
                          <Typography variant="caption" display="block">
                            {board.ownerDisplayName}
                          </Typography>
                        )}
                        <Typography variant="caption" display="block">
                          {board.totalAscents ?? 0} {t('boardEntity.stats.ascents')} · {board.followerCount ?? 0}{' '}
                          {t('boardEntity.stats.followers')}
                        </Typography>
                      </Box>
                    }
                  />
                ))}
              </RadioGroup>
              <Typography color="text.secondary">{t('merge.keptDetails')}</Typography>
              <Alert severity="info">{t('merge.kioskWarning')}</Alert>
            </>
          )}
          <TextField
            label={t('merge.reason')}
            helperText={t('merge.reasonHint')}
            multiline
            minRows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={pending}
            slotProps={{ htmlInput: { maxLength: 500 } }}
          />
          <Stack direction="row" spacing={1}>
            {reviewing ? (
              <>
                <Button
                  disabled={!canSubmit || !preview.data?.canMerge || pending}
                  onClick={() => setConfirmation('approve')}
                >
                  {t('merge.approve')}
                </Button>
                <Button disabled={pending || !reviewing.canResolve} onClick={() => setConfirmation('reject')}>
                  {t('merge.reject')}
                </Button>
              </>
            ) : (
              <>
                <Button disabled={!canSubmit || pending} onClick={() => void submit('request')}>
                  {t('merge.request')}
                </Button>
                {preview.data?.canMerge && (
                  <Button variant="contained" disabled={!canSubmit || pending} onClick={() => setConfirmation('merge')}>
                    {t('merge.merge')}
                  </Button>
                )}
              </>
            )}
            <Button disabled={pending} onClick={resetSelection}>
              {t('merge.cancel')}
            </Button>
          </Stack>
        </Stack>
      </Paper>
      <Stack spacing={2}>
        <Typography component="h2" variant="h6">
          {t('merge.reviewQueue')}
        </Typography>
        <Stack direction="row" spacing={1}>
          <TextField
            select
            label={t('merge.statusFilter')}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            size="small"
          >
            <MenuItem value="">{t('merge.all')}</MenuItem>
            <MenuItem value="open">{t('merge.statusOpen')}</MenuItem>
            <MenuItem value="approved">{t('merge.statusApproved')}</MenuItem>
            <MenuItem value="rejected">{t('merge.statusRejected')}</MenuItem>
            <MenuItem value="superseded">{t('merge.statusSuperseded')}</MenuItem>
          </TextField>
          <TextField
            select
            label={t('merge.boardTypeFilter')}
            value={boardType}
            onChange={(event) => setBoardType(event.target.value)}
            size="small"
          >
            <MenuItem value="">{t('merge.allBoardTypes')}</MenuItem>
            {SUPPORTED_BOARDS.filter((supportedBoard) => supportedBoard !== 'spray').map((supportedBoard) => (
              <MenuItem key={supportedBoard} value={supportedBoard}>
                {boardTypeLabel(supportedBoard)}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
        {requests.isPending && <CircularProgress aria-label={t('merge.loading')} />}
        {requests.isError && (
          <Alert severity="error" action={<Button onClick={() => void requests.refetch()}>{t('merge.retry')}</Button>}>
            {t('merge.error')}
          </Alert>
        )}
        {requests.data?.pages
          .flatMap((page) => page.requests)
          .map((request) => (
            <Paper variant="outlined" sx={{ p: 2 }} key={request.uuid}>
              <Typography>{request.boards.map((board) => board.name).join(' · ')}</Typography>
              <Typography variant="body2" color="text.secondary">
                {request.reason}
              </Typography>
              <Typography variant="caption">{statusLabel(request.status)}</Typography>
              {request.reports
                ?.filter((report) => report.reason !== request.reason)
                .map((report) => (
                  <Typography key={`${report.createdAt}:${report.reason}`} variant="body2">
                    {report.reason}
                  </Typography>
                ))}
              {request.resolutionReason && <Typography variant="body2">{request.resolutionReason}</Typography>}
              {request.status === 'open' && request.canResolve && (
                <Button
                  disabled={pending}
                  onClick={() => {
                    setReviewing(request);
                    setSelectedBoards(request.boards);
                    setCanonicalUuid(request.canonicalBoardUuid);
                    setReason(request.reason);
                    setOutcome(null);
                  }}
                >
                  {t('merge.review')}
                </Button>
              )}
            </Paper>
          ))}
        {requests.data?.pages[0]?.requests.length === 0 && <Typography>{t('merge.empty')}</Typography>}
        {requests.hasNextPage && (
          <Button disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>
            {t('merge.loadMore')}
          </Button>
        )}
      </Stack>
      <Dialog
        open={confirmation !== null}
        onClose={() => {
          if (!pending) setConfirmation(null);
        }}
      >
        <DialogTitle>{confirmation === 'reject' ? t('merge.reject') : t('merge.confirmTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmation === 'reject'
              ? t('merge.rejectMessage')
              : t('merge.confirmMessage', { name: survivor?.name ?? '' })}
          </DialogContentText>
          {confirmation !== 'reject' && <DialogContentText sx={{ mt: 1 }}>{t('merge.kioskWarning')}</DialogContentText>}
        </DialogContent>
        <DialogActions>
          <Button autoFocus disabled={pending} onClick={() => setConfirmation(null)}>
            {t('merge.cancel')}
          </Button>
          <Button
            disabled={pending || (confirmation !== 'reject' && !canSubmit)}
            onClick={() => {
              if (confirmation) void submit(confirmation);
            }}
          >
            {t('merge.confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

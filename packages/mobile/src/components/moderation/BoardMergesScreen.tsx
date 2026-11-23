import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_BOARDS, type UserBoard } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { AppMenu } from '../AppMenu';
import {
  BOARD_MERGE_CANDIDATES,
  BOARD_MERGE_PREVIEW,
  BOARD_MERGE_REQUESTS,
  REQUEST_BOARD_MERGE,
  MERGE_BOARDS,
  RESOLVE_BOARD_MERGE_REQUEST,
} from '@boardsesh/graphql/operations';
import { Text } from '../Text';
import { Button } from '../Button';
import { AccessibleTextInput } from '../AccessibleTextInput';
import { RadioGroup } from '../RadioGroup';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineState } from '../OfflineState';
import { PressableSurface } from '../PressableSurface';
import { getHttpClient } from '../../lib/graphql/client';
import { useAuthToken } from '../../lib/graphql/use-auth-token';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { usePrivacyCredentialScope } from '../../hooks/use-privacy-scoped-state';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { fetchBoardByUuid } from '../../lib/graphql/hooks';
import {
  getActiveBoardWriteGeneration,
  useActiveBoard,
  useSetActiveBoardIfCurrentGeneration,
} from '../../lib/graphql/use-active-board';
import { spacing, borderRadius } from '../../theme/tokens';

export type MergeRequest = {
  uuid: string;
  status: string;
  reason: string;
  canonicalBoardUuid: string;
  boardUuids: string[];
  boards: UserBoard[];
  createdAt: string;
  reports?: { reason: string; createdAt: string }[];
  canResolve: boolean;
  resolutionReason?: string | null;
};
type Preview = {
  boards: UserBoard[];
  suggestedCanonicalBoardUuid: string;
  canMerge: boolean;
  version: string;
  reason?: string | null;
};
type Row = { kind: 'board'; board: UserBoard } | { kind: 'request'; request: MergeRequest };
const keyExtractor = (row: Row) => (row.kind === 'board' ? row.board.uuid : row.request.uuid);
const EMPTY_BOARDS: UserBoard[] = [];

const MergeRow = memo(function MergeRow({
  row,
  selected,
  busy,
  onToggle,
  onReview,
  onReject,
}: {
  row: Row;
  selected: boolean;
  busy: boolean;
  onToggle: (board: UserBoard) => void;
  onReview: (request: MergeRequest) => void;
  onReject: (request: MergeRequest) => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const toggle = useCallback(() => {
    if (row.kind === 'board') onToggle(row.board);
  }, [row, onToggle]);
  const review = useCallback(() => {
    if (row.kind === 'request') onReview(row.request);
  }, [row, onReview]);
  const reject = useCallback(() => {
    if (row.kind === 'request') onReject(row.request);
  }, [row, onReject]);
  if (row.kind === 'board')
    return (
      <PressableSurface
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected, disabled: busy }}
        accessibilityLabel={row.board.name}
        disabled={busy}
        onPress={toggle}
        style={[
          styles.card,
          {
            backgroundColor: systemColors.secondaryBackground,
            borderColor: selected ? systemColors.label : systemColors.separator,
          },
        ]}
      >
        <Text variant="headline">{row.board.name}</Text>
        <Text variant="footnote">{row.board.gymName ?? row.board.locationName}</Text>
        <Text variant="footnote">
          {t('merge.configuration', {
            type: row.board.boardType,
            layout: row.board.layoutName ?? row.board.layoutId,
            size: row.board.sizeName ?? row.board.sizeId,
            sets: row.board.setIds,
            angle: row.board.angle,
          })}
        </Text>
      </PressableSurface>
    );
  const request = row.request;
  const status =
    request.status === 'approved'
      ? t('merge.statusApproved')
      : request.status === 'rejected'
        ? t('merge.statusRejected')
        : request.status === 'superseded'
          ? t('merge.statusSuperseded')
          : t('merge.statusOpen');
  return (
    <View
      style={[styles.card, { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator }]}
    >
      <Text variant="headline">{request.boards.map((board) => board.name).join(' / ')}</Text>
      <Text>
        {request.reports?.length ? request.reports.map((report) => report.reason).join('\n') : request.reason}
      </Text>
      <Text variant="caption1">{status}</Text>
      {request.resolutionReason ? <Text>{request.resolutionReason}</Text> : null}
      {request.status === 'open' && request.canResolve ? (
        <View style={styles.actions}>
          <Button title={t('merge.review')} onPress={review} disabled={busy} />
          <Button title={t('merge.reject')} variant="outlined" onPress={reject} disabled={busy} />
        </View>
      ) : null}
    </View>
  );
});

export function BoardMergesScreen(props: { boardUuid?: string; gymUuid?: string }) {
  const scope = usePrivacyCredentialScope();
  return <BoardMergesBody key={scope} {...props} scope={scope} />;
}

function BoardMergesBody({ boardUuid, gymUuid, scope }: { boardUuid?: string; gymUuid?: string; scope: number }) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { data: token } = useAuthToken();
  const { effectiveOffline } = useConnectivity();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [composing, setComposing] = useState(!!boardUuid || !!gymUuid);
  const [gymFilter, setGymFilter] = useState(gymUuid);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('open');
  const [boardType, setBoardType] = useState('');
  const [selected, setSelected] = useState<UserBoard[]>([]);
  const [canonical, setCanonical] = useState('');
  const [reason, setReason] = useState('');
  const [previewIds, setPreviewIds] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState<MergeRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const { data: activeBoard } = useActiveBoard();
  const healActiveBoard = useSetActiveBoardIfCurrentGeneration();
  const anchorSeeded = useRef(false);
  const anchor = useQuery({
    queryKey: ['boardMergeAnchor', scope, boardUuid],
    enabled: !!token && !!boardUuid && !effectiveOffline,
    gcTime: 0,
    retry: false,
    queryFn: () => fetchBoardByUuid(boardUuid!),
  });
  useEffect(() => {
    if (!anchorSeeded.current && anchor.data?.isPublic && anchor.data.boardType !== 'spray') {
      anchorSeeded.current = true;
      setSelected((current) =>
        current.some((board) => board.uuid === anchor.data!.uuid) ? current : [anchor.data!, ...current],
      );
    }
  }, [anchor.data]);
  const candidates = useInfiniteQuery({
    queryKey: ['boardMergeCandidates', scope, boardUuid, gymFilter, query],
    enabled: !!token && composing && !effectiveOffline,
    initialPageParam: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ pageParam }) => {
      const response = await getHttpClient().request<{
        boardMergeCandidates: { boards: UserBoard[]; hasMore: boolean };
      }>(BOARD_MERGE_CANDIDATES, { input: { boardUuid, gymUuid: gymFilter, query, limit: 20, offset: pageParam } });
      return response.boardMergeCandidates;
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.reduce((count, page) => count + page.boards.length, 0) : undefined,
  });
  const queue = useInfiniteQuery({
    queryKey: ['boardMergeRequests', scope, gymFilter, status, boardType],
    enabled: !!token && !composing && !effectiveOffline,
    initialPageParam: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ pageParam }) => {
      const response = await getHttpClient().request<{
        boardMergeRequests: { requests: MergeRequest[]; hasMore: boolean };
      }>(BOARD_MERGE_REQUESTS, {
        input: {
          gymUuid: gymFilter,
          status: status || undefined,
          boardType: boardType || undefined,
          limit: 20,
          offset: pageParam,
        },
      });
      return response.boardMergeRequests;
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.reduce((count, page) => count + page.requests.length, 0) : undefined,
  });
  const preview = useQuery({
    queryKey: ['boardMergePreview', scope, previewIds],
    enabled: !!token && previewIds.length >= 2 && !effectiveOffline,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () =>
      (await getHttpClient().request<{ boardMergePreview: Preview }>(BOARD_MERGE_PREVIEW, { boardUuids: previewIds }))
        .boardMergePreview,
  });
  const visibleBoards = useMemo(
    () => candidates.data?.pages.flatMap((page) => page.boards) ?? EMPTY_BOARDS,
    [candidates.data],
  );
  const rows = useMemo<Row[]>(
    () =>
      composing
        ? visibleBoards.map((board) => ({ kind: 'board', board }))
        : (queue.data?.pages.flatMap((page) => page.requests.map((request): Row => ({ kind: 'request', request }))) ??
          []),
    [composing, visibleBoards, queue.data],
  );
  const selectedIds = useMemo(() => new Set(selected.map((board) => board.uuid)), [selected]);
  const survivorOptions = useMemo(
    () =>
      (preview.data?.boards ?? selected).map((board) => ({
        value: board.uuid,
        label: `${board.name} · ${board.ownerDisplayName ?? ''} · ${t('merge.configuration', { type: boardTypeLabel(board.boardType), layout: board.layoutName ?? board.layoutId, size: board.sizeName ?? board.sizeId, sets: board.setIds, angle: board.angle })} · ${board.gymName ?? ''} · ${board.totalAscents ?? 0} ${t('boardEntity.stats.ascents')} · ${board.followerCount ?? 0} ${t('boardEntity.stats.followers')}`,
      })),
    [preview.data, selected, t],
  );
  const boardTypes = useMemo(() => ['', ...SUPPORTED_BOARDS.filter((supported) => supported !== 'spray')], []);
  const boardTypeActions = useMemo(
    () =>
      boardTypes.map((type) => ({
        label: type ? boardTypeLabel(type) : t('merge.allBoardTypes'),
        selected: boardType === type,
      })),
    [boardTypes, boardType, t],
  );
  const selectBoardType = useCallback((index: number) => setBoardType(boardTypes[index] ?? ''), [boardTypes]);
  const chosenCanonical = canonical || preview.data?.suggestedCanonicalBoardUuid || '';
  const toggle = useCallback(
    (board: UserBoard) => {
      if (inFlight.current || reviewing) return;
      setSelected((current) =>
        current.some((entry) => entry.uuid === board.uuid)
          ? current.filter((entry) => entry.uuid !== board.uuid)
          : [...current, board],
      );
      setPreviewIds([]);
      setCanonical('');
    },
    [reviewing],
  );
  const review = useCallback((request: MergeRequest) => {
    if (inFlight.current) return;
    setReviewing(request);
    setSelected(request.boards);
    setPreviewIds(request.boardUuids);
    setCanonical(request.canonicalBoardUuid);
    setReason(request.reason);
    setComposing(true);
  }, []);
  const invalidate = useCallback(async () => {
    await Promise.all(
      [
        'boardMergeRequests',
        'boardMergeCandidates',
        'boardMergePreview',
        'myBoards',
        'gymBoards',
        'gym',
        'board',
        'boardByUuid',
      ].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
    );
  }, [queryClient]);
  const reject = useCallback(
    async (request: MergeRequest) => {
      if (inFlight.current || effectiveOffline) return;
      inFlight.current = true;
      setBusy(true);
      try {
        if (
          !(await confirm({
            title: t('merge.reject'),
            message: request.reason,
            confirmLabel: t('merge.reject'),
            cancelLabel: t('merge.cancel'),
            destructive: true,
          }))
        )
          return;
        if (scope !== getCredentialGeneration()) return;
        await getHttpClient().request(RESOLVE_BOARD_MERGE_REQUEST, {
          input: { requestUuid: request.uuid, approve: false },
        });
        if (scope === getCredentialGeneration()) await invalidate();
      } catch {
        if (scope === getCredentialGeneration()) showToast(t('merge.error'), 'error');
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [effectiveOffline, confirm, t, scope, invalidate, showToast],
  );
  const submit = useCallback(async () => {
    if (
      inFlight.current ||
      effectiveOffline ||
      preview.isFetching ||
      preview.isError ||
      !preview.data ||
      !chosenCanonical ||
      reason.trim().length < 10
    )
      return;
    inFlight.current = true;
    setBusy(true);
    const generation = getActiveBoardWriteGeneration();
    try {
      const willMerge = preview.data.canMerge;
      if (
        willMerge &&
        !(await confirm({
          title: t('merge.confirmTitle'),
          message: `${t('merge.confirmMessage', {
            name: preview.data.boards.find((board) => board.uuid === chosenCanonical)?.name,
          })}\n${t('merge.kioskWarning')}`,
          confirmLabel: t(reviewing ? 'merge.approve' : 'merge.merge'),
          cancelLabel: t('merge.cancel'),
          destructive: true,
        }))
      )
        return;
      if (scope !== getCredentialGeneration()) return;
      const input = { boardUuids: previewIds, canonicalBoardUuid: chosenCanonical, reason: reason.trim() };
      if (reviewing) {
        if (!willMerge) return;
        await getHttpClient().request(RESOLVE_BOARD_MERGE_REQUEST, {
          input: {
            requestUuid: reviewing.uuid,
            approve: true,
            canonicalBoardUuid: chosenCanonical,
            version: preview.data.version,
            reason: reason.trim(),
          },
        });
      } else if (willMerge)
        await getHttpClient().request(MERGE_BOARDS, { input: { ...input, version: preview.data.version } });
      else await getHttpClient().request(REQUEST_BOARD_MERGE, { input });
      if (scope !== getCredentialGeneration()) return;
      // The server has committed. Refresh/healing failures must not label that merge a failure.
      try {
        if (willMerge && activeBoard && previewIds.includes(activeBoard.uuid)) {
          const resolved = await fetchBoardByUuid(chosenCanonical);
          if (resolved && scope === getCredentialGeneration()) await healActiveBoard(generation, resolved);
        }
      } catch {
        /* Foreground self-healing will retry the canonical lookup. */
      }
      await invalidate().catch(() => {});
      if (scope !== getCredentialGeneration()) return;
      showToast(t(willMerge ? 'merge.success' : 'merge.requested'), 'success');
      setPreviewIds([]);
      setSelected([]);
      setReviewing(null);
      setComposing(false);
    } catch {
      if (scope === getCredentialGeneration()) {
        showToast(t('merge.error'), 'error');
        void preview.refetch();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [
    effectiveOffline,
    preview,
    chosenCanonical,
    reason,
    confirm,
    t,
    reviewing,
    scope,
    previewIds,
    activeBoard,
    healActiveBoard,
    invalidate,
    showToast,
  ]);
  const renderItem = useCallback(
    ({ item }: { item: Row }) => (
      <MergeRow
        row={item}
        selected={item.kind === 'board' && selectedIds.has(item.board.uuid)}
        busy={busy}
        onToggle={toggle}
        onReview={review}
        onReject={reject}
      />
    ),
    [selectedIds, busy, toggle, review, reject],
  );
  const refresh = useCallback(() => {
    void (composing ? candidates.refetch() : queue.refetch());
  }, [composing, candidates, queue]);
  const loadMore = useCallback(() => {
    if (composing) {
      if (candidates.hasNextPage && !candidates.isFetchingNextPage) void candidates.fetchNextPage();
    } else if (queue.hasNextPage && !queue.isFetchingNextPage) void queue.fetchNextPage();
  }, [composing, candidates, queue]);
  if (!token)
    return (
      <View style={styles.header}>
        <Text>{t('merge.authRequired')}</Text>
      </View>
    );
  const pending = composing ? candidates.isPending : queue.isPending;
  const error = composing ? candidates.isError : queue.isError;
  return (
    <View style={[styles.screen, { backgroundColor: systemColors.background }]}>
      <FlashList
        data={previewIds.length ? [] : rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        refreshControl={
          <RefreshControl refreshing={composing ? candidates.isRefetching : queue.isRefetching} onRefresh={refresh} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text>{t('merge.description')}</Text>
            {gymFilter ? (
              <Button title={t('merge.clearGymFilter')} variant="text" onPress={() => setGymFilter(undefined)} />
            ) : null}
            <Button
              title={t(composing ? 'merge.queue' : 'merge.manage')}
              variant="tonal"
              disabled={busy}
              onPress={() => {
                setComposing(!composing);
                setPreviewIds([]);
                setReviewing(null);
                setSelected([]);
                setReason('');
              }}
            />
            {effectiveOffline ? <OfflineState reason="offline" /> : null}
            {composing && !previewIds.length ? (
              <>
                <AccessibleTextInput
                  accessibilityLabel={t('merge.search')}
                  placeholder={t('merge.search')}
                  value={search}
                  onChangeText={setSearch}
                  style={[styles.input, { color: systemColors.label, borderColor: systemColors.separator }]}
                />
                <Button title={t('merge.searchAction')} onPress={() => setQuery(search.trim())} disabled={busy} />
                <Text>{t('merge.selectionHint')}</Text>
                {selected.length ? <Text>{selected.map((board) => board.name).join(' / ')}</Text> : null}
                <Button
                  title={t('merge.preview')}
                  disabled={busy || selected.length < 2 || effectiveOffline}
                  onPress={() => setPreviewIds(selected.map((board) => board.uuid))}
                />
              </>
            ) : null}
            {!composing ? (
              <>
                <RadioGroup
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: 'open', label: t('merge.statusOpen') },
                    { value: 'approved', label: t('merge.statusApproved') },
                    { value: 'rejected', label: t('merge.statusRejected') },
                    { value: 'superseded', label: t('merge.statusSuperseded') },
                    { value: '', label: t('merge.allStatuses') },
                  ]}
                />
                <AppMenu
                  label={boardType ? boardTypeLabel(boardType) : t('merge.allBoardTypes')}
                  accessibilityLabel={t('merge.boardTypeFilter')}
                  actions={boardTypeActions}
                  onSelectIndex={selectBoardType}
                />
              </>
            ) : null}
            {previewIds.length ? (
              <>
                {preview.isPending ? <ActivityIndicator /> : null}
                {preview.isError ? (
                  <View style={styles.header}>
                    <Text>{t('merge.incompatible')}</Text>
                    <Button title={t('merge.retry')} onPress={() => void preview.refetch()} />
                  </View>
                ) : null}
                {preview.data ? (
                  <>
                    <Text variant="headline">{t('merge.selectSurvivor')}</Text>
                    <View pointerEvents={busy ? 'none' : 'auto'}>
                      <RadioGroup options={survivorOptions} value={chosenCanonical} onChange={setCanonical} />
                    </View>
                    <Text>{t('merge.keptDetails')}</Text>
                    <Text>{t('merge.kioskWarning')}</Text>
                    <AccessibleTextInput
                      accessibilityLabel={t('merge.reason')}
                      placeholder={t('merge.reasonHint')}
                      value={reason}
                      onChangeText={setReason}
                      multiline
                      maxLength={500}
                      editable={!busy}
                      style={[styles.input, { color: systemColors.label, borderColor: systemColors.separator }]}
                    />
                    {preview.data.reason ? <Text>{preview.data.reason}</Text> : null}
                    <Button
                      title={t(reviewing ? 'merge.approve' : preview.data.canMerge ? 'merge.merge' : 'merge.request')}
                      onPress={() => void submit()}
                      loading={busy}
                      disabled={
                        busy ||
                        effectiveOffline ||
                        preview.isFetching ||
                        preview.isError ||
                        reason.trim().length < 10 ||
                        (!!reviewing && !preview.data.canMerge)
                      }
                    />
                  </>
                ) : null}
                <Button
                  title={t('merge.cancel')}
                  variant="outlined"
                  disabled={busy}
                  onPress={() => {
                    setPreviewIds([]);
                    setReviewing(null);
                  }}
                />
              </>
            ) : null}
            {!previewIds.length && pending && !effectiveOffline ? <ActivityIndicator /> : null}
            {!previewIds.length && error ? <Button title={t('merge.retry')} onPress={refresh} /> : null}
          </View>
        }
        ListEmptyComponent={
          !pending && !previewIds.length ? <Text style={styles.header}>{t('merge.empty')}</Text> : null
        }
        contentContainerStyle={styles.content}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingBottom: spacing[8] },
  header: { padding: spacing[4], gap: spacing[3] },
  card: {
    marginHorizontal: spacing[4],
    marginBottom: spacing[3],
    padding: spacing[4],
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    gap: spacing[2],
  },
  actions: { flexDirection: 'row', gap: spacing[3] },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: borderRadius.md, padding: spacing[3], minHeight: 48 },
});

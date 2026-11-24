import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { focusManager, onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_GYM_CLIMB_RANKINGS,
  GET_GYM_CLIMB_RANKING_TARGET,
  GYM_CLIMB_RANKINGS_QUERY_SEGMENT,
  GYM_REPORTING_RECEIPT_MS,
  GymReportingViewerChangedError,
  gymReportingQueryOptions,
  gymReportingQueryPrefix,
  isGymReportingAccessError,
  retireGymReportingReceipt,
  type GetGymClimbRankingsResponse,
  type GetGymClimbRankingTargetResponse,
} from '@boardsesh/graphql';
import type {
  GymClimbRankingInput,
  GymClimbRankingMode,
  GymClimbRankingRow,
  GymClimbRankings,
  GymClimbRankingStatus,
  GymClimbRankingTarget,
  GymClimbRankingTargetInput,
  GymStatsInput,
} from '@boardsesh/shared-schema';
import { denyGymReportingReceipts } from './use-gym-grade-comparison';

const PAGE_SIZE = 20;
const MAX_ROWS = 200;
const NO_ROWS: GymClimbRankingRow[] = [];

export type GymClimbRankingRequest = <Result>(
  document: string,
  variables: { input: GymClimbRankingInput | GymClimbRankingTargetInput },
  signal?: AbortSignal,
) => Promise<Result>;

type RankingsOptions = GymStatsInput & {
  viewerId: string;
  credentialEpoch: number;
  isCredentialCurrent: () => boolean;
  overviewGymUuid?: string;
  active: boolean;
  mode: GymClimbRankingMode;
  request: GymClimbRankingRequest;
};

type Receipt = {
  report: GymClimbRankings;
  expiresAt: number;
  group: symbol;
};

const isOnline = () => onlineManager.isOnline();
const isFocused = () => focusManager.isFocused();
const serverEpoch = () => 0;

let environmentEpoch = 0;
let unsubscribe: (() => void) | undefined;
const environmentListeners = new Set<() => void>();

export function subscribeGymRankingEnvironment(listener: () => void) {
  if (!unsubscribe) {
    const changed = () => {
      environmentEpoch += 1;
      for (const notify of environmentListeners) notify();
    };
    const removeOnline = onlineManager.subscribe(changed);
    const removeFocus = focusManager.subscribe(changed);
    unsubscribe = () => {
      removeOnline();
      removeFocus();
    };
  }
  environmentListeners.add(listener);
  return () => {
    environmentListeners.delete(listener);
    if (environmentListeners.size === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}

export const captureGymRankingEnvironment = () => environmentEpoch;

export const isGymRankingEnvironmentCurrent = (captured: number) =>
  captured === captureGymRankingEnvironment() && isOnline() && isFocused();

export const gymClimbRankingsQueryKey = (
  viewerId: string,
  credentialEpoch: number,
  { gymUuid, boardUuid, period, mode }: GymClimbRankingInput,
  connectionEpoch: number,
) =>
  [
    ...gymReportingQueryPrefix(viewerId, gymUuid),
    GYM_CLIMB_RANKINGS_QUERY_SEGMENT,
    credentialEpoch,
    connectionEpoch,
    boardUuid ?? null,
    period,
    mode,
  ] as const;

function failedRanking(mode: GymClimbRankingMode, status: GymClimbRankingStatus): GymClimbRankings {
  return {
    mode,
    status,
    quietAvailable: false,
    asOf: null,
    startAt: null,
    timeZone: null,
    timeZoneConfigured: false,
    rows: [],
    nextCursor: null,
    truncated: false,
  };
}

function matchesTarget(ranked: GymClimbRankingTarget, current: GymClimbRankingTarget) {
  return (
    current.logicalBoardUuid === ranked.logicalBoardUuid &&
    current.boardType === ranked.boardType &&
    current.layoutId === ranked.layoutId &&
    current.sizeId === ranked.sizeId &&
    current.setIds === ranked.setIds &&
    current.climbUuid === ranked.climbUuid &&
    current.angle === ranked.angle &&
    current.isMirror === ranked.isMirror
  );
}

export type GymClimbRankingsViewState = GymClimbRankingStatus | 'LOADING' | 'OFFLINE' | 'DENIED';

export function useGymClimbRankings({
  viewerId,
  credentialEpoch,
  isCredentialCurrent,
  gymUuid,
  overviewGymUuid = gymUuid,
  boardUuid,
  period,
  mode,
  active,
  request,
}: RankingsOptions) {
  const client = useQueryClient();
  const connectionEpoch = useSyncExternalStore(
    subscribeGymRankingEnvironment,
    captureGymRankingEnvironment,
    serverEpoch,
  );
  const online = isOnline();
  const enabled = active && isGymRankingEnvironmentCurrent(connectionEpoch) && isCredentialCurrent();
  const input = useMemo(() => ({ gymUuid, boardUuid, period, mode }), [gymUuid, boardUuid, period, mode]);
  const key = useMemo(
    () => gymClimbRankingsQueryKey(viewerId, credentialEpoch, input, connectionEpoch),
    [viewerId, credentialEpoch, input, connectionEpoch],
  );
  const prefixes = useMemo(
    () => [...new Set([gymUuid, overviewGymUuid])].map((uuid) => gymReportingQueryPrefix(viewerId, uuid)),
    [gymUuid, overviewGymUuid, viewerId],
  );

  const deny = useCallback(
    (error: unknown, rejectingKey?: typeof key) => denyGymReportingReceipts(client, prefixes, error, rejectingKey),
    [client, prefixes],
  );
  const query = useQuery({
    ...gymReportingQueryOptions,
    enabled,
    queryKey: key,
    structuralSharing: false,
    meta: { persist: false },
    queryFn: async ({ signal }): Promise<Receipt> => {
      const expiresAt = Date.now() + GYM_REPORTING_RECEIPT_MS;
      try {
        if (!isCredentialCurrent()) throw new GymReportingViewerChangedError();
        if (!isGymRankingEnvironmentCurrent(connectionEpoch)) throw new Error('Ranking read was superseded');
        const { gymClimbRankings: reply } = await request<GetGymClimbRankingsResponse>(
          GET_GYM_CLIMB_RANKINGS,
          { input },
          signal,
        );
        if (signal.aborted || !isGymRankingEnvironmentCurrent(connectionEpoch))
          throw new Error('Ranking read was superseded');
        if (!isCredentialCurrent()) throw new GymReportingViewerChangedError();
        const report =
          reply.status === 'READY'
            ? { ...reply, rows: reply.rows.slice(0, PAGE_SIZE) }
            : { ...reply, rows: [], nextCursor: null };
        return { report, expiresAt, group: Symbol() };
      } catch (error) {
        if (!signal.aborted && isGymReportingAccessError(error)) deny(error, key);
        throw error;
      }
    },
  });

  const pageRequest = useRef<AbortController | null>(null);
  const targetRequest = useRef<AbortController | null>(null);
  const targetGeneration = useRef(0);
  const [paging, setPaging] = useState(false);
  const [opening, setOpening] = useState(false);
  const scope = useRef<object | null>(null);

  const cancelActions = useCallback(() => {
    targetGeneration.current += 1;
    pageRequest.current?.abort();
    pageRequest.current = null;
    targetRequest.current?.abort();
    targetRequest.current = null;
    setPaging(false);
    setOpening(false);
  }, []);

  const retire = useCallback(() => retireGymReportingReceipt(client, { queryKey: key, exact: true }), [client, key]);

  useLayoutEffect(() => {
    if (!enabled) return;
    scope.current = {};
    return () => {
      scope.current = null;
      cancelActions();
      // Mount, focus or a new filter will verify page one.
      const cached = client.getQueryCache().find({ queryKey: key, exact: true });
      if (cached) {
        void cached.cancel({ revert: true });
        cached.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending' });
      }
    };
  }, [cancelActions, client, enabled, key]);

  useLayoutEffect(() => {
    if (query.fetchStatus !== 'idle') cancelActions();
    if (query.error) {
      client.getQueryCache().find({ queryKey: key, exact: true })?.setState({ data: undefined, dataUpdatedAt: 0 });
    }
  }, [cancelActions, client, key, query.error, query.fetchStatus]);

  const expiresAt = query.data?.expiresAt;
  useEffect(() => {
    if (!enabled || expiresAt === undefined) return;
    const timeout = setTimeout(() => void retire(), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [enabled, expiresAt, retire]);

  const getCurrentGroup = useCallback(() => {
    if (!scope.current || !isCredentialCurrent() || !isGymRankingEnvironmentCurrent(connectionEpoch)) return undefined;
    const cached = client.getQueryState<Receipt>(key);
    if (!cached || cached.isInvalidated || cached.fetchStatus !== 'idle' || cached.status !== 'success')
      return undefined;
    const receipt = cached.data;
    return receipt && receipt.report.status === 'READY' && Date.now() < receipt.expiresAt ? receipt : undefined;
  }, [client, connectionEpoch, isCredentialCurrent, key]);

  const loadMore = useCallback(async () => {
    const current = getCurrentGroup();
    const cursor = current?.report.nextCursor;
    const startedIn = scope.current;
    if (!current || !cursor || current.report.rows.length >= MAX_ROWS || pageRequest.current) return;

    const controller = new AbortController();
    pageRequest.current = controller;
    setPaging(true);
    const isCurrent = () => !controller.signal.aborted && scope.current === startedIn && getCurrentGroup() === current;

    try {
      const { gymClimbRankings: page } = await request<GetGymClimbRankingsResponse>(
        GET_GYM_CLIMB_RANKINGS,
        { input: { ...input, cursor } },
        controller.signal,
      );
      if (!isCurrent()) return;
      const validPage =
        page.mode === current.report.mode &&
        page.asOf === current.report.asOf &&
        page.rows.length <= PAGE_SIZE &&
        page.rows.every(({ rank }, index) => rank === current.report.rows.length + index + 1);
      const report =
        page.status !== 'READY'
          ? { ...page, rows: [], nextCursor: null }
          : validPage
            ? { ...page, rows: [...current.report.rows, ...page.rows].slice(0, MAX_ROWS) }
            : failedRanking(mode, 'PAGE_CHANGED');
      client.setQueryData<Receipt>(key, { ...current, report });
    } catch (error) {
      if (!isCurrent()) return;
      if (isGymReportingAccessError(error)) deny(error);
      else client.setQueryData<Receipt>(key, { ...current, report: failedRanking(mode, 'TEMPORARILY_UNAVAILABLE') });
    } finally {
      if (pageRequest.current === controller) {
        pageRequest.current = null;
        setPaging(false);
      }
    }
  }, [client, deny, getCurrentGroup, input, key, mode, request]);

  const resolveTarget = useCallback(
    async <Result>(
      row: GymClimbRankingRow,
      read: (target: GymClimbRankingTarget, signal: AbortSignal) => Promise<Result>,
    ) => {
      const current = getCurrentGroup();
      const startedIn = scope.current;
      if (!current?.report.rows.includes(row)) return null;
      targetRequest.current?.abort();
      const generation = ++targetGeneration.current;
      const controller = new AbortController();
      targetRequest.current = controller;
      setOpening(true);
      const hasGroup = () =>
        generation === targetGeneration.current &&
        scope.current === startedIn &&
        getCurrentGroup()?.group === current.group;
      try {
        const { logicalBoardUuid, climbUuid, angle, isMirror } = row.target;
        const { gymClimbRankingTarget: target } = await request<GetGymClimbRankingTargetResponse>(
          GET_GYM_CLIMB_RANKING_TARGET,
          { input: { gymUuid, boardUuid, period, logicalBoardUuid, climbUuid, angle, isMirror } },
          controller.signal,
        );
        if (controller.signal.aborted || !hasGroup()) return null;
        if (!target || !matchesTarget(row.target, target)) throw new Error('Ranking target changed');
        const result = await read(target, controller.signal);
        if (controller.signal.aborted || !hasGroup()) return null;
        return { result, expiresAt: current.expiresAt, isCurrent: hasGroup };
      } catch (error) {
        if (controller.signal.aborted || !hasGroup()) return null;
        if (isGymReportingAccessError(error)) deny(error);
        else void retire();
        throw error;
      } finally {
        if (targetRequest.current === controller) {
          targetRequest.current = null;
          setOpening(false);
        }
      }
    },
    [boardUuid, deny, getCurrentGroup, gymUuid, period, request, retire],
  );

  const receipt = query.data;
  const report =
    enabled &&
    query.isFetchedAfterMount &&
    query.fetchStatus === 'idle' &&
    !query.error &&
    receipt &&
    Date.now() < receipt.expiresAt
      ? receipt.report
      : undefined;
  const state: GymClimbRankingsViewState = !online
    ? 'OFFLINE'
    : isGymReportingAccessError(query.error)
      ? 'DENIED'
      : query.error
        ? 'TEMPORARILY_UNAVAILABLE'
        : (report?.status ?? 'LOADING');
  const ready = state === 'READY' && report;
  return {
    state,
    report,
    rows: ready ? report.rows : NO_ROWS,
    canLoadMore: Boolean(ready && report.nextCursor && report.rows.length < MAX_ROWS),
    paging,
    opening,
    loadMore,
    resolveTarget,
    retry: retire,
  };
}

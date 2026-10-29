'use client';

import { useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CncOrder, CncOrderStatus } from '@boardsesh/shared-schema';
import {
  GET_CNC_ORDER,
  type GetCncOrderQueryResponse,
  type GetCncOrderQueryVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { cncErrorKey, type CncErrorKey } from './cnc-error';

/**
 * Watch one build-plans order until it stops moving.
 *
 * Both halves of the lifecycle have a wait in them — the free preview and the
 * paid pack — and both are watched the same way, so the order page and the
 * configurator's preview step share this rather than each growing their own
 * polling loop that stops on a different set of statuses.
 *
 * The two callers start from different places: the order page always has a
 * server-rendered `initialOrder` in hand, while the configurator starts from a
 * licence id alone — the one restored from a draft after a reload, before
 * anything else is known about it. `initialOrder` stays optional so the second
 * case never has to invent a fake order just to satisfy the type.
 */

/**
 * How often an unfinished order is re-checked.
 *
 * A pack takes a couple of minutes to cut and a preview about fifteen seconds,
 * so five seconds is fast enough that neither wait feels stuck and slow enough
 * that a buyer leaving the tab open over lunch costs a few hundred requests,
 * not a few hundred thousand.
 */
export const ORDER_POLL_INTERVAL_MS = 5_000;

/**
 * Statuses that are still moving on their own.
 *
 * The two `preview_*` waits are here for the same reason the paid ones are: the
 * generator has the job and the page has nothing to do but ask again.
 *
 * `pending_payment` is the subtle case — it moves only when Stripe's webhook
 * lands, which happens within seconds of a successful checkout, so it is polled
 * too. What is deliberately excluded is every status that needs a HUMAN:
 * `preview_ready` waits on the buyer finalising, and `ready`, `failed`,
 * `preview_failed`, `cancelled` and `refunded` never change again on their own.
 */
const LIVE_STATUSES: readonly CncOrderStatus[] = [
  'preview_queued',
  'preview_generating',
  'pending_payment',
  'queued',
  'generating',
];

/**
 * The React Query `refetchInterval` for one status: a number while the order is
 * still moving, `false` once it has settled.
 *
 * Exported because "does polling actually stop at `preview_ready`" is the
 * question worth a test, and asserting it against a pure function beats waiting
 * on timers around a mounted component.
 */
export function orderRefetchInterval(status: CncOrderStatus): number | false {
  return LIVE_STATUSES.includes(status) ? ORDER_POLL_INTERVAL_MS : false;
}

/**
 * How many polls in a row may answer `null` before the page gives up.
 *
 * `cncOrder` answers null for a licence that has been revoked or handed to
 * somebody else, but also for a blip — a token that is mid-refresh, a backend
 * that dropped one request. One null must not settle the page forever on an
 * order that is still generating, and an endless retry on a genuinely gone
 * order is just as wrong, so a handful of consecutive misses ends it.
 */
export const MAX_CONSECUTIVE_NULL_POLLS = 5;

/**
 * The React Query `refetchInterval` for the next tick.
 *
 * Deliberately driven by the LAST KNOWN status rather than the current
 * response: a transient `null` carries no status at all, and reading `false`
 * out of it would stop polling permanently on an order that is still moving.
 * A `null` last-known status — the configurator's case, before its first
 * answer has ever landed — keeps polling until the null cap is hit, the same
 * way a genuinely live status would.
 */
export function nextOrderPollInterval(
  lastKnownStatus: CncOrderStatus | null,
  consecutiveNullPolls: number,
): number | false {
  if (consecutiveNullPolls >= MAX_CONSECUTIVE_NULL_POLLS) return false;
  if (lastKnownStatus === null) return ORDER_POLL_INTERVAL_MS;
  return orderRefetchInterval(lastKnownStatus);
}

export type CncOrderPollResult = {
  /**
   * The last order the backend answered with. Null only when there is no
   * `initialOrder` and no answer has landed yet — the configurator's case
   * before a preview has ever been requested.
   */
  order: CncOrder | null;
  /** True while the last poll failed outright, so a page can say so without losing the order. */
  isError: boolean;
  /** The mapped reason the last poll failed, or null while nothing has gone wrong. */
  errorKey: CncErrorKey | null;
  /**
   * Put an order a mutation just returned into the cache, so a page can paint
   * from it immediately and the poll picks up from its status rather than
   * spending a round trip re-fetching what the mutation already answered.
   */
  seedOrder: (order: CncOrder) => void;
};

export function useCncOrderPoll({
  licenceId,
  initialOrder,
  authToken,
  enabled,
}: {
  /** The order being watched. Null before a licence exists — nothing to poll yet. */
  licenceId: string | null;
  /** Server-fetched, so the order page's first paint already shows the real status. */
  initialOrder?: CncOrder;
  authToken: string | null;
  /** Lets a caller gate polling on more than "there is a licence id and a token" — e.g. being signed in. */
  enabled: boolean;
}): CncOrderPollResult {
  const queryClient = useQueryClient();

  // Refs, not state: both only ever feed the next poll decision and the
  // fallback render, and bumping React state from inside `queryFn` would
  // re-render the component a second time for every tick.
  const lastKnownOrderRef = useRef<CncOrder | null>(initialOrder ?? null);
  const consecutiveNullPollsRef = useRef(0);

  const query = useQuery({
    queryKey: ['cncOrder', licenceId] as const,
    queryFn: async () => {
      if (!licenceId || !authToken) throw new Error('useCncOrderPoll: queryFn ran without a licence id and token');
      const client = createGraphQLHttpClient(authToken);
      const response = await client.request<GetCncOrderQueryResponse, GetCncOrderQueryVariables>(GET_CNC_ORDER, {
        licenceId,
      });
      const polledOrder = response.cncOrder;
      if (polledOrder) {
        lastKnownOrderRef.current = polledOrder;
        consecutiveNullPollsRef.current = 0;
      } else {
        consecutiveNullPollsRef.current += 1;
      }
      return polledOrder;
    },
    // Without these two the server-rendered order is treated as infinitely old,
    // so React Query refetches it the instant the component mounts — one wasted
    // round trip per page load, on data that was fetched microseconds earlier
    // in the very same request. `staleTime` matches the poll interval because
    // that IS the freshness contract here; `refetchInterval` fires regardless
    // of staleness, so a live order still polls on time. Skipped entirely when
    // there is no `initialOrder` to seed from — the configurator's case.
    ...(initialOrder ? { initialData: initialOrder, initialDataUpdatedAt: () => Date.now() } : {}),
    staleTime: ORDER_POLL_INTERVAL_MS,
    enabled: enabled && licenceId !== null && !!authToken,
    // Re-read from the last known order on every tick, so the moment the order
    // settles the next interval is `false` and the polling stops by itself —
    // while a transient `null` leaves the interval alone.
    refetchInterval: () =>
      nextOrderPollInterval(lastKnownOrderRef.current?.status ?? null, consecutiveNullPollsRef.current),
    // A failed poll is worth one more ask on the next tick, not three in a row
    // inside one: the poll IS the retry here.
    retry: false,
  });

  const seedOrder = useCallback(
    (order: CncOrder) => {
      lastKnownOrderRef.current = order;
      consecutiveNullPollsRef.current = 0;
      queryClient.setQueryData(['cncOrder', order.licenceId], order);
    },
    [queryClient],
  );

  return {
    order: query.data ?? lastKnownOrderRef.current,
    isError: query.isError,
    errorKey: query.error ? cncErrorKey(query.error) : null,
    seedOrder,
  };
}

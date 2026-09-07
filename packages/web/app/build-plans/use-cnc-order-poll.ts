'use client';

import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CncOrder, CncOrderStatus } from '@boardsesh/shared-schema';
import {
  GET_CNC_ORDER,
  type GetCncOrderQueryResponse,
  type GetCncOrderQueryVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

/**
 * Watch one build-plans order until it stops moving.
 *
 * Both halves of the lifecycle have a wait in them — the free preview and the
 * paid pack — and both are watched the same way, so the order page and the
 * configurator's preview step share this rather than each growing their own
 * polling loop that stops on a different set of statuses.
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
 */
export function nextOrderPollInterval(lastKnownStatus: CncOrderStatus, consecutiveNullPolls: number): number | false {
  if (consecutiveNullPolls >= MAX_CONSECUTIVE_NULL_POLLS) return false;
  return orderRefetchInterval(lastKnownStatus);
}

export type CncOrderPollResult = {
  /** Always an order: the last one the backend answered with, seeded by the server render. */
  order: CncOrder;
  /** True while the last poll failed outright, so the page can say so without losing the order. */
  isError: boolean;
};

export function useCncOrderPoll({
  initialOrder,
  token,
}: {
  /** Server-fetched, so the first paint already shows the real status. */
  initialOrder: CncOrder;
  token: string | null;
}): CncOrderPollResult {
  const licenceId = initialOrder.licenceId;

  // Refs, not state: both only ever feed the next poll decision and the
  // fallback render, and bumping React state from inside `queryFn` would
  // re-render the component a second time for every tick.
  const lastKnownOrderRef = useRef<CncOrder>(initialOrder);
  const consecutiveNullPollsRef = useRef(0);

  const query = useQuery({
    queryKey: ['cncOrder', licenceId] as const,
    queryFn: async () => {
      if (!token) throw new Error('useCncOrderPoll: queryFn ran without a token');
      const client = createGraphQLHttpClient(token);
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
    initialData: initialOrder,
    // Without these two the server-rendered order is treated as infinitely old,
    // so React Query refetches it the instant the component mounts — one wasted
    // round trip per page load, on data that was fetched microseconds earlier
    // in the very same request. `staleTime` matches the poll interval because
    // that IS the freshness contract here; `refetchInterval` fires regardless
    // of staleness, so a live order still polls on time.
    initialDataUpdatedAt: () => Date.now(),
    staleTime: ORDER_POLL_INTERVAL_MS,
    enabled: !!token,
    // Re-read from the last known order on every tick, so the moment the order
    // settles the next interval is `false` and the polling stops by itself —
    // while a transient `null` leaves the interval alone.
    refetchInterval: () => nextOrderPollInterval(lastKnownOrderRef.current.status, consecutiveNullPollsRef.current),
  });

  return { order: query.data ?? lastKnownOrderRef.current, isError: query.isError };
}

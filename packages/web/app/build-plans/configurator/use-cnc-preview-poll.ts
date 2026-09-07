'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CncOrder, CncOrderStatus } from '@boardsesh/shared-schema';
import {
  GET_CNC_ORDER,
  type GetCncOrderQueryResponse,
  type GetCncOrderQueryVariables,
} from '@boardsesh/graphql/operations/cnc-packs';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { cncErrorKey, type CncErrorKey } from '../cnc-error';

/**
 * Watch the preview the configurator just asked for until the sheets exist.
 *
 * Local to the configurator rather than shared with the order page, because the
 * two watch different things: the order page always starts from a
 * server-rendered order, while this one starts from a licence id alone — the
 * one restored from a draft after a reload, before anything is known about it.
 * The order page's own poll (`../use-cnc-order-poll`) keeps its `initialOrder`
 * contract; a later change can fold this into it once that signature admits a
 * licence id with no order behind it yet.
 */

/**
 * How often an unfinished preview is re-checked.
 *
 * A preview takes about fifteen seconds to draw, so five is fast enough that
 * the gallery appears while the buyer is still looking at the card, and slow
 * enough that a tab left open over lunch costs a few hundred requests rather
 * than a few hundred thousand.
 */
export const PREVIEW_POLL_INTERVAL_MS = 5_000;

/**
 * The two statuses that move on their own.
 *
 * `preview_ready` and `preview_failed` are both waiting on the BUYER — one for
 * a finalise, the other for a retry — so neither is polled. Nor is anything
 * past `pending_payment`: once the browser has left for Stripe, this component
 * is gone and the order page takes over the watching.
 */
const LIVE_PREVIEW_STATUSES: readonly CncOrderStatus[] = ['preview_queued', 'preview_generating'];

/**
 * The React Query `refetchInterval` for one status: a number while the
 * generator has the job, `false` once the next move belongs to the buyer.
 *
 * Exported because "does polling actually stop at `preview_ready`" is the
 * question worth a test, and asserting it against a pure function beats waiting
 * on timers around a mounted component.
 */
export function previewRefetchInterval(status: CncOrderStatus | null): number | false {
  if (status === null) return PREVIEW_POLL_INTERVAL_MS;
  return LIVE_PREVIEW_STATUSES.includes(status) ? PREVIEW_POLL_INTERVAL_MS : false;
}

export type CncPreviewPollResult = {
  /** The preview order, or null while there is no preview (or none loaded yet). */
  order: CncOrder | null;
  isLoading: boolean;
  errorKey: CncErrorKey | null;
  /**
   * Put the order a mutation just returned into the cache, so the gallery paints
   * from it immediately and the poll picks up from its status rather than
   * spending a round trip re-fetching what the mutation already answered.
   */
  seedOrder: (order: CncOrder) => void;
};

export function useCncPreviewPoll({
  licenceId,
  token,
}: {
  /** The preview being watched. Null before the first preview, and while signed out. */
  licenceId: string | null;
  token: string | null;
}): CncPreviewPollResult {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['cncOrder', licenceId] as const,
    queryFn: async () => {
      if (!licenceId || !token) throw new Error('useCncPreviewPoll: queryFn ran without a licence id and token');
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetCncOrderQueryResponse, GetCncOrderQueryVariables>(GET_CNC_ORDER, {
        licenceId,
      });
      return response.cncOrder;
    },
    enabled: licenceId !== null && token !== null,
    // Driven by the answer in hand rather than by a remembered status: this
    // query only ever watches ONE order, so a null answer (a licence that is
    // gone, or a token mid-refresh) is a reason to ask again, not to stop.
    refetchInterval: (currentQuery) => previewRefetchInterval(currentQuery.state.data?.status ?? null),
    // A preview that failed to load is worth one more ask on the next tick, but
    // not three in a row inside one: the poll IS the retry here.
    retry: false,
  });

  const seedOrder = useCallback(
    (order: CncOrder) => {
      queryClient.setQueryData(['cncOrder', order.licenceId], order);
    },
    [queryClient],
  );

  return {
    order: query.data ?? null,
    isLoading: query.isLoading,
    errorKey: query.error ? cncErrorKey(query.error) : null,
    seedOrder,
  };
}

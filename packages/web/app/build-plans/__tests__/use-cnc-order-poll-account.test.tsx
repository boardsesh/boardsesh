import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CncOrder } from '@boardsesh/shared-schema';
import { useCncOrderPoll } from '../use-cnc-order-poll';

const graphqlRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: graphqlRequest }) }));

function order(overrides: Partial<CncOrder> = {}): CncOrder {
  return {
    id: '1',
    licenceId: 'BS-CNC-K7QM3T',
    tier: 'personal',
    status: 'ready',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: {},
    artwork: [],
    licenseeName: 'Sam Bouldering',
    customerSiteName: null,
    amountCents: 14900,
    currency: 'AUD',
    createdAt: '2026-09-01T02:14:11.402Z',
    paidAt: '2026-09-01T02:15:00.000Z',
    generatedAt: '2026-09-01T02:17:00.000Z',
    zipSizeBytes: 4_200_000,
    downloadCount: 0,
    lastDownloadedAt: null,
    errorMessage: null,
    hasPreview: true,
    previewGeneratedAt: '2026-09-01T02:14:40.000Z',
    previewImages: [],
    configHash: 'a1b2c3',
    ...overrides,
  };
}

describe('order polling account boundaries', () => {
  it('clears refs, rejects SSR reseeding, and ignores late results after switching buyers', async () => {
    let finishOldRequest: ((response: { cncOrder: CncOrder }) => void) | undefined;
    graphqlRequest
      .mockImplementationOnce(
        () =>
          new Promise<{ cncOrder: CncOrder }>((resolve) => {
            finishOldRequest = resolve;
          }),
      )
      .mockResolvedValue({ cncOrder: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    const privateOrder = order({ licenseeName: 'Private buyer A', status: 'generating' });
    const mounted = renderHook(
      ({ ownerId }) =>
        useCncOrderPoll({
          ownerId,
          authSessionId: ownerId,
          authToken: ownerId,
          licenceId: privateOrder.licenceId,
          initialOrder: privateOrder,
          enabled: true,
        }),
      { wrapper: Wrapper, initialProps: { ownerId: 'buyer-a' } },
    );
    expect(mounted.result.current.order?.licenseeName).toBe('Private buyer A');
    void queryClient.invalidateQueries();
    await waitFor(() => expect(finishOldRequest).toBeDefined());
    const seedPreviousBuyer = mounted.result.current.seedOrder;
    mounted.rerender({ ownerId: 'buyer-b' });
    expect(mounted.result.current.order).toBeNull();
    await act(async () => {
      finishOldRequest?.({ cncOrder: privateOrder });
    });
    act(() => seedPreviousBuyer(privateOrder));
    expect(mounted.result.current.order).toBeNull();
    expect(queryClient.getQueryData(['cncOrder', 'buyer-b', 'buyer-b', privateOrder.licenceId])).not.toEqual(
      privateOrder,
    );
  });
});

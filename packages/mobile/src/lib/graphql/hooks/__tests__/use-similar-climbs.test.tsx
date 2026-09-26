// @vitest-environment jsdom
// useSimilarClimbs routes by source: the downloaded board through the local-only
// interceptor, the server directly for an admin, and nothing at all otherwise.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SIMILAR_CLIMBS_QUERY } from '@boardsesh/graphql/operations';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  offlineAwareRequest: vi.fn(),
  source: { source: 'local', isResolving: false } as { source: string; isResolving: boolean },
}));

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../offline-request', () => ({ offlineAwareRequest: mocks.offlineAwareRequest }));
vi.mock('../../../offline/use-catalog-query-source', () => ({
  useCatalogQuerySourceState: () => mocks.source,
}));

import { useSimilarClimbs } from '../use-similar-climbs';

const scope = { boardName: 'kilter', layoutId: 1, sizeId: 10 };
const expectedVariables = {
  input: { boardType: 'kilter', layoutId: 1, sizeId: 10, climbUuid: 'c1', angle: 40, limit: 12 },
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockResolvedValue({ similarClimbs: [{ uuid: 'from-server' }] });
  mocks.offlineAwareRequest.mockResolvedValue({ similarClimbs: [{ uuid: 'from-phone' }] });
});

describe('useSimilarClimbs', () => {
  it('local: reads through the offline interceptor with the size in the input', async () => {
    mocks.source = { source: 'local', isResolving: false };
    const { result } = renderHook(() => useSimilarClimbs(scope, 'c1', 40), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ uuid: 'from-phone' }]));
    expect(mocks.offlineAwareRequest).toHaveBeenCalledWith(SIMILAR_CLIMBS_QUERY, expectedVariables);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(result.current.source).toBe('local');
  });

  it('network (admin): asks the server directly', async () => {
    mocks.source = { source: 'network', isResolving: false };
    const { result } = renderHook(() => useSimilarClimbs(scope, 'c1', 40), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ uuid: 'from-server' }]));
    expect(mocks.request).toHaveBeenCalledWith(SIMILAR_CLIMBS_QUERY, expectedVariables);
    expect(mocks.offlineAwareRequest).not.toHaveBeenCalled();
  });

  it('download: runs no query at all', async () => {
    mocks.source = { source: 'download', isResolving: false };
    const { result } = renderHook(() => useSimilarClimbs(scope, 'c1', 40), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.source).toBe('download');
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.offlineAwareRequest).not.toHaveBeenCalled();
  });
});

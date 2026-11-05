// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GET_MY_PROJECT_NEWS_EMAIL_CONSENT,
  SET_PROJECT_NEWS_EMAIL_CONSENT,
} from '@boardsesh/graphql/operations/project-news-email';

const state = vi.hoisted(() => ({
  offline: false,
  viewerId: 'viewer' as string | undefined,
  credentialGeneration: 1,
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../../client', () => ({
  getHttpClient: () => ({
    request: (document: unknown, variables?: unknown) => {
      if (typeof document === 'object' && document !== null && 'document' in document) {
        if (document.document === GET_MY_PROJECT_NEWS_EMAIL_CONSENT) return state.read();
      }
      if (document === SET_PROJECT_NEWS_EMAIL_CONSENT) return state.write(variables);
      throw new Error('unexpected request');
    },
  }),
}));
vi.mock('../index', () => ({ useProfile: () => ({ data: state.viewerId ? { id: state.viewerId } : undefined }) }));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => state.credentialGeneration,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.credentialGeneration,
}));
vi.mock('../../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: state.offline }),
}));
import { useProjectNewsEmailConsent, useSetProjectNewsEmailConsent } from '../use-project-news-email';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

beforeEach(() => {
  state.offline = false;
  state.viewerId = 'viewer';
  state.credentialGeneration = 1;
  state.read.mockReset();
  state.write.mockReset();
});

describe('useProjectNewsEmailConsent', () => {
  it('reads the account answer for the signed-in climber', async () => {
    state.read.mockResolvedValue({ myProjectNewsEmailConsent: { subscribed: false, decidedAt: null } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectNewsEmailConsent(true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ subscribed: false, decidedAt: null }));
  });

  it('asks nothing while hidden', () => {
    const { wrapper } = setup();
    renderHook(() => useProjectNewsEmailConsent(false), { wrapper });
    expect(state.read).not.toHaveBeenCalled();
  });
});

describe('useSetProjectNewsEmailConsent', () => {
  it('sends the platform as the source and stores the answer for this climber', async () => {
    const saved = { subscribed: true, decidedAt: '2026-11-20T10:00:00.000Z' };
    state.write.mockResolvedValue({ setProjectNewsEmailConsent: saved });
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useSetProjectNewsEmailConsent(), { wrapper });
    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(state.write).toHaveBeenCalledWith({ input: { subscribed: true, source: 'ios' } });
    expect(queryClient.getQueryData(['projectNewsEmailConsent', 'viewer'])).toEqual(saved);
    expect(result.current.isError).toBe(false);
  });

  it('refuses to write offline', async () => {
    state.offline = true;
    const { wrapper } = setup();
    const { result } = renderHook(() => useSetProjectNewsEmailConsent(), { wrapper });
    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(state.write).not.toHaveBeenCalled();
  });

  it('does not store an answer that landed after the climber signed out', async () => {
    let finish: (value: unknown) => void = () => undefined;
    state.write.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useSetProjectNewsEmailConsent(), { wrapper });
    act(() => result.current.mutate(true));
    await waitFor(() => expect(state.write).toHaveBeenCalled());
    state.credentialGeneration = 2;
    await act(async () => finish({ setProjectNewsEmailConsent: { subscribed: true, decidedAt: 'x' } }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(['projectNewsEmailConsent', 'viewer'])).toBeUndefined();
  });
});

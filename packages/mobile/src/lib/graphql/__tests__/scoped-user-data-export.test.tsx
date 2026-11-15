// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDataExportStatus } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../http-query-scope';
import type { UserDataExportDownloadRequest } from '../../user-data-export-action';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  generation: 1,
  openDownload: vi.fn<(request: UserDataExportDownloadRequest) => Promise<void>>(),
}));
vi.mock('../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing export fixture');
    return selected.scope;
  },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => false }));
vi.mock('../../app-visibility', () => ({ useIsAppBackgrounded: () => false }));
vi.mock('../../auth-store', () => ({
  captureAuthCredentialGeneration: () => selected.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === selected.generation,
}));
vi.mock('../../user-data-export-download', () => ({ openUserDataExportDownload: selected.openDownload }));
import { createScopedHttpFixture } from './fixtures/scoped-http';
import { useUserDataExport, userDataExportQueryKey } from '../hooks/use-user-data-export';
import { isGraphqlRateLimitedError } from '../extract-error-message';

const closeFixtures: (() => void)[] = [];
function exportStatus(status: UserDataExportStatus['status'] = 'not_requested'): UserDataExportStatus {
  return { boardType: 'tension', period: '2026-W46', status, files: [], refreshAt: '2099-01-01T00:00:00Z' };
}
function documentFrom(options: unknown): string {
  return (JSON.parse((options as RequestInit).body as string) as { query: string }).query;
}
function heldResponse(payload: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: payload })));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  http.performFetch.mockImplementation(async (_input, options) => {
    const document = documentFrom(options);
    if (document.includes('userDataExportDownload'))
      return Response.json({
        data: {
          userDataExportDownload: {
            url: 'https://private.example.test/archive?signature=owned-A',
            filename: 'tension.json',
            expiresAt: '2099-01-01T00:00:00Z',
          },
        },
      });
    return Response.json({ data: { userDataExport: exportStatus(), viewer: { id: 'owned-A' } } });
  });
  return { ...http, cache, wrapper };
}
beforeEach(() => {
  selected.generation = 1;
  selected.openDownload.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
});

describe('original export operations with the installed SDK', () => {
  it.each(['B', 'ABA'] as const)(
    'rejects a delayed status body after %s without populating either private cache',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      const held = heldResponse({ userDataExport: exportStatus('failed') });
      current.performFetch.mockResolvedValueOnce(held.response);
      const { result, rerender } = renderHook(({ userId }) => useUserDataExport(userId, 'tension'), {
        ...current,
        initialProps: { userId: 'owned-A' },
      });
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      rerender({ userId: change === 'B' ? 'owned-B' : 'owned-A' });
      await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
      await act(async () => held.release());
      expect(result.current.statusQuery.data?.status).toBe('not_requested');
      expect(current.cache.getQueryData(original.key(userDataExportQueryKey('owned-A', 1, 'tension')))).toBeUndefined();
    },
  );

  it.each(['B', 'ABA'] as const)(
    'keeps held generation and captured callbacks on their original %s view',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      const held = heldResponse({ requestUserDataExport: exportStatus('generating') });
      const { result, rerender } = renderHook(({ userId }) => useUserDataExport(userId, 'tension'), {
        ...current,
        initialProps: { userId: 'owned-A' },
      });
      await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
      const originalRequest = result.current.requestMutation.mutateWithReceipt;
      current.performFetch.mockResolvedValueOnce(held.response);
      let outcome!: Promise<unknown>;
      await act(async () => {
        outcome = originalRequest().catch((error: unknown) => error);
      });
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      rerender({ userId: change === 'B' ? 'owned-B' : 'owned-A' });
      await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
      await act(async () => held.release());
      expect(await outcome).toBeInstanceOf(Error);
      expect(result.current.statusQuery.data?.status).toBe('not_requested');
      expect(
        current.cache.getQueryData(original.key(userDataExportQueryKey('owned-A', 1, 'tension', '2026-W46'))),
      ).toBeUndefined();
      const calls = current.performFetch.mock.calls.length;
      await expect(originalRequest()).rejects.toThrow();
      expect(current.performFetch).toHaveBeenCalledTimes(calls);
    },
  );

  it('does not restore public dispatch or send an export while admission is unavailable', async () => {
    const current = fixture();
    current.backend.retire();
    selected.scope = current.scope();
    const { result } = renderHook(() => useUserDataExport('offline-owned-A', 'tension'), current);
    await act(async () => {
      await Promise.resolve();
      await expect(result.current.requestMutation.mutateWithReceipt()).rejects.toThrow();
      await expect(
        result.current.downloadMutation.mutateWithReceipt({ period: '2026-W46', format: 'boardsesh' }),
      ).rejects.toThrow();
    });
    expect(result.current.statusQuery.fetchStatus).toBe('idle');
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(current.issueLease).not.toHaveBeenCalled();
  });

  it('retains the original link receipt through a later platform await despite a new same-owner lease', async () => {
    const current = fixture();
    let release!: () => void;
    let platformRequest!: UserDataExportDownloadRequest;
    selected.openDownload.mockImplementation((request) => {
      platformRequest = request;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const { result } = renderHook(() => useUserDataExport('owned-A', 'tension'), current);
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    let outcome!: Promise<unknown>;
    await act(async () => {
      outcome = result.current.downloadMutation
        .mutateWithReceipt({ period: '2026-W46', format: 'boardsesh' })
        .catch((error: unknown) => error);
    });
    await waitFor(() => expect(platformRequest).toBeDefined());
    expect(platformRequest.isCurrent()).toBe(true);
    current.clock(120_001);
    await current.scope().run((operation) => operation.request('query CurrentLease { viewer { id } }'));
    expect(current.issueLease).toHaveBeenCalledTimes(2);
    expect(platformRequest.isCurrent()).toBe(false);
    await act(async () => release());
    expect(await outcome).toMatchObject({ reason: 'session_changed' });
    const cached = [...current.cache.getQueryCache().getAll(), ...current.cache.getMutationCache().getAll()].map(
      (entry) => entry.state,
    );
    expect(JSON.stringify(cached)).not.toContain('signature=');
    expect(
      current.performFetch.mock.calls.filter(([, options]) => documentFrom(options).includes('userDataExportDownload')),
    ).toHaveLength(1);
  });

  it('returns a current success receipt without storing private platform input', async () => {
    const current = fixture();
    const { result } = renderHook(() => useUserDataExport('owned-A', 'tension'), current);
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    let receipt!: Awaited<ReturnType<typeof result.current.downloadMutation.mutateWithReceipt>>;
    await act(async () => {
      receipt = await result.current.downloadMutation.mutateWithReceipt({ period: '2026-W46', format: 'boardsesh' });
    });
    expect(receipt.result).toBeUndefined();
    expect(() => receipt.assertCurrent()).not.toThrow();
    expect(selected.openDownload).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(
        current.cache
          .getMutationCache()
          .getAll()
          .map((entry) => entry.state),
      ),
    ).not.toContain('signature=');
    current.switchAccount('owned-B');
    expect(() => receipt.assertCurrent()).toThrow();
  });

  it('retires the actual download before the removing parent layout effect', async () => {
    const current = fixture();
    let release!: () => void;
    let platformRequest!: UserDataExportDownloadRequest;
    let exportHook!: ReturnType<typeof useUserDataExport>;
    let observed: { current: boolean; aborted: boolean } | undefined;
    selected.openDownload.mockImplementation((request) => {
      platformRequest = request;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    function DownloadOwner() {
      exportHook = useUserDataExport('owned-A', 'tension');
      return null;
    }
    function Parent({ shown }: { shown: boolean }) {
      useLayoutEffect(() => {
        if (!shown) observed = { current: platformRequest.isCurrent(), aborted: platformRequest.signal.aborted };
      }, [shown]);
      return shown ? <DownloadOwner /> : null;
    }
    const rendered = render(<Parent shown />, current);
    await waitFor(() => expect(exportHook.statusQuery.isSuccess).toBe(true));
    let outcome!: Promise<unknown>;
    await act(async () => {
      outcome = exportHook.downloadMutation
        .mutateWithReceipt({ period: '2026-W46', format: 'boardsesh' })
        .catch((error: unknown) => error);
    });
    await waitFor(() => expect(platformRequest).toBeDefined());
    rendered.rerender(<Parent shown={false} />);
    expect(observed).toEqual({ current: false, aborted: true });
    await act(async () => release());
    expect(await outcome).toMatchObject({ reason: 'session_changed' });
  });

  it.each(['RATE_LIMITED', 'UNKNOWN'])(
    'redacts partial SDK link failures while preserving %s classification',
    async (code) => {
      const current = fixture();
      const { result } = renderHook(() => useUserDataExport('owned-A', 'tension'), current);
      await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
      current.performFetch.mockResolvedValueOnce(
        Response.json({
          data: {
            userDataExportDownload: {
              url: 'https://private.example.test/archive?signature=private-error',
              filename: 'tension.json',
              expiresAt: '2099-01-01T00:00:00Z',
            },
          },
          errors: [{ message: 'private-error-message', extensions: { code } }],
        }),
      );
      let failure: unknown;
      await act(async () => {
        failure = await result.current.downloadMutation
          .mutateAsync({ period: '2026-W46', format: 'boardsesh' })
          .catch((error: unknown) => error);
      });
      expect(failure).toBeInstanceOf(Error);
      expect(JSON.stringify(failure)).not.toContain('private-error');
      expect((failure as Error).message).not.toContain('private-error');
      expect(isGraphqlRateLimitedError(failure)).toBe(code === 'RATE_LIMITED');
      expect(
        JSON.stringify(
          current.cache
            .getMutationCache()
            .getAll()
            .map((entry) => entry.state),
        ),
      ).not.toContain('private-error');
      expect(selected.openDownload).not.toHaveBeenCalled();
    },
  );
});

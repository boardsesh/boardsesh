// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../http-query-scope';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
const local = vi.hoisted(() => ({ ready: vi.fn(), remove: vi.fn() }));
vi.mock('../use-http-query-scope', () => ({ useHttpQueryScope: () => selected.scope! }));
vi.mock('../../auth-store', () => ({
  captureAuthCredentialGeneration: () => 7,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../../offline/assert-climb-delete-ready', () => ({ assertClimbDeleteReady: local.ready }));
vi.mock('../../../offline/remove-deleted-climb', () => ({ removeDeletedClimbFromDevice: local.remove }));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
import { createScopedHttpFixture } from './fixtures/scoped-http';
import { useDeleteClimb } from '../hooks/use-delete-climb';
import { useDeleteDraftClimb } from '../hooks/use-delete-draft-climb';

const closeFixtures: (() => void)[] = [];
beforeEach(() => {
  local.ready.mockReset().mockResolvedValue(undefined);
  local.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
  vi.restoreAllMocks();
});
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, wrapper };
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
const variables = { uuid: 'owned-test-climb', boardType: 'kilter' } as const;
const hooks = { climb: useDeleteClimb, draft: useDeleteDraftClimb };

describe.each(['climb', 'draft'] as const)('selected %s delete callback fencing (injected local I/O)', (kind) => {
  it.each(['B', 'ABA'] as const)(
    'refuses after held readiness and %s before sending despite unchanged native generation',
    async (change) => {
      const current = fixture();
      let release!: () => void;
      local.ready.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { result, rerender } = renderHook(hooks[kind], current);
      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.mutateAsync(variables);
      });
      const refused = expect(pending).rejects.toThrow();
      await waitFor(() => expect(local.ready).toHaveBeenCalledTimes(1));
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      rerender();
      await act(async () => {
        release();
        await refused;
      });
      expect(current.performFetch).not.toHaveBeenCalled();
      expect(local.remove).not.toHaveBeenCalled();
    },
  );

  it.each(['B', 'expired'] as const)(
    'refuses delayed successful body after %s before local or cache effects',
    async (change) => {
      const current = fixture();
      const held = heldResponse({ deleteClimb: true, deleteDraftClimb: true });
      current.performFetch.mockResolvedValueOnce(held.response);
      const invalidate = vi.spyOn(current.cache, 'invalidateQueries').mockResolvedValue(undefined);
      const { result, rerender } = renderHook(hooks[kind], current);
      let pending!: Promise<unknown>;
      act(() => {
        pending = result.current.mutateAsync(variables);
      });
      const refused = expect(pending).rejects.toThrow();
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
      if (change === 'expired') current.clock(120_001);
      else {
        current.switchAccount('owned-B');
        selected.scope = current.scope();
        rerender();
      }
      await act(async () => {
        held.release();
        await refused;
      });
      expect(invalidate).not.toHaveBeenCalled();
      expect(local.remove).not.toHaveBeenCalled();
    },
  );

  it.each(['B', 'expired'] as const)(
    'keeps local cleanup nonblocking but refuses its late invalidations after %s',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      current.performFetch.mockResolvedValueOnce(
        Response.json({ data: { deleteClimb: true, deleteDraftClimb: true } }),
      );
      let finishLocal!: () => void;
      local.remove.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishLocal = resolve;
          }),
      );
      const invalidate = vi.spyOn(current.cache, 'invalidateQueries').mockResolvedValue(undefined);
      const { result, rerender } = renderHook(hooks[kind], current);
      await act(async () => {
        await result.current.mutateAsync(variables);
      });
      expect(local.remove).toHaveBeenCalledWith(variables, 7);
      expect(invalidate).toHaveBeenCalledTimes(4);
      expect(invalidate.mock.calls.map(([filter]) => filter?.queryKey)).toEqual(
        [['searchClimbs'], ['infiniteSearchClimbs'], ['searchClimbsCount'], ['climb']].map((key) => original.key(key)),
      );
      if (change === 'expired') {
        current.clock(90_000);
        current.performFetch.mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-A' } } }));
        await selected.scope!.run((operation) => operation.request('{ viewer { id } }'));
        current.clock(120_001);
      } else {
        current.switchAccount('owned-B');
        selected.scope = current.scope();
        rerender();
      }
      await act(async () => {
        finishLocal();
        await Promise.resolve();
      });
      expect(invalidate).toHaveBeenCalledTimes(4);
      const requestBody = JSON.parse((current.performFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(requestBody.variables).toEqual(variables);
      expect(requestBody.query).toContain(kind === 'climb' ? 'deleteClimb' : 'deleteDraftClimb');
    },
  );

  it.each(['B', 'expired'] as const)(
    'rechecks original delivery before local cleanup after external first invalidation changes %s',
    async (change) => {
      const current = fixture();
      current.performFetch.mockResolvedValueOnce(
        Response.json({ data: { deleteClimb: true, deleteDraftClimb: true } }),
      );
      vi.spyOn(current.cache, 'invalidateQueries')
        .mockImplementationOnce(async () => {
          if (change === 'expired') current.clock(120_001);
          else {
            current.switchAccount('owned-B');
            selected.scope = current.scope();
          }
        })
        .mockResolvedValue(undefined);
      const { result } = renderHook(hooks[kind], current);
      await act(async () => {
        await expect(result.current.mutateAsync(variables)).rejects.toThrow();
      });
      // This assertion must fail even if the outer mutation later rejects.
      expect(local.remove).not.toHaveBeenCalled();
    },
  );
});

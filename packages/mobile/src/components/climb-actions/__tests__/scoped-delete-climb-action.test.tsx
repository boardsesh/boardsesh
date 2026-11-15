// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  pendingTick: vi.fn<() => Promise<boolean>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  toast: vi.fn(),
  ready: vi.fn<() => Promise<void>>(),
  remove: vi.fn<() => Promise<void>>(),
}));
vi.mock('../../../lib/graphql/use-http-query-scope', () => ({ useHttpQueryScope: () => selected.scope! }));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 7,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('../../../offline/pending-tick', () => ({ hasQueuedTickForClimb: selected.pendingTick }));
vi.mock('../../../offline/assert-climb-delete-ready', () => ({ assertClimbDeleteReady: selected.ready }));
vi.mock('../../../offline/remove-deleted-climb', () => ({ removeDeletedClimbFromDevice: selected.remove }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => selected.confirm }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: selected.toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';
import { useDeleteClimbAction } from '../use-delete-climb-action';

const closeFixtures: (() => void)[] = [];
const climb = { uuid: 'owned-climb' };
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: (result: Result) => resolve(result) };
}
function heldBody() {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: { deleteClimb: true } })));
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
  http.performFetch.mockResolvedValue(Response.json({ data: { deleteClimb: true } }));
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return {
    ...http,
    cache,
    wrapper,
    change(kind: 'B' | 'ABA') {
      http.switchAccount('owned-B');
      if (kind === 'ABA') http.switchAccount('owned-A');
      selected.scope = http.scope();
    },
  };
}
beforeEach(() => {
  selected.pendingTick.mockReset().mockResolvedValue(false);
  selected.confirm.mockReset().mockResolvedValue(true);
  selected.toast.mockReset();
  selected.ready.mockReset().mockResolvedValue(undefined);
  selected.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
});

describe('actual delete action ownership through the SDK', () => {
  it.each(['B', 'ABA'] as const)('refuses an old pending-tick result before confirmation under %s', async (change) => {
    const current = fixture();
    const tick = deferred<boolean>();
    selected.pendingTick.mockReturnValueOnce(tick.promise);
    const hook = renderHook(useDeleteClimbAction, current);
    const onDeleted = vi.fn();
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current(climb, 'kilter', onDeleted);
    });
    await waitFor(() => expect(selected.pendingTick).toHaveBeenCalledOnce());
    current.change(change);
    hook.rerender();
    await act(async () => {
      tick.resolve(false);
      await pending;
    });
    expect(selected.confirm).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(selected.toast).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it.each(['B', 'ABA'] as const)('refuses an old confirmed dialog before dispatch under %s', async (change) => {
    const current = fixture();
    const confirmation = deferred<boolean>();
    selected.confirm.mockReturnValueOnce(confirmation.promise);
    const hook = renderHook(useDeleteClimbAction, current);
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current(climb, 'kilter');
    });
    await waitFor(() => expect(selected.confirm).toHaveBeenCalledOnce());
    current.change(change);
    hook.rerender();
    await act(async () => {
      confirmation.resolve(true);
      await pending;
    });
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(selected.toast).not.toHaveBeenCalled();
  });

  it.each(['B', 'ABA', 'expired'] as const)('refuses a delayed successful body after %s', async (change) => {
    const current = fixture();
    const held = heldBody();
    current.performFetch.mockResolvedValueOnce(held.response);
    const hook = renderHook(useDeleteClimbAction, current);
    const onDeleted = vi.fn();
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current(climb, 'kilter', onDeleted);
    });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
    if (change === 'expired') {
      current.clock(90_000);
      current.performFetch.mockResolvedValueOnce(Response.json({ data: { viewer: { id: 'owned-A' } } }));
      await selected.scope!.run((operation) => operation.request('{ viewer { id } }'));
      current.clock(120_001);
    } else {
      current.change(change);
      hook.rerender();
    }
    await act(async () => {
      held.release();
      await pending;
    });
    expect(selected.toast).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(selected.remove).not.toHaveBeenCalled();
  });

  it('allows a current delete and checks its original receipt again after the success toast', async () => {
    const current = fixture();
    selected.toast.mockImplementationOnce(() => current.change('B'));
    const hook = renderHook(useDeleteClimbAction, current);
    const onDeleted = vi.fn();
    await act(async () => {
      await hook.result.current(climb, 'kilter', onDeleted);
    });
    expect(current.performFetch).toHaveBeenCalledOnce();
    expect(selected.toast).toHaveBeenCalledWith('mobile.climbActions.deleteClimb.success', 'success');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('does not let an old finally clear the next account’s active confirmation', async () => {
    const current = fixture();
    const oldTick = deferred<boolean>();
    const newTick = deferred<boolean>();
    selected.pendingTick.mockReturnValueOnce(oldTick.promise).mockReturnValueOnce(newTick.promise);
    selected.confirm.mockResolvedValue(false);
    const hook = renderHook(useDeleteClimbAction, current);
    let oldAction!: Promise<void>;
    act(() => {
      oldAction = hook.result.current(climb, 'kilter');
    });
    current.change('B');
    hook.rerender();
    let newAction!: Promise<void>;
    act(() => {
      newAction = hook.result.current(climb, 'kilter');
    });
    await act(async () => {
      oldTick.resolve(false);
      await oldAction;
    });
    await act(async () => {
      await hook.result.current(climb, 'kilter');
    });
    expect(selected.pendingTick).toHaveBeenCalledTimes(2);
    await act(async () => {
      newTick.resolve(false);
      await newAction;
    });
    expect(selected.confirm).toHaveBeenCalledOnce();
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it('keeps a current successful delete and continuation usable', async () => {
    const current = fixture();
    const hook = renderHook(useDeleteClimbAction, current);
    const onDeleted = vi.fn();
    await act(async () => {
      await hook.result.current(climb, 'kilter', onDeleted);
    });
    expect(current.performFetch).toHaveBeenCalledOnce();
    expect(selected.toast).toHaveBeenCalledWith('mobile.climbActions.deleteClimb.success', 'success');
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});

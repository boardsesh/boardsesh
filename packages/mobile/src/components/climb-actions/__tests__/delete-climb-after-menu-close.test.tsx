// @vitest-environment jsdom
/**
 * Deleting a climb from a row's long-press menu (#7596 A4, the revert of #7547).
 *
 * The menu's command host unmounts as soon as Delete is picked: the command
 * closes the menu first so the system confirm does not open over it. With #7547
 * the delete flow captured an action scope inside that host, the unmount
 * aborted it, and the flow stopped silently before the confirm. The plain hook
 * has no scope, so the flow it started keeps going after the host is gone.
 *
 * Real HTTP: the delete goes through the real useDeleteClimb mutation and a
 * real GraphQLClient to a local node:http server. The server holds its answer
 * until the host has unmounted.
 */
import { useState, type ReactNode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GraphQLClient } from 'graphql-request';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHeldGraphQLServer,
  settleAfterUnmount,
} from '../../../lib/graphql/__tests__/helpers/held-graphql-server';

const transport = vi.hoisted(() => ({ client: null as GraphQLClient | null }));
const app = vi.hoisted(() => ({
  confirm: vi.fn(async (_options: unknown) => true),
  showToast: vi.fn(),
  // The outbox check reads SQLite on a phone, so it settles after React has
  // committed the menu's unmount. The test resolves it by hand.
  pendingTickCheck: null as null | { resolve: (queued: boolean) => void },
}));

vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => {
    if (!transport.client) throw new Error('The local GraphQL server has not started');
    return transport.client;
  },
  getOfflineSyncHttpClient: () => {
    throw new Error('A climb delete is never sent through the offline client');
  },
}));
vi.mock('../../../offline/pending-tick', () => ({
  hasQueuedTickForClimb: () =>
    new Promise<boolean>((resolve) => {
      app.pendingTickCheck = { resolve };
    }),
}));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => null }));
vi.mock('../../../offline/remove-deleted-climb', () => ({ removeDeletedClimbFromDevice: async () => {} }));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => app.confirm }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: app.showToast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useDeleteClimbAction } from '../use-delete-climb-action';

const server = createHeldGraphQLServer();

beforeAll(async () => {
  transport.client = await server.start();
});

beforeEach(() => {
  app.confirm.mockClear();
  app.showToast.mockClear();
  app.pendingTickCheck = null;
});

afterEach(() => {
  server.releaseAll();
});

afterAll(async () => {
  transport.client = null;
  await server.stop();
});

type StartDelete = ReturnType<typeof useDeleteClimbAction>;

/** Stands in for the menu's command host: it owns the delete hook. */
function CommandHost({ onReady }: { onReady: (startDelete: StartDelete) => void }) {
  onReady(useDeleteClimbAction());
  return null;
}

/** Stands in for the menu provider, which outlives the host. */
function Menu({ children, onClose }: { children: ReactNode; onClose: (close: () => void) => void }) {
  const [open, setOpen] = useState(true);
  onClose(() => setOpen(false));
  return <>{open ? children : null}</>;
}

describe('delete climb from a menu whose host unmounts', () => {
  it('confirms, reaches the server, says so and calls back after the menu has closed', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let startDelete: StartDelete | null = null;
    let closeMenu: () => void = () => {};
    render(
      <QueryClientProvider client={queryClient}>
        <Menu onClose={(close) => (closeMenu = close)}>
          <CommandHost onReady={(start) => (startDelete = start)} />
        </Menu>
      </QueryClientProvider>,
    );
    const onDeleted = vi.fn();

    // The delete command closes the menu, then starts the delete in the same tick.
    let deleteFlow: Promise<void> | undefined;
    act(() => {
      closeMenu();
      deleteFlow = startDelete!({ uuid: 'climb-1' }, 'spray', onDeleted);
    });
    await settleAfterUnmount();
    expect(app.pendingTickCheck).not.toBeNull();

    // The outbox check settles after the host is gone.
    await act(async () => app.pendingTickCheck!.resolve(false));
    await waitFor(() => expect(app.confirm).toHaveBeenCalledTimes(1));

    const held = await server.nextHeldRequest('DeleteClimb');
    expect(held.variables).toEqual({ uuid: 'climb-1', boardType: 'spray' });
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer({ deleteClimb: true });
    await act(async () => {
      await deleteFlow;
    });
    expect(app.showToast).toHaveBeenCalledWith('mobile.climbActions.deleteClimb.success', 'success');
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(server.countOf('DeleteClimb')).toBe(1);
  });
});

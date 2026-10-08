// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Persister } from '@tanstack/react-query-persist-client';
import { SessionCacheBuster } from '../query-client-provider';

function makeFakePersister(): Persister & { removeClient: ReturnType<typeof vi.fn> } {
  return {
    persistClient: vi.fn(async () => {}),
    restoreClient: vi.fn(async () => undefined),
    removeClient: vi.fn(async () => {}),
  };
}

function setup() {
  const persister = makeFakePersister();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const clearSpy = vi.spyOn(queryClient, 'clear');

  function renderWith(sessionUserId: string | null) {
    return render(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId={sessionUserId} />
      </QueryClientProvider>,
    );
  }
  return { persister, queryClient, clearSpy, renderWith };
}

describe('SessionCacheBuster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not wipe on the first effect (initial mount, authenticated)', () => {
    const { persister, clearSpy, renderWith } = setup();
    renderWith('user-1');

    expect(persister.removeClient).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('does not wipe on the first effect (initial mount, unauthenticated)', () => {
    const { persister, clearSpy, renderWith } = setup();
    renderWith(null);

    expect(persister.removeClient).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('does not wipe on the loading → authenticated transition (null → user)', () => {
    const { persister, queryClient, clearSpy, renderWith } = setup();
    const view = renderWith(null);
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId="user-1" />
      </QueryClientProvider>,
    );

    expect(persister.removeClient).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('does not wipe when the user id stays the same', () => {
    const { persister, queryClient, clearSpy, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId="user-1" />
      </QueryClientProvider>,
    );

    expect(persister.removeClient).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('wipes on sign-out (user → null)', async () => {
    const { persister, queryClient, clearSpy, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId={null} />
      </QueryClientProvider>,
    );

    expect(persister.removeClient).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(clearSpy).toHaveBeenCalledTimes(1));
  });

  it('wipes on account switch (user A → user B)', async () => {
    const { persister, queryClient, clearSpy, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId="user-2" />
      </QueryClientProvider>,
    );

    expect(persister.removeClient).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(clearSpy).toHaveBeenCalledTimes(1));
  });

  it('withdraws in-memory projections even when they were never persisted', async () => {
    const { persister, queryClient, renderWith } = setup();
    queryClient.setQueryData(['publicProfile', 'private-user'], { name: 'Withdrawn identity' });
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId={null} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(queryClient.getQueryData(['publicProfile', 'private-user'])).toBeUndefined());
  });
});

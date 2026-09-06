// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Persister } from '@tanstack/react-query-persist-client';
import { CNC_CONFIGURATOR_DRAFT_KEY } from '@/app/build-plans/configurator/configurator-state';
import { SessionCacheBuster } from '../query-client-provider';

const removePreference = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference }));

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
  const removeQueriesSpy = vi.spyOn(queryClient, 'removeQueries');

  function renderWith(sessionUserId: string | null) {
    return render(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId={sessionUserId} />
      </QueryClientProvider>,
    );
  }
  return { persister, queryClient, removeQueriesSpy, renderWith };
}

describe('SessionCacheBuster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removePreference.mockReset();
  });

  it('does not wipe on the first effect (initial mount, authenticated)', () => {
    const { persister, removeQueriesSpy, renderWith } = setup();
    renderWith('user-1');

    expect(persister.removeClient).not.toHaveBeenCalled();
    expect(removeQueriesSpy).not.toHaveBeenCalled();
  });

  it('does not wipe on the first effect (initial mount, unauthenticated)', () => {
    const { persister, removeQueriesSpy, renderWith } = setup();
    renderWith(null);

    expect(persister.removeClient).not.toHaveBeenCalled();
    expect(removeQueriesSpy).not.toHaveBeenCalled();
  });

  it('does not wipe on the loading → authenticated transition (null → user)', () => {
    const { persister, queryClient, removeQueriesSpy, renderWith } = setup();
    const view = renderWith(null);
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId="user-1" />
      </QueryClientProvider>,
    );

    expect(persister.removeClient).not.toHaveBeenCalled();
    expect(removeQueriesSpy).not.toHaveBeenCalled();
  });

  it('does not wipe when the user id stays the same', () => {
    const { persister, queryClient, removeQueriesSpy, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId="user-1" />
      </QueryClientProvider>,
    );

    expect(persister.removeClient).not.toHaveBeenCalled();
    expect(removeQueriesSpy).not.toHaveBeenCalled();
  });

  it('wipes on sign-out (user → null)', () => {
    const { persister, queryClient, removeQueriesSpy, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId={null} />
      </QueryClientProvider>,
    );

    expect(persister.removeClient).toHaveBeenCalledTimes(1);
    expect(removeQueriesSpy).toHaveBeenCalledTimes(1);
    const args = removeQueriesSpy.mock.calls[0][0]!;
    expect(typeof args.predicate).toBe('function');
  });

  it('wipes on account switch (user A → user B)', () => {
    const { persister, queryClient, removeQueriesSpy, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId="user-2" />
      </QueryClientProvider>,
    );

    expect(persister.removeClient).toHaveBeenCalledTimes(1);
    expect(removeQueriesSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the build-plans draft on sign-out (user → null)', () => {
    const { persister, queryClient, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId={null} />
      </QueryClientProvider>,
    );

    // A build-plans draft (a buyer's name and email) sits outside the React
    // Query cache, but it is still per-user state that must not survive into
    // the next signed-out visitor sharing this browser.
    expect(removePreference).toHaveBeenCalledWith(CNC_CONFIGURATOR_DRAFT_KEY);
  });

  it('clears the build-plans draft on account switch (user A → user B)', () => {
    const { persister, queryClient, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId="user-2" />
      </QueryClientProvider>,
    );

    expect(removePreference).toHaveBeenCalledWith(CNC_CONFIGURATOR_DRAFT_KEY);
  });

  it('does not touch the draft on a non-transition (first mount, same user)', () => {
    const { persister, queryClient, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId="user-1" />
      </QueryClientProvider>,
    );

    expect(removePreference).not.toHaveBeenCalled();
  });

  it('removeQueries predicate only matches queries flagged with meta.persist', () => {
    const { persister, queryClient, removeQueriesSpy, renderWith } = setup();
    const view = renderWith('user-1');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <SessionCacheBuster persister={persister} sessionUserId={null} />
      </QueryClientProvider>,
    );

    const predicate = removeQueriesSpy.mock.calls[0][0]!.predicate!;
    expect(predicate({ meta: { persist: true } } as never)).toBe(true);
    expect(predicate({ meta: { persist: false } } as never)).toBe(false);
    expect(predicate({ meta: undefined } as never)).toBe(false);
    expect(predicate({} as never)).toBe(false);
  });
});

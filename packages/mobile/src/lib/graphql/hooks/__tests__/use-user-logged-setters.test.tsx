// @vitest-environment jsdom
//
// Every userLoggedSetters request walks the climber's whole logbook, so the
// picker asks once per board scope and filters on the device. These cases pin
// when a request goes out: once per scope, never per keystroke, and a server
// search only when the first page came back full (so it may hide the name).
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: http.request }) }));

import { LOGGED_SETTERS_PAGE_LIMIT, useUserLoggedSetters, type LoggedSettersScope } from '../use-user-logged-setters';

type Variables = {
  userId: string;
  input: { boardTypes?: string[]; layoutIds?: number[]; search?: string; limit: number };
};

const ALL_BOARDS: LoggedSettersScope = { boardType: '', layoutIds: [] };

function setterPage(names: string[]) {
  return { userLoggedSetters: names.map((setterUsername, index) => ({ setterUsername, tickCount: 100 - index })) };
}

function requestedInputs(): Variables['input'][] {
  return http.request.mock.calls.map(([, variables]) => (variables as Variables).input);
}

function renderSetters(initial: { scope: LoggedSettersScope; search: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(({ scope, search }) => useUserLoggedSetters('climber-1', scope, search), {
    wrapper,
    initialProps: initial,
  });
}

beforeEach(() => {
  http.request.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useUserLoggedSetters', () => {
  it('fetches one page per scope and filters it locally as the climber types', async () => {
    http.request.mockResolvedValue(setterPage(['Alex Honnold', 'sam', 'jwebb']));
    const view = renderSetters({ scope: ALL_BOARDS, search: '' });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    expect(view.result.current.setters?.map((setter) => setter.setterUsername)).toEqual([
      'Alex Honnold',
      'sam',
      'jwebb',
    ]);

    view.rerender({ scope: ALL_BOARDS, search: ' ALEX ' });
    expect(view.result.current.setters?.map((setter) => setter.setterUsername)).toEqual(['Alex Honnold']);
    view.rerender({ scope: ALL_BOARDS, search: 'zz' });
    expect(view.result.current.setters).toEqual([]);
    expect(view.result.current.isLoading).toBe(false);

    expect(requestedInputs()).toEqual([{ limit: LOGGED_SETTERS_PAGE_LIMIT }]);
  });

  it('asks again only when the board scope changes, and sends it', async () => {
    http.request.mockResolvedValue(setterPage(['alex']));
    const view = renderSetters({ scope: ALL_BOARDS, search: '' });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    // A fresh object with the same contents is the same scope.
    view.rerender({ scope: { boardType: '', layoutIds: [] }, search: '' });
    view.rerender({ scope: { boardType: 'kilter', layoutIds: [1, 8] }, search: '' });
    await waitFor(() => expect(http.request).toHaveBeenCalledTimes(2));
    expect(requestedInputs()[1]).toEqual({
      boardTypes: ['kilter'],
      layoutIds: [1, 8],
      limit: LOGGED_SETTERS_PAGE_LIMIT,
    });
  });

  it('waits for a debounced server search when a full first page has no match', async () => {
    const fullPage = Array.from({ length: LOGGED_SETTERS_PAGE_LIMIT }, (_, index) => `setter-${index}`);
    http.request.mockImplementation(async (_document: unknown, variables: Variables) =>
      variables.input.search ? setterPage(['rare-setter']) : setterPage(fullPage),
    );
    const view = renderSetters({ scope: ALL_BOARDS, search: '' });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    view.rerender({ scope: ALL_BOARDS, search: 'rare' });
    // Waiting out the debounce with nothing local reads as loading, not "No matches".
    expect(view.result.current.isLoading).toBe(true);
    expect(view.result.current.setters).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(http.request).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await waitFor(() =>
      expect(view.result.current.setters?.map((setter) => setter.setterUsername)).toEqual(['rare-setter']),
    );
    expect(requestedInputs()[1]).toEqual({ limit: LOGGED_SETTERS_PAGE_LIMIT, search: 'rare' });
  });

  it('still searches the server when a full first page has a partial match, and merges the two', async () => {
    // "alexander" is on the first page; the "alex" the climber wants ranks past it.
    const fullPage = [
      'alexander',
      ...Array.from({ length: LOGGED_SETTERS_PAGE_LIMIT - 1 }, (_, index) => `s-${index}`),
    ];
    http.request.mockImplementation(async (_document: unknown, variables: Variables) =>
      variables.input.search ? { userLoggedSetters: [{ setterUsername: 'alex', tickCount: 3 }] } : setterPage(fullPage),
    );
    const view = renderSetters({ scope: ALL_BOARDS, search: '' });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    view.rerender({ scope: ALL_BOARDS, search: 'alex' });
    // The local hit shows at once while the server search waits out its debounce.
    expect(view.result.current.isLoading).toBe(false);
    expect(view.result.current.setters?.map((setter) => setter.setterUsername)).toEqual(['alexander']);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() =>
      expect(view.result.current.setters?.map((setter) => setter.setterUsername)).toEqual(['alexander', 'alex']),
    );
    expect(requestedInputs()[1]).toEqual({ limit: LOGGED_SETTERS_PAGE_LIMIT, search: 'alex' });
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { GET_PLAYLIST_SETTERS, type PlaylistSetter } from '@boardsesh/graphql/operations/playlists';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import {
  PLAYLIST_SETTERS_ANSWER_LIMIT,
  playlistSettersQueryKey,
  usePlaylistSetters,
  type PlaylistSetterSource,
} from '../use-playlist-setters';

function renderWithAdapter(execute: ReturnType<typeof vi.fn>) {
  const adapter: PlaylistsAdapter = {
    executeGraphQL: execute as unknown as ExecutePlaylistsGraphQL,
    recents: noopRecentsAdapter,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

function settersAnswer(setters: PlaylistSetter[]) {
  return { playlistSetters: setters };
}

const PLAYLIST: PlaylistSetterSource = { kind: 'playlist', playlistId: 'p-1' };
const LIKED: PlaylistSetterSource = { kind: 'smart', smartType: 'LIKED_CLIMBS', userId: 'climber' };
const FEW_SETTERS: PlaylistSetter[] = [
  { username: 'alex', climbCount: 9 },
  { username: 'Alba', climbCount: 4 },
  { username: 'sam', climbCount: 2 },
];

describe('usePlaylistSetters', () => {
  it('asks for a playlist by id alone: no board, angle or active-board fields', async () => {
    const execute = vi.fn(async () => settersAnswer(FEW_SETTERS));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result } = renderHook(() => usePlaylistSetters({ source: PLAYLIST }), { wrapper });
    await waitFor(() => expect(result.current.setters).toEqual(FEW_SETTERS));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(GET_PLAYLIST_SETTERS, { input: { playlistId: 'p-1' } });
    client.clear();
  });

  it('asks for a smart list by type and owner alone, with no boardName, as the list screen asks', async () => {
    const execute = vi.fn(async () => settersAnswer(FEW_SETTERS));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result } = renderHook(() => usePlaylistSetters({ source: LIKED }), { wrapper });
    await waitFor(() => expect(result.current.setters).toEqual(FEW_SETTERS));
    expect(execute).toHaveBeenCalledWith(GET_PLAYLIST_SETTERS, {
      input: { smartType: 'LIKED_CLIMBS', userId: 'climber' },
    });
    client.clear();
  });

  it('filters a short answer on the device, by the same starts-with rule, without another request', async () => {
    const execute = vi.fn(async () => settersAnswer(FEW_SETTERS));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result, rerender } = renderHook(({ search }) => usePlaylistSetters({ source: PLAYLIST, search }), {
      wrapper,
      initialProps: { search: '' },
    });
    await waitFor(() => expect(result.current.setters).toHaveLength(3));

    rerender({ search: ' al ' });
    expect(result.current.setters?.map((setter) => setter.username)).toEqual(['alex', 'Alba']);
    rerender({ search: 'lex' });
    expect(result.current.setters).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('asks the server for a name once the answer came back full, since it may be cut short', async () => {
    const fullAnswer = Array.from({ length: PLAYLIST_SETTERS_ANSWER_LIMIT }, (_unused, index) => ({
      username: `setter-${index}`,
      climbCount: 1,
    }));
    const searched: PlaylistSetter[] = [{ username: 'zara', climbCount: 1 }];
    const execute = vi
      .fn()
      .mockResolvedValueOnce(settersAnswer(fullAnswer))
      .mockResolvedValueOnce(settersAnswer(searched));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result, rerender } = renderHook(({ search }) => usePlaylistSetters({ source: LIKED, search }), {
      wrapper,
      initialProps: { search: '' },
    });
    await waitFor(() => expect(result.current.setters).toHaveLength(PLAYLIST_SETTERS_ANSWER_LIMIT));

    rerender({ search: 'za' });
    await waitFor(() => expect(result.current.setters).toEqual(searched));
    expect(execute).toHaveBeenLastCalledWith(GET_PLAYLIST_SETTERS, {
      input: { smartType: 'LIKED_CLIMBS', userId: 'climber', search: 'za' },
    });
    client.clear();
  });

  it('filters the names already here while the server search loads, never showing the whole list', async () => {
    const fullAnswer = Array.from({ length: PLAYLIST_SETTERS_ANSWER_LIMIT }, (_unused, index) => ({
      username: index === 0 ? 'zed' : `setter-${index}`,
      climbCount: 1,
    }));
    let answerSearch: (setters: ReturnType<typeof settersAnswer>) => void = () => {};
    const execute = vi
      .fn()
      .mockResolvedValueOnce(settersAnswer(fullAnswer))
      .mockReturnValueOnce(
        new Promise<ReturnType<typeof settersAnswer>>((resolve) => {
          answerSearch = resolve;
        }),
      );
    const { client, wrapper } = renderWithAdapter(execute);
    const { result, rerender } = renderHook(({ search }) => usePlaylistSetters({ source: LIKED, search }), {
      wrapper,
      initialProps: { search: '' },
    });
    await waitFor(() => expect(result.current.setters).toHaveLength(PLAYLIST_SETTERS_ANSWER_LIMIT));

    rerender({ search: 'ze' });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(result.current.setters?.map((setter) => setter.username)).toEqual(['zed']);

    answerSearch(
      settersAnswer([
        { username: 'zed', climbCount: 1 },
        { username: 'zelda', climbCount: 1 },
      ]),
    );
    await waitFor(() => expect(result.current.setters).toHaveLength(2));
    client.clear();
  });

  it('sends at most the 100 characters the server takes', async () => {
    const fullAnswer = Array.from({ length: PLAYLIST_SETTERS_ANSWER_LIMIT }, (_unused, index) => ({
      username: `setter-${index}`,
      climbCount: 1,
    }));
    const execute = vi.fn().mockResolvedValueOnce(settersAnswer(fullAnswer)).mockResolvedValue(settersAnswer([]));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result, rerender } = renderHook(({ search }) => usePlaylistSetters({ source: PLAYLIST, search }), {
      wrapper,
      initialProps: { search: '' },
    });
    await waitFor(() => expect(result.current.setters).toHaveLength(PLAYLIST_SETTERS_ANSWER_LIMIT));
    rerender({ search: 'a'.repeat(150) });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenLastCalledWith(GET_PLAYLIST_SETTERS, {
      input: { playlistId: 'p-1', search: 'a'.repeat(100) },
    });
    client.clear();
  });

  it('sends nothing for a source that names no list', () => {
    const execute = vi.fn(async () => settersAnswer([]));
    const { client, wrapper } = renderWithAdapter(execute);
    renderHook(() => usePlaylistSetters({ source: { kind: 'playlist', playlistId: '' } }), { wrapper });
    expect(execute).not.toHaveBeenCalled();
    client.clear();
  });

  it('keys every search under the playlist, so one invalidation drops them all', async () => {
    expect(playlistSettersQueryKey(PLAYLIST, 'al')).toEqual(['playlistSetters', 'p-1', 'al']);
    expect(playlistSettersQueryKey(LIKED, '')).toEqual(['playlistSetters', 'smart', 'LIKED_CLIMBS', 'climber', '']);

    const execute = vi.fn(async () => settersAnswer(FEW_SETTERS));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result } = renderHook(() => usePlaylistSetters({ source: PLAYLIST }), { wrapper });
    await waitFor(() => expect(result.current.setters).toBeDefined());
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['playlistSetters', 'p-1'] });
    });
    expect(execute).toHaveBeenCalledTimes(2);
    client.clear();
  });
});

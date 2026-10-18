// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { memo, type ReactNode, useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { BoardName } from '@boardsesh/shared-schema';
import type { LogbookEntry } from '@boardsesh/board-react';

const scope = vi.hoisted(() => ({
  generation: 0,
  listeners: new Set<() => void>(),
  progress: true,
  sentMark: false,
  authenticated: true,
  fallbackLogbook: null as { logbookByClimbAngle: Map<string, LogbookEntry[]> } | null,
  batches: [] as { boardName: BoardName | null; uuids: string[] }[],
  artRenders: 0,
  mounts: 0,
  unmounts: 0,
}));
vi.mock('../../lib/privacy/privacy-cache', () => ({
  getCredentialGeneration: () => scope.generation,
  subscribeToCredentialChanges: (listener: () => void) => {
    scope.listeners.add(listener);
    return () => scope.listeners.delete(listener);
  },
}));
vi.mock('../../lib/climb-row-display-preference', () => ({
  useClimbRowField: (field: 'progress' | 'sentMark') => scope[field],
}));
vi.mock('@boardsesh/board-react', () => ({
  useBoardAdapter: () => ({ isAuthenticated: scope.authenticated, isAuthLoading: false }),
  useOptionalBoardLogbook: () => scope.fallbackLogbook,
  logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
  useLogbook: (boardName: BoardName | null, uuids: string[]) => {
    scope.batches.push({ boardName, uuids });
    const query = useQuery<LogbookEntry[]>({
      queryKey: ['logbook', boardName, 'accumulated'],
      queryFn: async () => [],
      initialData: [],
      enabled: false,
    });
    return { logbook: query.data ?? [] };
  },
}));

import { ClimbProgressProvider } from '../climb-progress-provider';
import { climbProgressCacheScopeFor } from '../../lib/climb-progress-cache-owner';
import { useClimbProgress } from '../../hooks/use-climb-progress';
import { useAscentStatus } from '../../hooks/use-ascent-status';

const tick = (climbUuid: string, status: 'flash' | 'send' | 'attempt' = 'send'): LogbookEntry => ({
  uuid: `tick-${climbUuid}`,
  climb_uuid: climbUuid,
  angle: 40,
  is_mirror: false,
  tries: status === 'flash' ? 1 : 2,
  quality: null,
  difficulty: null,
  comment: '',
  climbed_at: '2026-10-10T12:00:00Z',
  is_ascent: status !== 'attempt',
  status,
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
});
const targets = [
  { boardName: 'kilter' as const, climbUuid: 'shared' },
  { boardName: 'tension' as const, climbUuid: 'shared' },
  { boardName: 'kilter' as const, climbUuid: 'shared' },
];
function Progress({ boardName }: { boardName: BoardName }) {
  const progress = useClimbProgress(boardName, 'shared', 40);
  return <span data-testid={boardName}>{progress?.status ?? 'empty'}</span>;
}
function SentMark({
  boardName,
  angle = 40,
  testId = boardName,
}: {
  boardName: BoardName;
  angle?: number;
  testId?: string;
}) {
  const status = useAscentStatus('shared', angle, undefined, null, boardName);
  return <span data-testid={testId}>{status ?? 'empty'}</span>;
}
const Art = memo(function Art() {
  scope.artRenders += 1;
  useEffect(() => {
    scope.mounts += 1;
    return () => {
      scope.unmounts += 1;
    };
  }, []);
  return <span>board art</span>;
});
function wrapper(client: QueryClient, children: ReactNode, enabled = true) {
  return (
    <QueryClientProvider client={client}>
      <ClimbProgressProvider targets={targets} enabled={enabled}>
        {children}
      </ClimbProgressProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  scope.progress = true;
  scope.sentMark = false;
  scope.authenticated = true;
  scope.fallbackLogbook = null;
  scope.batches = [];
  scope.artRenders = 0;
  scope.mounts = 0;
  scope.unmounts = 0;
});
describe('list progress scope', () => {
  it('keeps disabled feature and drag-host children free of query/auth adapters', () => {
    scope.progress = false;
    const result = render(
      <ClimbProgressProvider targets={targets}>
        <span>row</span>
      </ClimbProgressProvider>,
    );
    expect(screen.getByText('row')).toBeTruthy();
    expect(scope.batches).toEqual([]);
    scope.progress = true;
    scope.sentMark = true;
    result.rerender(
      <ClimbProgressProvider targets={targets} enabled={false}>
        <span>drag row</span>
      </ClimbProgressProvider>,
    );
    expect(screen.getByText('drag row')).toBeTruthy();
    expect(scope.batches).toEqual([]);
  });
  it('loads one deduplicated batch per board and updates leaves without art', async () => {
    const client = new QueryClient();
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared')]);
    client.setQueryData(['logbook', 'tension', 'accumulated'], [tick('shared', 'attempt')]);
    render(
      wrapper(
        client,
        <>
          <Art />
          <Progress boardName="kilter" />
          <Progress boardName="tension" />
        </>,
      ),
    );
    expect(screen.getByTestId('kilter').textContent).toBe('send');
    expect(screen.getByTestId('tension').textContent).toBe('attempt');
    expect(new Set(scope.batches.map((batch) => batch.boardName))).toEqual(new Set(['kilter', 'tension']));
    expect(scope.batches.every((batch) => batch.uuids.length === 1)).toBe(true);
    const before = scope.artRenders;
    await act(async () => {
      client.setQueryData(['logbook', 'tension', 'accumulated'], [tick('shared')]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('tension').textContent).toBe('send');
    expect(scope.artRenders).toBe(before);
  });
  it('loads independent sent marks before opening a climb, with My progress off', async () => {
    scope.progress = false;
    scope.sentMark = true;
    const client = new QueryClient();
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared', 'flash')]);
    client.setQueryData(['logbook', 'tension', 'accumulated'], [tick('shared', 'attempt')]);
    // A missing scoped angle must not borrow a mark from the active board.
    scope.fallbackLogbook = {
      logbookByClimbAngle: new Map([['shared:45', [{ ...tick('shared', 'flash'), angle: 45 }]]]),
    };
    render(
      wrapper(
        client,
        <>
          <Art />
          <SentMark boardName="kilter" />
          <SentMark boardName="tension" />
          <SentMark boardName="tension" angle={45} testId="other-angle" />
        </>,
      ),
    );
    expect(screen.getByTestId('kilter').textContent).toBe('flash');
    expect(screen.getByTestId('tension').textContent).toBe('attempt');
    expect(screen.getByTestId('other-angle').textContent).toBe('empty');
    expect(new Set(scope.batches.map((batch) => batch.boardName))).toEqual(new Set(['kilter', 'tension']));
    expect(scope.batches.every((batch) => batch.uuids.length === 1)).toBe(true);
    const before = scope.artRenders;
    await act(async () => {
      client.setQueryData(['logbook', 'tension', 'accumulated'], [tick('shared')]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('tension').textContent).toBe('send');
    expect(screen.getByTestId('kilter').textContent).toBe('flash');
    expect(scope.artRenders).toBe(before);
  });
  it('keeps marks available when My progress is switched off, until both choices are off', () => {
    scope.sentMark = true;
    const client = new QueryClient();
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared', 'flash')]);
    const children = <SentMark boardName="kilter" />;
    const result = render(wrapper(client, children));
    expect(screen.getByTestId('kilter').textContent).toBe('flash');
    scope.progress = false;
    result.rerender(wrapper(client, children));
    expect(screen.getByTestId('kilter').textContent).toBe('flash');
    scope.sentMark = false;
    result.rerender(wrapper(client, children));
    expect(screen.getByTestId('kilter').textContent).toBe('empty');
  });
  it.each(['progress', 'sentMark'] as const)(
    'withdraws the old-cache logout window for %s and resumes for account B after clear',
    async (field) => {
      scope.progress = field === 'progress';
      scope.sentMark = field === 'sentMark';
      const client = new QueryClient();
      client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared')]);
      const History = field === 'progress' ? Progress : SentMark;
      render(wrapper(client, <History boardName="kilter" />));
      expect(screen.getByTestId('kilter').textContent).toBe('send');
      act(() => {
        scope.generation += 1;
        scope.listeners.forEach((listener) => listener());
      });
      expect(screen.getByTestId('kilter').textContent).toBe('empty');
      await act(async () => {
        client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared')]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.getByTestId('kilter').textContent).toBe('empty');
      await act(async () => {
        client.clear();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared', 'attempt')]);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.getByTestId('kilter').textContent).toBe('attempt');
      // Normal refresh stays in the same credential generation.
      act(() => {
        scope.listeners.forEach((listener) => listener());
      });
      expect(screen.getByTestId('kilter').textContent).toBe('attempt');
    },
  );
  it('keeps the list mounted while toggling progress and across credential changes', async () => {
    const client = new QueryClient();
    const children = (
      <>
        <Art />
        <Progress boardName="kilter" />
      </>
    );
    const result = render(wrapper(client, children));
    expect(scope.mounts).toBe(1);
    scope.progress = false;
    result.rerender(wrapper(client, children));
    scope.progress = true;
    result.rerender(wrapper(client, children));
    act(() => {
      scope.generation += 1;
      scope.listeners.forEach((listener) => listener());
    });
    expect(scope.mounts).toBe(1);
    expect(scope.unmounts).toBe(0);
  });
  it('never republishes old ticks when progress is switched off across logout', async () => {
    const client = new QueryClient();
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared')]);
    const children = <Progress boardName="kilter" />;
    const result = render(wrapper(client, children));
    expect(screen.getByTestId('kilter').textContent).toBe('send');
    scope.progress = false;
    result.rerender(wrapper(client, children));
    expect(screen.getByTestId('kilter').textContent).toBe('empty');
    act(() => {
      scope.generation += 1;
      scope.listeners.forEach((listener) => listener());
    });
    scope.progress = true;
    result.rerender(wrapper(client, children));
    expect(screen.getByTestId('kilter').textContent).toBe('empty');
    await act(async () => {
      client.clear();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared', 'attempt')]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('kilter').textContent).toBe('attempt');
  });
  it('fences the very first enable when logout still retains an old shared cache', async () => {
    const client = new QueryClient();
    // QueryProvider installs this before root BoardProvider can cache ticks.
    climbProgressCacheScopeFor(client);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared')]);
    scope.progress = false;
    const children = <Progress boardName="kilter" />;
    const result = render(wrapper(client, children));
    act(() => {
      scope.generation += 1;
      scope.listeners.forEach((listener) => listener());
    });
    scope.progress = true;
    result.rerender(wrapper(client, children));
    expect(screen.getByTestId('kilter').textContent).toBe('empty');
    await act(async () => {
      client.clear();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared', 'attempt')]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('kilter').textContent).toBe('attempt');
  });

  it('shows newly authenticated history in queries created during anonymous startup', async () => {
    const client = new QueryClient();
    climbProgressCacheScopeFor(client);
    client.setQueryData(['logbook', 'kilter', 'accumulated'], []);
    client.setQueryData(['logbook', 'kilter', 'fetch', ''], []);
    scope.authenticated = false;
    const children = <Progress boardName="kilter" />;
    const result = render(wrapper(client, children));
    expect(screen.getByTestId('kilter').textContent).toBe('empty');
    act(() => {
      scope.generation += 1;
      scope.listeners.forEach((listener) => listener());
    });
    scope.authenticated = true;
    result.rerender(wrapper(client, children));
    await act(async () => {
      client.setQueryData(['logbook', 'kilter', 'accumulated'], [tick('shared')]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('kilter').textContent).toBe('send');
  });
});

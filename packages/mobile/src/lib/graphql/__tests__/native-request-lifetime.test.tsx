// @vitest-environment jsdom
/**
 * Native request lifetime (#7596 A4). On phones a read or a write started on a
 * screen finishes after that screen unmounts: nothing aborts it, and its cache
 * effect lands. This is the behaviour the store app shipped with before the
 * BA-05 per-call-site wrappers, and the plain hooks restored in A4 must keep it.
 *
 * Real HTTP: a local node:http server answers /graphql, and the hooks send
 * through a real `GraphQLClient` on the real `fetch`. Only the module that
 * builds the app's client is swapped, so its URL points at the local server.
 * The server holds every answer until the test releases it, after the unmount.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { GraphQLClient } from 'graphql-request';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GetMyConnectedAppsResponse } from '@boardsesh/graphql/operations/connected-apps';

const transport = vi.hoisted(() => ({ client: null as GraphQLClient | null }));
vi.mock('../client', () => ({
  getHttpClient: () => {
    if (!transport.client) throw new Error('The local GraphQL server has not started');
    return transport.client;
  },
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));

import { CONNECTED_APPS_QUERY_KEY, useDisconnectApp, useMyConnectedApps } from '../hooks/use-connected-apps';
import { useBetaLinks } from '../hooks/use-beta-links';
import { useClimbProposals } from '../hooks/use-climb-proposals';
import { climbProposalsKey } from '../hooks/use-browse-proposals';
import { CLIMB_LOST_HOLDS_QUERY_KEY, useClimbLostHolds } from '../hooks/use-climb-lost-holds';

/** One request the server has received and not yet answered. */
type HeldRequest = {
  operationName: string;
  variables: unknown;
  /** True once the client hung up before the answer was written. */
  aborted: boolean;
  answered: boolean;
  answer: (data: unknown) => void;
};

const received: HeldRequest[] = [];
let server: Server;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.url !== '/graphql' || request.method !== 'POST') {
    response.writeHead(404).end();
    return;
  }
  const payload = JSON.parse(await readBody(request)) as { query: string; variables?: unknown };
  const operationName = /\b(?:query|mutation)\s+(\w+)/.exec(payload.query)?.[1] ?? 'anonymous';
  const held: HeldRequest = {
    operationName,
    variables: payload.variables,
    aborted: false,
    answered: false,
    answer: (data) => {
      held.answered = true;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data }));
    },
  };
  response.on('close', () => {
    if (!response.writableFinished) held.aborted = true;
  });
  received.push(held);
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  transport.client = new GraphQLClient(`http://127.0.0.1:${port}/graphql`, {
    fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  });
});

afterEach(() => {
  for (const held of received.splice(0)) if (!held.aborted && !held.answered) held.answer(null);
});

afterAll(async () => {
  transport.client = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function createScreenHost() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

async function nextHeldRequest(operationName: string): Promise<HeldRequest> {
  let found: HeldRequest | undefined;
  await waitFor(() => {
    found = received.find((held) => held.operationName === operationName);
    expect(found).toBeDefined();
  });
  return found!;
}

const LOST_HOLDS_VARIABLES = {
  boardName: 'spray',
  layoutId: 9001,
  sizeId: 1,
  setIds: '1',
  angle: 40,
  climbUuid: 'climb-1',
};

type ReadCase = {
  name: string;
  operationName: string;
  queryKey: QueryKey;
  data: unknown;
  mount: () => unknown;
};

const READS: ReadCase[] = [
  {
    name: 'connected apps',
    operationName: 'GetMyConnectedApps',
    queryKey: CONNECTED_APPS_QUERY_KEY,
    data: { myConnectedApps: { apps: [] } },
    mount: () => useMyConnectedApps(),
  },
  {
    name: 'beta videos',
    operationName: 'GetBetaLinks',
    queryKey: ['betaLinks', 'kilter', 'climb-1'],
    data: { betaLinks: [] },
    mount: () => useBetaLinks('kilter', 'climb-1'),
  },
  {
    name: 'climb proposals',
    operationName: 'GetClimbProposals',
    queryKey: climbProposalsKey('climb-1'),
    data: { climbProposals: { proposals: [], totalCount: 0, hasMore: false } },
    mount: () => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter' }),
  },
  {
    name: 'lost holds',
    operationName: 'GetClimbLostHolds',
    queryKey: [...CLIMB_LOST_HOLDS_QUERY_KEY, LOST_HOLDS_VARIABLES],
    data: { climb: { uuid: 'climb-1', lostHolds: [] } },
    mount: () => useClimbLostHolds(LOST_HOLDS_VARIABLES),
  },
];

describe('the local server', () => {
  it('sees a request the client aborts, so the checks below can fail', async () => {
    const controller = new AbortController();
    const sent = transport.client!.request({
      document: 'query AbortProbe { probe }',
      signal: controller.signal,
    });
    const settled = sent.then(
      () => 'answered',
      () => 'rejected',
    );
    const held = await nextHeldRequest('AbortProbe');
    controller.abort();
    expect(await settled).toBe('rejected');
    await waitFor(() => expect(held.aborted).toBe(true));
  });
});

describe('native reads outlive the screen that started them', () => {
  it.each(READS)('$name: the answer lands in the cache after the screen unmounts', async (read) => {
    const { queryClient, wrapper } = createScreenHost();
    const screen = renderHook(read.mount, { wrapper });
    const held = await nextHeldRequest(read.operationName);

    screen.unmount();
    // Give an abort, if any, the chance to reach the server before it answers.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(held.aborted).toBe(false);

    held.answer(read.data);
    await waitFor(() => expect(queryClient.getQueryState(read.queryKey)?.status).toBe('success'));
    expect(queryClient.getQueryData(read.queryKey)).toEqual(read.data);
    expect(received.filter((request) => request.operationName === read.operationName)).toHaveLength(1);
  });
});

describe('native writes outlive the screen that started them', () => {
  it('disconnect: the server gets it, the cache drops the app, and per-call callbacks follow TanStack', async () => {
    const { queryClient, wrapper } = createScreenHost();
    const app = { connectionId: 'connection-1', name: 'Sequence', publisherName: 'Sequence Ltd' };
    const kept = { connectionId: 'connection-2', name: 'DivePeaks', publisherName: 'DivePeaks AB' };
    queryClient.setQueryData(CONNECTED_APPS_QUERY_KEY, {
      myConnectedApps: { apps: [app, kept] },
    } as unknown as GetMyConnectedAppsResponse);
    const perCallSuccess = vi.fn();

    const screen = renderHook(() => useDisconnectApp(), { wrapper });
    act(() => {
      screen.result.current.mutate({ connectionId: app.connectionId }, { onSuccess: perCallSuccess });
    });
    const held = await nextHeldRequest('DisconnectApp');
    expect(held.variables).toEqual({ connectionId: app.connectionId });

    screen.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(held.aborted).toBe(false);

    held.answer({ disconnectApp: true });
    await waitFor(() => expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success'));
    // The hook's own onSuccess still edits the cache for the climber's next visit.
    expect(queryClient.getQueryData(CONNECTED_APPS_QUERY_KEY)).toEqual({ myConnectedApps: { apps: [kept] } });
    // A plain useMutation calls per-call callbacks only while its screen is
    // mounted; the BA-05 wrapper called them after the screen had gone.
    expect(perCallSuccess).not.toHaveBeenCalled();
    expect(received.filter((request) => request.operationName === 'DisconnectApp')).toHaveLength(1);
  });
});

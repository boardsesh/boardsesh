// A real local /graphql server for request-lifetime suites (#7596 A4). It holds
// every answer until the test releases it, so a test can unmount the screen
// first and then see whether the request was aborted or still lands.
//
// The suite routes the app's HTTP client here by mocking the module that builds
// it, with a hoisted holder the factory can read:
//   const transport = vi.hoisted(() => ({ client: null as GraphQLClient | null }));
//   vi.mock('../client', () => ({ getHttpClient: () => transport.client! }));
//   const server = createHeldGraphQLServer();
//   beforeAll(async () => { transport.client = await server.start(); });

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { GraphQLClient } from 'graphql-request';
import { expect } from 'vitest';

/** One request the server has received and not yet answered. */
export type HeldRequest = {
  operationName: string;
  variables: unknown;
  /** True once the client hung up before the answer was written. */
  aborted: boolean;
  answered: boolean;
  answer: (data: unknown) => void;
  /** Answer with a GraphQL error, which graphql-request raises as a ClientError. */
  fail: (message: string) => void;
};

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

export function createHeldGraphQLServer() {
  const received: HeldRequest[] = [];
  let server: Server | null = null;

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
      fail: (message) => {
        held.answered = true;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: null, errors: [{ message }] }));
      },
    };
    response.on('close', () => {
      if (!response.writableFinished) held.aborted = true;
    });
    received.push(held);
  }

  return {
    received,

    /** Listen on a free local port and return a client that sends to it with the real fetch. */
    async start(): Promise<GraphQLClient> {
      const listening = createServer((request, response) => {
        void handle(request, response);
      });
      server = listening;
      await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
      const { port } = listening.address() as AddressInfo;
      return new GraphQLClient(`http://127.0.0.1:${port}/graphql`, {
        fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
      });
    },

    /** Answer whatever a case left open, so no socket outlives it. */
    releaseAll(): void {
      for (const held of received.splice(0)) if (!held.aborted && !held.answered) held.answer(null);
    },

    async stop(): Promise<void> {
      const listening = server;
      server = null;
      if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
    },

    async nextHeldRequest(operationName: string): Promise<HeldRequest> {
      let found: HeldRequest | undefined;
      await waitFor(() => {
        found = received.find((held) => held.operationName === operationName);
        expect(found).toBeDefined();
      });
      return found!;
    },

    countOf(operationName: string): number {
      return received.filter((held) => held.operationName === operationName).length;
    },
  };
}

type HeldGraphQLServer = ReturnType<typeof createHeldGraphQLServer>;

/** A fresh cache standing in for the app's, with the provider a screen mounts under. */
export function createScreenHost() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

/** Give an abort, if any, the chance to reach the server before it answers. */
export async function settleAfterUnmount(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

export type ReadCase = {
  name: string;
  operationName: string;
  queryKey: QueryKey;
  /** What the server answers. */
  data: unknown;
  /** What the hook keeps in the cache, when its queryFn unwraps the answer. */
  cached?: unknown;
  mount: () => unknown;
};

/**
 * Mount the read, unmount its screen while the server holds the answer, then
 * answer: the request must not have been aborted, it must have gone out once,
 * and the answer must land in the cache.
 */
export async function expectReadOutlivesScreen(server: HeldGraphQLServer, read: ReadCase): Promise<void> {
  const { queryClient, wrapper } = createScreenHost();
  const screen = renderHook(read.mount, { wrapper });
  const held = await server.nextHeldRequest(read.operationName);

  screen.unmount();
  await settleAfterUnmount();
  expect(held.aborted).toBe(false);

  held.answer(read.data);
  await waitFor(() => expect(queryClient.getQueryState(read.queryKey)?.status).toBe('success'));
  expect(queryClient.getQueryData(read.queryKey)).toEqual('cached' in read ? read.cached : read.data);
  expect(server.countOf(read.operationName)).toBe(1);
}

// End-to-end integration tests for subscription/replay AUTHORIZATION against a
// REAL backend (`startTestBackend`) — issues #2355 / #2385.
//
// `queueUpdates`, `sessionUpdates`, and `eventsReplay` all gate on
// `requireSessionMember`. This suite proves, over the real wire:
//   1. a member who joined is authorized (their queue subscription delivers its
//      FullSync — `join()` only resolves once that lands);
//   2. a connection that never joined is denied with a typed
//      `NOT_SESSION_MEMBER` extension code (via `execute`, which preserves
//      GraphQL error extensions — the subscription-path client wrapper does
//      not yet, that's a separate in-flight change).

import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { randomUUID } from 'crypto';
import WS from 'ws';
import { createGraphQLClient, execute, GraphQLOperationError } from '@boardsesh/graphql-client';
import { EVENTS_REPLAY } from '@boardsesh/graphql/operations/queue-session';
import { HeadlessParticipant, startTestBackend, type TestBackend } from './helpers/headless-queue-client';
import { db } from '../db/client';
import { boardSessions } from '@boardsesh/db/schema';

describe('Subscription/replay authorization ↔ real backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await startTestBackend();
  });

  afterAll(async () => {
    await backend.teardown();
  });

  it('authorizes a joined member (queueUpdates FullSync is delivered)', async () => {
    // join() opens the subscription then joins on the same socket and waits for
    // the membership-gated FullSync — so its resolution IS proof that
    // requireSessionMember authorized the member.
    const participant = new HeadlessParticipant(backend.url, `subauth-${randomUUID().slice(0, 8)}`, 'Member');
    try {
      await participant.join();
      expect(participant.users.map((u) => u.username)).toContain('Member');
    } finally {
      await participant.dispose();
    }
  }, 30_000);

  it('denies an unjoined connection with a typed NOT_SESSION_MEMBER extension', async () => {
    // Anonymous client, never joins. eventsReplay runs requireSessionMember,
    // which exhausts its retry backoff (~6.4s) and rejects with the typed code.
    const sessionId = randomUUID();
    await db.insert(boardSessions).values({ id: sessionId, boardPath: '/kilter/1/2/3/40', isPublic: true });
    const client = createGraphQLClient({
      url: backend.url,
      connectionName: 'stranger',
      webSocketImpl: WS as unknown as typeof WebSocket,
      shouldRetry: () => false,
    });

    try {
      let caught: unknown;
      try {
        await execute(client, {
          query: EVENTS_REPLAY,
          variables: { sessionId, sinceSequence: 0 },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(GraphQLOperationError);
      const extensions = (caught as GraphQLOperationError).extensions;
      expect(extensions?.code).toBe('NOT_SESSION_MEMBER');
      expect(extensions?.reason).toBe('no-session-id');
    } finally {
      await client.dispose();
    }
  }, 30_000);
});

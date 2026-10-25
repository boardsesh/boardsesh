// A small graphql-transport-ws server behind a fake WebSocket, for suites that
// run the REAL ws-client stack (`createWsClientModule`, graphql-ws, the
// connectivity store) and need to see which connection each operation landed
// on. Like the backend, it binds the session to the CONNECTION on JoinSession
// and rejects a membership-requiring mutation on a connection that never
// joined. Opens, messages and closes are asynchronous, as on a real socket.
//
// Load it inside `vi.hoisted`, so a `vi.mock` factory for the ws-client module
// can build sockets from it:
//   const server = await vi.hoisted(async () =>
//     (await import('./helpers/fake-graphql-ws-server')).createFakeGraphqlWsServer(),
//   );

export function createFakeGraphqlWsServer() {
  type OperationRecord = {
    connectionId: string;
    operationName: string;
    outcome: 'ok' | 'not_in_session' | 'subscribed' | 'held';
  };
  type WireQueueItem = { uuid: string; climb: Record<string, unknown> };
  type ClientFrame = {
    id?: string;
    type: string;
    payload?: { query?: string; variables?: Record<string, unknown> };
  };

  // The resolvers that call `requireSession` / `requireSessionWithReconnectGrace`
  // on the backend (sessions/mutations.ts, queue/mutations.ts).
  const MEMBERSHIP_REQUIRED = new Set([
    'AddQueueItem',
    'RemoveQueueItem',
    'ReorderQueueItem',
    'SetCurrentClimb',
    'MirrorCurrentClimb',
    'ReplaceQueueItem',
    'SetQueue',
    'SetQueueWithBaseline',
    'PublishPlaybackState',
    'ConfirmClimbOnWall',
    'ReportWallDisconnect',
    'SetSessionBoardSerial',
    'SetSessionBoardPath',
    'SetSessionRestCadence',
  ]);

  const sockets: FakeServerSocket[] = [];
  const operations: OperationRecord[] = [];
  let connectionCount = 0;

  // Off unless a test turns it on: the session's queue as the backend keeps it.
  // A QueueUpdates subscription then opens with a FullSync of it, and a joined
  // SetCurrentClimb moves it and broadcasts CurrentClimbChanged to every live
  // QueueUpdates stream, like queue/subscriptions.ts and queue-navigation.ts.
  const queueFeed = {
    enabled: false,
    sequence: 0,
    queue: [] as WireQueueItem[],
    current: null as WireQueueItem | null,
    /**
     * Leave the next joined SetCurrentClimb unanswered, so the socket dies with
     * it in flight: `unapplied` never runs it, `applied` runs it (the session
     * moves on) but the answer and the broadcast are lost with the socket.
     */
    holdNextSetCurrentClimb: null as null | 'unapplied' | 'applied',
    /** How long a JoinSession takes to bind its connection; 0 binds it at once. */
    joinLatencyMs: 0,
  };

  function lowerFirst(name: string): string {
    return name.charAt(0).toLowerCase() + name.slice(1);
  }

  class FakeServerSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly connectionId: string;
    readonly url: string;
    readonly protocol = 'graphql-transport-ws';
    readonly extensions = '';
    readonly bufferedAmount = 0;
    binaryType: BinaryType = 'blob';
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    /** What JoinSession bound on THIS connection — the backend's ctx.sessionId. */
    joinedSessionId: string | null = null;
    readonly liveSubscriptions = new Map<string, string>();

    constructor(url: string | URL) {
      connectionCount += 1;
      this.connectionId = `conn-${connectionCount}`;
      this.url = url.toString();
      sockets.push(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({} as Event);
      }, 0);
    }

    send(data: string): void {
      const frame = JSON.parse(data) as ClientFrame;
      if (frame.type === 'connection_init') {
        this.deliverLater([{ type: 'connection_ack' }]);
        return;
      }
      if (frame.type === 'ping') {
        this.deliverLater([{ type: 'pong' }]);
        return;
      }
      if (frame.type === 'complete' && frame.id) {
        this.liveSubscriptions.delete(frame.id);
        return;
      }
      if (frame.type === 'subscribe' && frame.id) this.handleOperation(frame.id, frame.payload ?? {});
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      setTimeout(() => {
        this.readyState = 3;
        this.liveSubscriptions.clear();
        this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
      }, 0);
    }

    addEventListener(): void {}
    removeEventListener(): void {}

    completeJoin(id: string, variables: Record<string, unknown>): void {
      this.joinedSessionId = typeof variables.sessionId === 'string' ? variables.sessionId : null;
      operations.push({ connectionId: this.connectionId, operationName: 'JoinSession', outcome: 'ok' });
      this.deliverLater([
        {
          id,
          type: 'next',
          payload: {
            data: {
              joinSession: {
                id: this.joinedSessionId,
                participantId: 'participant-self',
                clientId: 'client-self',
                isLeader: true,
                lastConnectedBoardSerial: null,
                boardPath: '/kilter/1/10/1,2/40/list',
                users: [],
              },
            },
          },
        },
        { id, type: 'complete' },
      ]);
    }

    private handleOperation(id: string, payload: { query?: string; variables?: Record<string, unknown> }): void {
      const operationName = /\b(?:mutation|subscription|query)\s+(\w+)/.exec(payload.query ?? '')?.[1] ?? 'Anonymous';
      const variables = payload.variables ?? {};
      if (operationName === 'JoinSession') {
        if (queueFeed.joinLatencyMs > 0) {
          // A slow JOIN: the connection is bound only once it completes, so a
          // mutation that arrives first is refused, as on the real backend once
          // its ~350 ms reconnect grace runs out.
          const latencyMs = queueFeed.joinLatencyMs;
          setTimeout(() => {
            if (this.readyState !== 1) return;
            this.completeJoin(id, variables);
          }, latencyMs);
          return;
        }
        this.completeJoin(id, variables);
        return;
      }
      if (/^\s*subscription\b/.test(payload.query ?? '')) {
        // Authenticated members are authorized by durable membership, so the
        // backend accepts the stream on any connection; it simply stays open.
        this.liveSubscriptions.set(id, operationName);
        operations.push({ connectionId: this.connectionId, operationName, outcome: 'subscribed' });
        if (queueFeed.enabled && operationName === 'QueueUpdates') {
          const { sequence, queue, current } = queueFeed;
          this.deliverLater([
            {
              id,
              type: 'next',
              payload: {
                data: {
                  queueUpdates: {
                    __typename: 'FullSync',
                    sequence,
                    state: { sequence, stateHash: `hash-${sequence}`, queue, currentClimbQueueItem: current },
                  },
                },
              },
            },
          ]);
        }
        return;
      }
      if (MEMBERSHIP_REQUIRED.has(operationName) && !this.joinedSessionId) {
        operations.push({ connectionId: this.connectionId, operationName, outcome: 'not_in_session' });
        this.deliverLater([
          {
            id,
            type: 'error',
            payload: [
              {
                message: `Must be in a session to perform this operation (connectionId: ${this.connectionId})`,
                extensions: { code: 'SESSION_REQUIRED' },
              },
            ],
          },
        ]);
        return;
      }
      if (queueFeed.enabled && operationName === 'SetCurrentClimb') {
        const hold = queueFeed.holdNextSetCurrentClimb;
        if (hold) {
          queueFeed.holdNextSetCurrentClimb = null;
          if (hold === 'applied') {
            queueFeed.current = variables.item as WireQueueItem;
            queueFeed.sequence += 1;
          }
          operations.push({ connectionId: this.connectionId, operationName, outcome: 'held' });
          return;
        }
        const item = variables.item as WireQueueItem;
        queueFeed.current = item;
        queueFeed.sequence += 1;
        const { sequence } = queueFeed;
        for (const socket of sockets) {
          if (socket.readyState !== 1) continue;
          for (const [subscriptionId, name] of socket.liveSubscriptions) {
            if (name !== 'QueueUpdates') continue;
            socket.deliverLater([
              {
                id: subscriptionId,
                type: 'next',
                payload: {
                  data: {
                    queueUpdates: {
                      __typename: 'CurrentClimbChanged',
                      sequence,
                      stateHash: `hash-${sequence}`,
                      currentItem: item,
                      clientId: 'client-self',
                      correlationId: variables.correlationId ?? null,
                    },
                  },
                },
              },
            ]);
          }
        }
      }
      operations.push({ connectionId: this.connectionId, operationName, outcome: 'ok' });
      this.deliverLater([
        { id, type: 'next', payload: { data: { [lowerFirst(operationName)]: { id: this.joinedSessionId } } } },
        { id, type: 'complete' },
      ]);
    }

    deliverLater(messages: Array<Record<string, unknown>>): void {
      setTimeout(() => {
        for (const message of messages) {
          if (this.readyState !== 1) return;
          this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
        }
      }, 0);
    }
  }

  return {
    FakeServerSocket,
    operations,
    queueFeed,
    openSockets: () => sockets.filter((socket) => socket.readyState === 1),
    /** The open connection that is joined AND carries the live queue stream. */
    liveSessionSocket: () =>
      sockets.find(
        (socket) =>
          socket.readyState === 1 &&
          socket.joinedSessionId === 'session-1' &&
          [...socket.liveSubscriptions.values()].includes('QueueUpdates') &&
          [...socket.liveSubscriptions.values()].includes('SessionUpdates'),
      ) ?? null,
    reset: () => {
      for (const socket of sockets) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.readyState = 3;
      }
      sockets.length = 0;
      operations.length = 0;
      connectionCount = 0;
      queueFeed.enabled = false;
      queueFeed.sequence = 0;
      queueFeed.queue = [];
      queueFeed.current = null;
      queueFeed.holdNextSetCurrentClimb = null;
      queueFeed.joinLatencyMs = 0;
    },
  };
}

export type FakeGraphqlWsServer = ReturnType<typeof createFakeGraphqlWsServer>;

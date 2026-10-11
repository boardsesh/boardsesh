import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  REQUEST_RESOURCE_ACCESS,
  APPROVE_RESOURCE_ACCESS,
} from '../../../packages/shared/graphql/src/operations/privacy';

/** One persistent graphql-transport-ws connection: session context belongs to this socket. */
export class CrewParticipant {
  private socket: WebSocket;
  private pending = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private ready: Promise<void>;
  constructor(backend: URL, jwt: string) {
    this.socket = new WebSocket(new URL('/graphql', backend).href.replace(/^http/, 'ws'), 'graphql-transport-ws');
    this.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Crew WebSocket handshake timed out')), 15_000);
      this.socket.once('open', () =>
        this.socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken: jwt } })),
      );
      this.socket.on('message', (payload) => {
        const message = JSON.parse(
          (Buffer.isBuffer(payload)
            ? payload
            : Array.isArray(payload)
              ? Buffer.concat(payload)
              : Buffer.from(payload)
          ).toString('utf8'),
        ) as {
          type: string;
          id?: string;
          payload?: { data?: unknown; errors?: { message: string }[] };
        };
        if (message.type === 'connection_ack') {
          clearTimeout(timer);
          resolveReady();
        }
        if (message.type === 'ping') this.socket.send(JSON.stringify({ type: 'pong' }));
        const pending = message.id ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        if (message.type === 'next' || message.type === 'error') {
          clearTimeout(pending.timer);
          this.pending.delete(message.id!);
          if (message.type === 'error' || message.payload?.errors?.length)
            pending.reject(new Error(JSON.stringify(message.payload)));
          else pending.resolve(message.payload?.data);
        }
      });
      this.socket.on('error', (error) => {
        clearTimeout(timer);
        rejectReady(error);
      });
      this.socket.on('close', () => {
        clearTimeout(timer);
        rejectReady(new Error('Crew WebSocket closed'));
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Crew connection closed'));
        }
        this.pending.clear();
      });
    });
  }
  async execute(query: string, variables: object): Promise<unknown> {
    await this.ready;
    return new Promise((resolveResult, rejectResult) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResult(new Error('Crew GraphQL operation timed out'));
      }, 20_000);
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
      this.socket.send(JSON.stringify({ id, type: 'subscribe', payload: { query, variables } }));
    });
  }
  close(): void {
    this.socket.close();
  }
}

export function selectActiveTutorialSession(
  sessions: readonly { id: string; isActive: boolean; boardPath: string }[],
  boardPath: string,
): string {
  const active = sessions.filter(
    (session) => session.isActive && (session.boardPath === boardPath || session.boardPath.startsWith(`${boardPath}/`)),
  );
  if (active.length !== 1) throw new Error(`Expected one active tutorial session, received ${active.length}.`);
  return active[0].id;
}

type TutorialSession = { id: string; isActive: boolean; boardPath: string };

async function readTutorialSessions(backend: URL, jwt: string | undefined): Promise<TutorialSession[]> {
  if (!jwt) throw new Error('Primary tutorial account is not authenticated.');
  const response = await fetch(new URL('/graphql', backend), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query: '{mySessions{id isActive boardPath}}' }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json()) as {
    data?: { mySessions?: { id: string; isActive: boolean; boardPath: string }[] };
    errors?: unknown;
  };
  if (!response.ok || result.errors) throw new Error('Could not discover the active tutorial session.');
  if (!Array.isArray(result.data?.mySessions)) throw new Error('Tutorial session response has no session list.');
  return result.data.mySessions;
}

async function readTutorialSessionStatus(
  backend: URL,
  jwt: string | undefined,
  sessionId: string,
): Promise<'active' | 'ended'> {
  if (!jwt) throw new Error('Primary tutorial account is not authenticated.');
  const response = await fetch(new URL('/graphql', backend), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query: 'query($id: ID!){sessionStatus(sessionId: $id)}', variables: { id: sessionId } }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json()) as { data?: { sessionStatus?: unknown }; errors?: unknown };
  if (
    !response.ok ||
    result.errors ||
    (result.data?.sessionStatus !== 'active' && result.data?.sessionStatus !== 'ended')
  )
    throw new Error('Captured tutorial session has no authoritative durable status.');
  return result.data!.sessionStatus as 'active' | 'ended';
}

/** Read the primary user's actual current session without restarting the native app. */
export async function discoverTutorialSession(
  backend: URL,
  jwt: string | undefined,
  boardPath: string,
): Promise<string> {
  const sessions = await readTutorialSessions(backend, jwt);
  const candidates = sessions.filter(
    (session) => session.isActive && (session.boardPath === boardPath || session.boardPath.startsWith(`${boardPath}/`)),
  );
  const durable = await Promise.all(
    candidates.map(async (session) => ({
      ...session,
      isActive: (await readTutorialSessionStatus(backend, jwt, session.id)) === 'active',
    })),
  );
  return selectActiveTutorialSession(durable, boardPath);
}

/** Teardown must end the exact captured session before another warm chapter starts. */
export async function tutorialSessionStillActive(
  backend: URL,
  jwt: string | undefined,
  sessionId: string,
): Promise<boolean> {
  const session = (await readTutorialSessions(backend, jwt)).find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error('Captured tutorial session is missing from its owner session list.');
  return (await readTutorialSessionStatus(backend, jwt, sessionId)) === 'active';
}

/** Sam requests access; the authenticated owner approves before the private JOIN. */
export async function authorizeTutorialCrew(
  backend: URL,
  primaryJwt: string,
  crewJwt: string,
  sessionId: string,
  crewUserId: string,
): Promise<void> {
  if (!crewUserId) throw new Error('Tutorial crew identity is missing.');
  const mutate = async (jwt: string, query: string, variables: Record<string, string>, field: string) => {
    const response = await fetch(new URL('/graphql', backend), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
    if (!response.ok || result.errors?.length || result.data?.[field] !== true)
      throw new Error('The private tutorial session could not authorize its authenticated crew participant.');
  };
  await mutate(crewJwt, REQUEST_RESOURCE_ACCESS, { kind: 'session', resourceId: sessionId }, 'requestResourceAccess');
  await mutate(
    primaryJwt,
    APPROVE_RESOURCE_ACCESS,
    { kind: 'session', resourceId: sessionId, userId: crewUserId },
    'approveResourceAccess',
  );
}

import WebSocket from 'ws';
import { getOperationAST, parse } from 'graphql';
import { JOIN_SESSION, NATIVE_IOS_QUEUE_UPDATES } from '../../packages/shared/graphql/src/operations/queue-session';
import {
  GET_SESSION,
  QUEUE_UPDATES_SUBSCRIPTION,
  SESSION_UPDATES_SUBSCRIPTION,
} from '../../packages/mobile/src/lib/graphql/operations';
import { canonicalCampaignDocument, NATIVE_CAMPAIGN_JOIN_QUERY } from './screenshot-campaign-session';

export const CPP_RECORDING_OWNER_QUERY = `query CppRecordingOwner($boardUuid: ID!, $sessionId: ID!) {
  sessionStatus(sessionId: $sessionId)
  profile { id displayName avatarUrl }
  mySessions { id boardPath createdByUserId isPublic isActive }
  board(boardUuid: $boardUuid) { uuid ownerId boardType layoutId sizeId setIds angle slug }
}`;

interface BoardIdentity {
  boardType: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: readonly number[];
  angle?: number;
}
export interface CppRecordingScope {
  accountUserId: string;
  sessionId: string;
  boardUuid: string;
  primary: BoardIdentity;
}
export interface CppWsOperation {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string | null;
}
interface OwnerResponse {
  sessionStatus: string | null;
  profile: { id: string; displayName: string | null; avatarUrl: string | null } | null;
  mySessions: Array<{ id: string; boardPath: string; createdByUserId: string; isPublic: boolean; isActive: boolean }>;
  board: {
    uuid: string;
    ownerId: string;
    boardType: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    angle: number;
    slug?: string | null;
  } | null;
}
type WireFrame = { id?: string; type: string; payload?: unknown };
type Sink = (frame: WireFrame) => void;
interface Options {
  upstreamUrl: string;
  scope: () => CppRecordingScope | null;
  authorizeToken: (token: string) => boolean;
  persist: (operation: CppWsOperation, response: unknown, verifiedSubject: string) => void;
  request?: typeof fetch;
}

const documents = new Map([
  [canonicalCampaignDocument(JOIN_SESSION), 'JoinSession'],
  [canonicalCampaignDocument(NATIVE_CAMPAIGN_JOIN_QUERY), 'JoinSession'],
  [canonicalCampaignDocument(QUEUE_UPDATES_SUBSCRIPTION), 'QueueUpdates'],
  [canonicalCampaignDocument(NATIVE_IOS_QUEUE_UPDATES), 'QueueUpdates'],
  [canonicalCampaignDocument(SESSION_UPDATES_SUBSCRIPTION), 'SessionUpdates'],
]);
function sameSets(first: string, second: readonly number[]): boolean {
  return (
    first
      .split(',')
      .filter(Boolean)
      .map(Number)
      .sort((left, right) => left - right)
      .join(',') === [...second].sort((left, right) => left - right).join(',')
  );
}
function pathMatches(path: string, board: NonNullable<OwnerResponse['board']>, nativeZero = false): boolean {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'b')
    return !nativeZero && parts.length === 3 && parts[1] === board.slug && Number(parts[2]) === board.angle;
  return (
    parts.length === 5 &&
    parts[0] === board.boardType &&
    Number(parts[1]) === board.layoutId &&
    Number(parts[2]) === board.sizeId &&
    sameSets(parts[3], board.setIds.split(',').map(Number)) &&
    Number(parts[4]) === (nativeZero ? 0 : board.angle)
  );
}

/** One real owned-session presence, retained until capture closes. No queue writes or fabricated responses. */
export function createCppWsRecording(options: Options) {
  let upstream: WebSocket | null = null;
  let ready: Promise<void> | null = null;
  let verified: OwnerResponse | null = null;
  let closed = false;
  let sequence = 0;
  const listeners = new Map<
    string,
    {
      localId: string;
      operation: CppWsOperation;
      sink: Sink;
      recorded: boolean;
      eligible: boolean;
      minimalJoin: boolean;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => new Error('CPP owned-session transport validation failed');

  async function verify(token: string): Promise<OwnerResponse> {
    const scope = options.scope();
    if (!scope || !options.authorizeToken(token)) throw fail();
    const response = await (options.request ?? fetch)(`${options.upstreamUrl}/graphql`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: CPP_RECORDING_OWNER_QUERY,
        variables: { boardUuid: scope.boardUuid, sessionId: scope.sessionId },
      }),
    });
    const body = (await response.json()) as { data?: OwnerResponse; errors?: unknown[] };
    const owner = body.data;
    const session = owner?.mySessions.find((entry) => entry.id === scope.sessionId);
    const board = owner?.board;
    if (
      !response.ok ||
      body.errors?.length ||
      !owner ||
      owner.profile?.id !== scope.accountUserId ||
      !session ||
      session.createdByUserId !== scope.accountUserId ||
      session.isPublic !== false ||
      owner.sessionStatus !== 'active' ||
      !board ||
      board.uuid !== scope.boardUuid ||
      board.ownerId !== scope.accountUserId ||
      board.boardType !== scope.primary.boardType ||
      !pathMatches(session.boardPath, board) ||
      (board.boardType !== 'spray' &&
        (board.layoutId !== scope.primary.layoutId ||
          board.sizeId !== scope.primary.sizeId ||
          board.angle !== scope.primary.angle ||
          !sameSets(board.setIds, scope.primary.setIds ?? [])))
    )
      throw fail();
    return owner;
  }

  async function ensure(token: string): Promise<void> {
    if (closed) throw fail();
    const owner = await verify(token).catch(() => {
      throw fail();
    });
    if (closed) throw fail();
    verified = owner;
    if (!ready) {
      ready = new Promise<void>((resolve, reject) => {
        const scope = options.scope()!;
        const owner = verified!;
        const session = owner.mySessions.find((entry) => entry.id === scope.sessionId)!;
        const url = new URL('/graphql', options.upstreamUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url, 'graphql-transport-ws', { maxPayload: 20 * 1024 * 1024 });
        upstream = socket;
        const timer = setTimeout(() => {
          socket.terminate();
          reject(fail());
        }, 30_000);
        socket.on('open', () => {
          if (closed) {
            socket.terminate();
            return;
          }
          socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken: token } }));
        });
        socket.on('error', () => {
          clearTimeout(timer);
          reject(fail());
        });
        socket.on('close', () => {
          clearTimeout(timer);
          reject(fail());
          for (const listener of listeners.values()) {
            if (listener.timer) clearTimeout(listener.timer);
            listener.sink({
              id: listener.localId,
              type: 'error',
              payload: [{ message: 'CPP upstream session connection closed' }],
            });
          }
          listeners.clear();
        });
        let presenceReceived = false;
        socket.on('message', (raw) => {
          if (closed) return;
          let frame: WireFrame;
          try {
            const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            const parsed: unknown = JSON.parse(bytes.toString('utf8'));
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed) ||
              typeof (parsed as { type?: unknown }).type !== 'string'
            ) {
              socket.terminate();
              return;
            }
            frame = parsed as WireFrame;
          } catch {
            socket.terminate();
            return;
          }
          if (frame.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (frame.type === 'connection_ack') {
            socket.send(
              JSON.stringify({
                id: 'presence',
                type: 'subscribe',
                payload: {
                  query: JOIN_SESSION,
                  variables: {
                    sessionId: scope.sessionId,
                    boardPath: session.boardPath,
                    username: owner.profile!.displayName,
                    avatarUrl: owner.profile!.avatarUrl,
                  },
                },
              }),
            );
            return;
          }
          const payload = frame.payload as { data?: Record<string, unknown>; errors?: unknown[] } | undefined;
          if (frame.id === 'presence') {
            const joined = (
              payload?.data as { joinSession?: { id?: string; isPublic?: boolean; boardPath?: string } } | undefined
            )?.joinSession;
            if (
              frame.type === 'next' &&
              joined?.id === scope.sessionId &&
              joined.isPublic === false &&
              joined.boardPath &&
              pathMatches(joined.boardPath, owner.board!)
            )
              presenceReceived = true;
            if (frame.type === 'error' || payload?.errors || (frame.type === 'complete' && !presenceReceived)) {
              clearTimeout(timer);
              socket.terminate();
              reject(fail());
            } else if (frame.type === 'complete') {
              clearTimeout(timer);
              resolve();
            }
            return;
          }
          const listener = frame.id ? listeners.get(frame.id) : undefined;
          if (!listener) return;
          const data = payload?.data as
            | Record<string, { __typename?: string; id?: string; isPublic?: boolean; boardPath?: string }>
            | undefined;
          const name = getOperationAST(parse(listener.operation.query))?.name?.value;
          if (name === 'JoinSession' && frame.type === 'next' && !payload?.errors) {
            const joined = data?.joinSession;
            if (
              !joined ||
              joined.id !== scope.sessionId ||
              (!listener.minimalJoin &&
                (joined.isPublic !== false ||
                  typeof joined.boardPath !== 'string' ||
                  !pathMatches(joined.boardPath, owner.board!)))
            ) {
              listener.sink({
                id: listener.localId,
                type: 'error',
                payload: [{ message: 'CPP upstream join scope did not match' }],
              });
              if (listener.timer) clearTimeout(listener.timer);
              listeners.delete(frame.id!);
              socket.send(JSON.stringify({ id: frame.id, type: 'complete' }));
              return;
            }
          }
          if (
            listener.eligible &&
            !listener.recorded &&
            frame.type === 'next' &&
            !payload?.errors &&
            ((name === 'JoinSession' && data?.joinSession?.id === scope.sessionId) ||
              (name === 'QueueUpdates' && data?.queueUpdates?.__typename === 'FullSync') ||
              (name === 'SessionUpdates' && data?.sessionUpdates?.__typename === 'SessionRosterSnapshot'))
          ) {
            options.persist(listener.operation, frame.payload, scope.accountUserId);
            listener.recorded = true;
          }
          listener.sink({ ...frame, id: listener.localId });
          if (frame.type === 'complete' || frame.type === 'error') {
            if (listener.timer) clearTimeout(listener.timer);
            listeners.delete(frame.id!);
          }
        });
      });
    }
    await ready;
    if (closed || upstream?.readyState !== WebSocket.OPEN) throw fail();
  }

  return {
    async preparePreview(operation: CppWsOperation, token: string): Promise<void> {
      if (canonicalCampaignDocument(operation.query) !== canonicalCampaignDocument(GET_SESSION)) return;
      if (operation.variables?.sessionId !== options.scope()?.sessionId) return;
      if (
        Object.keys(operation.variables ?? {}).join(',') !== 'sessionId' ||
        (operation.operationName && operation.operationName !== 'GetSession')
      )
        throw fail();
      await ensure(token);
    },
    async subscribe(
      localId: string,
      operation: CppWsOperation,
      token: string,
      sink: Sink,
      current: () => boolean = () => true,
    ): Promise<(() => void) | null> {
      const declared = getOperationAST(parse(operation.query))?.name?.value;
      if (!['JoinSession', 'QueueUpdates', 'SessionUpdates'].includes(declared ?? '')) return null;
      const name = documents.get(canonicalCampaignDocument(operation.query));
      const minimalJoin =
        canonicalCampaignDocument(operation.query) === canonicalCampaignDocument(NATIVE_CAMPAIGN_JOIN_QUERY);
      const minimalQueue =
        canonicalCampaignDocument(operation.query) === canonicalCampaignDocument(NATIVE_IOS_QUEUE_UPDATES);
      const variables = operation.variables ?? {};
      const scope = options.scope();
      const allowedKeys =
        name === 'JoinSession'
          ? minimalJoin
            ? ['sessionId', 'boardPath']
            : ['sessionId', 'boardPath', 'username', 'avatarUrl']
          : ['sessionId'];
      if (
        !scope ||
        !name ||
        (operation.operationName && operation.operationName !== name) ||
        variables.sessionId !== scope.sessionId ||
        Object.keys(variables).some((key) => !allowedKeys.includes(key)) ||
        listeners.size >= 32
      )
        throw fail();
      if (!current()) return null;
      await ensure(token);
      if (!current()) return null;
      if (
        name === 'JoinSession' &&
        (typeof variables.boardPath !== 'string' ||
          !pathMatches(variables.boardPath, verified!.board!, minimalJoin) ||
          (variables.username != null && variables.username !== verified!.profile!.displayName) ||
          (variables.avatarUrl != null && variables.avatarUrl !== verified!.profile!.avatarUrl))
      )
        throw fail();
      const id = `cpp-${++sequence}`;
      const listener = {
        localId,
        operation,
        sink,
        recorded: false,
        eligible: !minimalJoin && !minimalQueue,
        minimalJoin,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      if (name === 'JoinSession')
        listener.timer = setTimeout(() => {
          listeners.delete(id);
          sink({ id: localId, type: 'error', payload: [{ message: 'CPP upstream join timed out' }] });
          upstream?.send(JSON.stringify({ id, type: 'complete' }));
        }, 30_000);
      listeners.set(id, listener);
      upstream!.send(JSON.stringify({ id, type: 'subscribe', payload: operation }));
      return () => {
        if (listener.timer) clearTimeout(listener.timer);
        listeners.delete(id);
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ id, type: 'complete' }));
      };
    },
    close(): void {
      closed = true;
      for (const listener of listeners.values()) if (listener.timer) clearTimeout(listener.timer);
      listeners.clear();
      upstream?.terminate();
    },
  };
}

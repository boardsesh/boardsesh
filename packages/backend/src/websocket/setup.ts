import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { useServer, type Extra as WsExtra } from 'graphql-ws/use/ws';
import type { Context as GqlWsContext } from 'graphql-ws';
import { GraphQLError, parse, type DocumentNode } from 'graphql';
import * as Sentry from '@sentry/node';
import { schema } from '../graphql/index';
import { createContext, removeContext, getContext } from '../graphql/context';
import { validateQueryDepth } from '../graphql/query-depth';
import { roomManager } from '../services/room-manager';
import { kilterLiveSync } from '../services/kilter-live-sync';
import { pubsub } from '../pubsub/index';
import { validateToken, extractAuthToken, extractControllerApiKey, validateControllerApiKey } from '../middleware/auth';
import {
  admitsCredential,
  AUTH_ADMISSION_BATCH_SIZE,
  AuthCredentialRefusedError,
  isAuthAdmissionUnavailable,
  readHumanSubjectStates,
} from '../auth/human-admission';
import { decideCredential, type PresentedCredential, type SubjectCutoffState } from '../auth/credential-cutoffs';
import { selectSweepBatches } from './admission-sweep-batches';
import { isOriginAllowed, isSameOriginUpgrade } from '../handlers/cors';
import { isApiHost } from '../handlers/api-host';
import { resolveWebSocketClientIp, resolveWebSocketSocketPeerIp } from './client-ip';
import { getTrustedClientIp } from '../utils/client-ip';
import { tryAcquireAnonConnectionSlot, releaseAnonConnectionSlot } from './connection-cap';
import {
  CLIENT_PLATFORM_CONNECTION_PARAM,
  CLIENT_PLATFORM_HEADER,
  type ConnectionContext,
} from '@boardsesh/shared-schema';
import { CLIENT_IDENTITY_CONNECTION_PARAM, UNKNOWN_CLIENT } from '@boardsesh/shared-schema/client-identity';
import { recordContextOperation, resolveClientIdentity } from '../services/client-usage';
import { logger } from '../utils/logger';
import { recordUserActivity, resolveActivityPlatform, type ActivityPlatform } from '../services/user-activity';
import { sanitizeAppleAdsGraphqlError } from '../graphql/apple-ads-token-privacy';
import {
  isBoardShareTokenDocument,
  sanitizeBoardShareGraphqlError,
  sanitizeBoardShareResult,
} from '../graphql/board-share-token-privacy';

const DEBUG = process.env.NODE_ENV === 'development';

/** Ping interval in milliseconds for detecting dead WebSocket connections. */
const WS_PING_INTERVAL_MS = 30_000;
export const WS_HUMAN_ADMISSION_SWEEP_INTERVAL_MS = 1000;

/** Longest header value a connection may log. The sender controls all of them. */
const MAX_LOGGED_HEADER_LENGTH = 256;

/** `AA:BB:CC:DD:EE:FF`. The field is unauthenticated and `ws` allows a 100 MiB frame. */
const CONTROLLER_MAC_LENGTH = 17;

function clipHeaderForLog(headerValue: string | string[] | undefined): string | undefined {
  return (Array.isArray(headerValue) ? headerValue.join(', ') : headerValue)?.slice(0, MAX_LOGGED_HEADER_LENGTH);
}

/** What a logged GraphQL error keeps: a clipped message, its code and its path. */
function clipGraphqlErrorForLog(error: GraphQLError): {
  message: string;
  code?: unknown;
  path?: readonly (string | number)[];
} {
  return {
    message: error.message.slice(0, MAX_LOGGED_HEADER_LENGTH),
    code: error.extensions?.code,
    path: error.path,
  };
}

/**
 * A copy of a thrown GraphQL error that is safe for graphql-ws to print. The
 * message is clipped and the source is dropped (its printed excerpt holds the
 * whole line); locations are copied across so the error stays as useful.
 */
function clipThrownGraphqlError(error: GraphQLError): GraphQLError {
  const clipped = new GraphQLError(error.message.slice(0, MAX_LOGGED_HEADER_LENGTH), {
    extensions: error.extensions,
  });
  Object.defineProperty(clipped, 'locations', { value: error.locations, enumerable: true });
  return clipped;
}

/** WebSocket extended with liveness tracking for ping/pong. */
type AliveWebSocket = {
  isAlive: boolean;
} & WebSocket;

/**
 * Close code sent to a connection rejected by the anonymous concurrency cap.
 *
 * Deliberately NOT the 4403 Forbidden that `return false` would emit: graphql-ws
 * excludes 4403 from its client-side fatal list ("might grant access out after
 * retry"), and our shared client (`packages/shared/graphql-client`) sets
 * `retryAttempts: 10` with `shouldRetry: () => true`, so a capped client would
 * hammer the server ten times over. Mobile additionally overloads 4403 as its
 * auth-refresh retry signal (`packages/mobile/src/lib/graphql/ws-close-codes.ts`),
 * which would feed cap rejections into the credential-refresh loop.
 *
 * 4429 (TooManyInitialisationRequests) *is* in the graphql-ws fatal list, so the
 * client gives up instead of storming. Cost: a legitimately capped client stays
 * down until it reconnects deliberately (page reload / app foreground).
 */
const ANON_CONNECTION_CAP_CLOSE_CODE = 4429;

// Extend Extra type with our custom context
type CustomExtra = {
  context?: ConnectionContext;
  /** The client's platform label for the active-user count, read once at connection_init. */
  activityPlatform?: ActivityPlatform;
  [key: PropertyKey]: unknown;
} & WsExtra;

// Type alias for convenience
type ServerContext = GqlWsContext<Record<string, unknown>, CustomExtra>;

/**
 * Setup WebSocket server with graphql-ws for GraphQL subscriptions
 *
 * @param httpServer The HTTP server to attach the WebSocket server to
 * @returns The WebSocket server instance
 */
export function setupWebSocketServer(httpServer: HttpServer): {
  wss: WebSocketServer;
  pingInterval: NodeJS.Timeout;
} {
  // Create WebSocket server on /graphql path with origin validation
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/graphql',
    verifyClient: (
      info: { origin: string; req: IncomingMessage },
      callback: (res: boolean, code?: number, message?: string) => void,
    ) => {
      // An upgrade skips the HTTP dispatcher, so the API host's route list has
      // to be enforced here as well. GraphQL subscriptions stay on ws.boardsesh.com.
      if (isApiHost(info.req.headers.host)) {
        callback(false, 404, 'Not Found');
        return;
      }

      const origin = info.origin;

      // Allow connections without origin header (e.g., from native apps or direct WebSocket clients)
      if (!origin) {
        callback(true);
        return;
      }

      // Allow if the origin is on the website allow-list / a preview pattern, OR
      // if it's a genuine same-origin upgrade (Origin host === the host being
      // connected to). The latter unblocks the React Native Android app, whose
      // WebSocket sets Origin from the wss:// URL (https://ws.boardsesh.com),
      // and preview WS hosts — without weakening CSWSH protection. See
      // isSameOriginUpgrade for the security rationale.
      if (isOriginAllowed(origin) || isSameOriginUpgrade(origin, info.req.headers.host)) {
        callback(true);
        return;
      }

      // Remaining rejections are genuinely unauthorized origins. Log attribution
      // (User-Agent + IP) so they can be traced. forwardedFor is forensic only —
      // it is user-controlled and never used for an allow/deny decision.
      logger.warn('[WebSocket] Rejected connection from unauthorized origin', {
        origin: clipHeaderForLog(origin),
        host: clipHeaderForLog(info.req.headers.host),
        userAgent: clipHeaderForLog(info.req.headers['user-agent']),
        forwardedFor: clipHeaderForLog(info.req.headers['x-forwarded-for']),
        remoteAddress: info.req.socket.remoteAddress,
      });
      callback(false, 403, 'Origin not allowed');
    },
  });

  // Raw credentials stay private to this server instance, never in the public
  // GraphQL context or logs. Admission is rechecked even when crypto is cached.
  // The stamps let the sweep decide each socket's credential without decrypting it.
  const humanBindings = new Map<
    WebSocket,
    { context: ConnectionContext; token: string; userId: string; credential: PresentedCredential }
  >();
  const closeAdmission = (socket: WebSocket, unavailable: boolean) => {
    if (socket.readyState === socket.OPEN) {
      socket.close(
        unavailable ? 1013 : 4401,
        unavailable ? 'Authentication is temporarily unavailable' : 'Authentication is required',
      );
    }
  };
  const checkHumanConnection = async (ctx: ServerContext): Promise<'admitted' | 'denied' | 'unavailable'> => {
    if (!ctx.extra.context?.isAuthenticated) return 'admitted';
    const socket = ctx.extra.socket,
      binding = humanBindings.get(socket);
    if (!binding) {
      closeAdmission(socket, true);
      return 'unavailable';
    }
    try {
      const auth = await validateToken(binding.token);
      // Never deliver an old operation's result to a replacement context.
      if (
        humanBindings.get(socket) !== binding ||
        getContext(binding.context.connectionId) !== binding.context ||
        binding.context.userId !== binding.userId
      )
        return 'unavailable';
      if (!auth || auth.userId !== binding.userId) {
        closeAdmission(socket, false);
        return 'denied';
      }
      return 'admitted';
    } catch {
      // graphql-ws treats an operation error as final, so a refused subscription
      // would never come back. Closing lets the client reconnect and resubscribe.
      if (humanBindings.get(socket) === binding) closeAdmission(socket, true);
      return 'unavailable';
    }
  };
  let sweeping = false;
  let sweepOutageLogged = false;
  let sweepBatchOffset = 0;
  const admissionSweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    const captured = [...humanBindings.entries()];
    const userIds = [...new Set(captured.map(([, binding]) => binding.userId))];
    const batches: string[][] = [];
    for (let offset = 0; offset < userIds.length; offset += AUTH_ADMISSION_BATCH_SIZE)
      batches.push(userIds.slice(offset, offset + AUTH_ADMISSION_BATCH_SIZE));
    const { roundBatches, nextOffset } = selectSweepBatches(batches, sweepBatchOffset);
    sweepBatchOffset = nextOffset;
    let roundFailed = false;
    // Start batches together: capacity pressure fails unavailable immediately,
    // rather than accumulating one read deadline per sequential batch.
    void Promise.all(
      roundBatches.map(async (requestedIds) => {
        const requested = new Set(requestedIds);
        let subjects: ReadonlyMap<string, SubjectCutoffState>;
        try {
          subjects = await readHumanSubjectStates(requestedIds);
        } catch {
          // A failed read proves nothing about these accounts, and a primary that
          // cannot answer cannot commit a deletion or a reset either. Leave them
          // connected: only a confirmed denial closes a socket.
          roundFailed = true;
          return;
        }
        const decidedAt = Date.now();
        for (const [socket, binding] of captured) {
          if (
            !requested.has(binding.userId) ||
            humanBindings.get(socket) !== binding ||
            getContext(binding.context.connectionId) !== binding.context ||
            binding.context.userId !== binding.userId
          )
            continue;
          const decision = decideCredential(binding.credential, subjects.get(binding.userId), decidedAt);
          if (!admitsCredential(decision, 'socket-sweep')) closeAdmission(socket, false);
        }
      }),
    ).finally(() => {
      sweeping = false;
      if (roundFailed && !sweepOutageLogged) {
        logger.warn('[ws] admission sweep could not read the primary; keeping connections open');
      }
      sweepOutageLogged = roundFailed;
    });
  }, WS_HUMAN_ADMISSION_SWEEP_INTERVAL_MS);
  admissionSweep.unref();
  wss.once('close', () => {
    clearInterval(admissionSweep);
    humanBindings.clear();
  });

  // Use graphql-ws server
  useServer<Record<string, unknown>, CustomExtra>(
    {
      schema,
      // onConnect is called ONCE when client connects and sends ConnectionInit
      onConnect: async (ctx: ServerContext) => {
        // Extract and validate auth token
        const token = extractAuthToken(
          ctx.connectionParams as Record<string, unknown> | undefined,
          ctx.extra.request?.url,
        );

        let isAuthenticated = false;
        let authenticatedUserId: string | undefined;
        let credentialExpiresAt: number | undefined;
        let presentedCredential: PresentedCredential | undefined;

        if (token !== null) {
          let authResult;
          try {
            authResult = await validateToken(token, { throwOnRefusal: true });
          } catch (error) {
            // A refused credential (deleted account, cutoff, malformed stamp)
            // must not connect anonymously: the app would go on showing a
            // signed-in climber. 4401 makes it refresh, and the refresh's 401
            // signs it out. An outage is never a refusal: 1013, try again.
            const refused = error instanceof AuthCredentialRefusedError;
            if (!refused && !isAuthAdmissionUnavailable(error)) throw error;
            closeAdmission(ctx.extra.socket, !refused);
            return false;
          }
          if (authResult) {
            isAuthenticated = true;
            authenticatedUserId = authResult.userId;
            credentialExpiresAt = authResult.credentialExpiresAt;
            presentedCredential = authResult.credential;
            logger.info(`[Auth] Authenticated user: ${authenticatedUserId}`);
          } else {
            // Existing clients expect an expired optional credential to keep
            // realtime connected anonymously until their HTTP auth path heals.
            logger.warn('[Auth] Invalid WebSocket auth token; continuing anonymously');
          }
        }

        // Check for controller API key authentication
        let controllerId: string | undefined;
        let controllerApiKey: string | undefined;
        let controllerMac: string | undefined;
        let controllerOwnerUserId: string | undefined;
        const connectionParams = ctx.connectionParams as Record<string, unknown> | undefined;
        const extractedControllerApiKey = extractControllerApiKey(connectionParams);

        if (extractedControllerApiKey) {
          const controllerResult = await validateControllerApiKey(extractedControllerApiKey);
          if (controllerResult) {
            controllerId = controllerResult.controllerId;
            controllerApiKey = controllerResult.controllerApiKey;
            // Read-only: lets the key see its owner's private spray walls via
            // readViewerIdForBoard. Deliberately not authenticatedUserId, so the key
            // still cannot call mutations or read account data.
            controllerOwnerUserId = controllerResult.userId ?? undefined;
            logger.info(`[Auth] Authenticated controller: ${controllerId}`);
          }
        }

        // Extract controller MAC address from connection params (used as clientId for BLE disconnect logic)
        if (connectionParams?.controllerMac && typeof connectionParams.controllerMac === 'string') {
          controllerMac = connectionParams.controllerMac.slice(0, CONTROLLER_MAC_LENGTH);
          logger.info(`[Auth] Controller MAC: ${controllerMac}`);
        }

        // Rate-limit identity for anonymous callers. Without this every
        // reconnect got a fresh uuidv4 connectionId and therefore a fresh
        // bucket, which defeated the tier-1 limiter entirely (issue #2863).
        const upgradeRequest = ctx.extra.request;
        const clientIp = resolveWebSocketClientIp(upgradeRequest);
        const socketPeerIp = resolveWebSocketSocketPeerIp(upgradeRequest);
        const trustedClientIp = upgradeRequest ? getTrustedClientIp(upgradeRequest) : undefined;

        // Which client app this is (identification only, gates nothing).
        // Browsers cannot set headers on the upgrade request, so every platform
        // sends it as a connectionParam; resolveClientIdentity ignores a
        // non-string value the same way controllerMac does above.
        const { clientIdentity, clientIdentityRaw } = resolveClientIdentity(
          connectionParams?.[CLIENT_IDENTITY_CONNECTION_PARAM],
        );

        // Create context on initial connection with auth info
        const context = createContext({
          isAuthenticated,
          userId: authenticatedUserId,
          credentialExpiresAt,
          controllerId,
          controllerApiKey,
          controllerMac,
          controllerOwnerUserId,
          clientIp,
          socketPeerIp,
          trustedClientIp,
          clientIdentity,
          clientIdentityRaw,
        });

        // Bound the COUNT of concurrent anonymous sockets per IP (issue #4035).
        // Authenticated users and validated API-key controllers are exempt —
        // controllers never set isAuthenticated, so a gym's wall controller
        // would otherwise compete with phones browsing on the same NAT.
        const isExemptFromAnonCap = isAuthenticated || controllerId !== undefined;
        if (!isExemptFromAnonCap) {
          // No await between this decision and the acquisition, or interleaved
          // onConnect runs would over-admit past the cap.
          const capResult = tryAcquireAnonConnectionSlot({
            connectionId: context.connectionId,
            clientIp,
            socketPeerIp,
          });

          if (!capResult.allowed) {
            const { tier, key, active, limit } = capResult.rejection;
            // Not throttled: 4429 is fatal for graphql-ws clients, so a rejected
            // caller does not retry into a log flood, and the attribution is
            // what makes a mis-set cap observable before users report it.
            logger.warn('[WebSocket] Rejected anonymous connection over concurrency cap', {
              tier,
              capKey: key,
              active,
              limit,
              clientIp,
              socketPeerIp,
              userAgent: clipHeaderForLog(upgradeRequest?.headers['user-agent']),
              client: clientIdentityRaw ?? UNKNOWN_CLIENT,
            });
            removeContext(context.connectionId);
            ctx.extra.socket.close(ANON_CONNECTION_CAP_CLOSE_CODE, 'Too many anonymous connections');
            return false;
          }

          if (capResult.warning) {
            const { tier, key, active, limit } = capResult.warning;
            logger.warn('[WebSocket] Anonymous connection over warn-only concurrency cap', {
              tier,
              capKey: key,
              active,
              limit,
              clientIp,
              socketPeerIp,
            });
          }

          // Release on the raw socket, not onDisconnect: graphql-ws only runs
          // onDisconnect once `ctx.acknowledged` is set, which happens *after*
          // onConnect resolves. A socket that dies mid-handshake — or an
          // onConnect that throws below in registerClient — would otherwise
          // strand its slot forever, permanently shrinking that IP's budget.
          ctx.extra.socket.once('close', () => releaseAnonConnectionSlot(context.connectionId));
          // ...and the 'close' event may already have fired before that listener
          // was attached, in which case it will never fire again.
          if (ctx.extra.socket.readyState > ctx.extra.socket.OPEN) {
            releaseAnonConnectionSlot(context.connectionId);
            removeContext(context.connectionId);
            return false;
          }
        }

        await roomManager.registerClient(context.connectionId, undefined, authenticatedUserId);
        ctx.extra.socket.once('close', () => kilterLiveSync.releaseConnection(context.connectionId));

        // The socket can die while any of the awaits above are in flight, and
        // graphql-ws only runs onDisconnect once the connection is acknowledged
        // — which happens after onConnect resolves. Nothing would then ever
        // remove the registration this call just made: the local client map has
        // no sweeper, so the entry would sit there for the life of the process.
        // That also blunts the cap, because the anonymous slot is already freed
        // by the raw-socket 'close' listener, leaving a caller free to churn
        // half-handshakes into unbounded room-manager state — the exact state
        // issue #4035 is about bounding.
        if (ctx.extra.socket.readyState > ctx.extra.socket.OPEN) {
          await roomManager.removeClient(context.connectionId);
          removeContext(context.connectionId);
          releaseAnonConnectionSlot(context.connectionId);
          logger.info('[WebSocket] Discarded registration for a socket that closed mid-handshake', {
            connectionId: context.connectionId,
            clientIp,
          });
          return false;
        }

        // Attribution for connectionId → client identity: a subscription-auth
        // denial (see requireSessionMember) only carries the connectionId, so
        // logging the User-Agent + remote address here makes it cheap to trace
        // a noisy/stale client back to its build (issue #2355).
        logger.info(`Client connected: ${context.connectionId} (authenticated: ${isAuthenticated})`, {
          connectionId: context.connectionId,
          authenticated: isAuthenticated,
          userAgent: clipHeaderForLog(upgradeRequest?.headers['user-agent']),
          forwardedFor: clipHeaderForLog(upgradeRequest?.headers['x-forwarded-for']),
          remoteAddress: upgradeRequest?.socket?.remoteAddress,
          clientIp,
          // This can match remoteAddress (and a shared Railway edge) in hosted
          // traffic; it is logged separately because it is the header-free
          // identity that backstops a direct-origin caller.
          socketPeerIp,
          client: clientIdentityRaw ?? UNKNOWN_CLIENT,
        });

        // Store context in ctx.extra for access in other hooks
        ctx.extra.context = context;
        if (isAuthenticated && authenticatedUserId && token && presentedCredential) {
          humanBindings.set(ctx.extra.socket, {
            context,
            token,
            userId: authenticatedUserId,
            credential: presentedCredential,
          });
        }

        // First-party active-user count (#2644). Browsers can't set headers on a
        // WebSocket upgrade, so the connection param comes first; the header is
        // for native clients that send it on the upgrade request instead.
        ctx.extra.activityPlatform = resolveActivityPlatform(
          connectionParams?.[CLIENT_PLATFORM_CONNECTION_PARAM] ?? upgradeRequest?.headers[CLIENT_PLATFORM_HEADER],
        );
        if (authenticatedUserId) void recordUserActivity(authenticatedUserId, ctx.extra.activityPlatform);

        return true; // Allow connection (both authenticated and unauthenticated)
      },
      // context is called for EACH operation - return the stored context
      context: async (ctx: ServerContext): Promise<ConnectionContext> => {
        const extra = ctx.extra;

        if (!extra.context) {
          // This should never happen - onConnect should always set context
          logger.error('[Context] CRITICAL: No context in extra - onConnect may have failed');
          throw new Error('Connection context not initialized - onConnect may have failed');
        }

        // Get the latest context (it may have been updated by mutations like joinSession)
        const latestContext = getContext(extra.context.connectionId);

        if (!latestContext) {
          logger.error(`[Context] Context lost for connection ${extra.context.connectionId}`);
          throw new Error(`Connection context lost for ${extra.context.connectionId}`);
        }

        if (DEBUG) {
          logger.info(
            `[Context] Retrieved context: ${latestContext.connectionId}, sessionId: ${latestContext.sessionId}`,
          );
        }
        // Per operation, not only at connect: a socket held open past UTC
        // midnight still counts its climber on the new day. Deduped in memory,
        // so this is a Set lookup on every operation after the first of the day.
        if (latestContext.isAuthenticated && latestContext.userId) {
          void recordUserActivity(latestContext.userId, extra.activityPlatform ?? 'unknown');
        }
        // One call per operation, so this is the WebSocket counter for the
        // per-minute client usage summary (services/client-usage.ts).
        recordContextOperation(latestContext, 'ws');
        return latestContext;
      },
      onDisconnect: async (ctx: ServerContext, code?: number) => {
        const context = ctx.extra?.context;
        if (context) {
          logger.info(`Client disconnected: ${context.connectionId} (code: ${code})`);

          // Get the latest context state (sessionId may have been updated)
          const latestContext = getContext(context.connectionId);

          // Board-presence crash backstop: if this connection held a board's
          // writer slot, free it (compare-and-delete, no-op once someone else
          // took over). Runs for solo (no-session) holders too, which take the
          // removeClient branch below — so it must be here, the single WS-close
          // chokepoint, and before disconnectClient/removeClient delete the
          // client record it reads. The clean path is the client's BLE-drop
          // reportBoardDisconnect; this only covers crashes.
          await roomManager.clearBoardWriterForConnection(context.connectionId);

          // Handle session cleanup
          if (latestContext?.sessionId) {
            const result = await roomManager.disconnectClient(context.connectionId);

            if (result?.participantFullyLeft) {
              // WS-anonymous participant removed outright (can't be resumed on
              // reconnect) — the schema field is `userId` but clients compare it
              // to `SessionUser.id`, which is the participantId.
              pubsub.publishSessionEvent(result.sessionId, {
                __typename: 'UserLeft',
                userId: result.participantId,
              });
            } else if (result?.presenceUser) {
              pubsub.publishSessionEvent(result.sessionId, {
                __typename: 'UserPresenceChanged',
                user: result.presenceUser,
              });
            }
            if (result?.newLeaderId) {
              pubsub.publishSessionEvent(result.sessionId, {
                __typename: 'LeaderChanged',
                leaderId: result.newLeaderParticipantId || result.newLeaderId,
                leaderConnectionId: result.newLeaderId,
              });
            }
          } else {
            await roomManager.removeClient(context.connectionId);
          }
          removeContext(context.connectionId);
          // Belt-and-braces: the raw-socket 'close' listener attached in
          // onConnect is the load-bearing release (it also covers connections
          // that never got acknowledged). This is idempotent.
          releaseAnonConnectionSlot(context.connectionId);
        }
      },
      onSubscribe: async (ctx: ServerContext, _id: string, payload) => {
        const admission = await checkHumanConnection(ctx);
        if (admission !== 'admitted')
          return [
            new GraphQLError(
              admission === 'unavailable' ? 'Authentication is temporarily unavailable' : 'Authentication is required',
              { extensions: { code: admission === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'UNAUTHENTICATED' } },
            ),
          ];
        // Block this HTTP-only credential before parsing/coercing a document;
        // graphql-ws otherwise sends its original validation errors to clients.
        if (payload.query.includes('exchangeAppleAdsAttribution')) {
          return [new GraphQLError('Apple Ads attribution requires HTTP')];
        }
        if (DEBUG) {
          logger.info(
            `Subscription started: ${payload.operationName?.slice(0, MAX_LOGGED_HEADER_LENGTH) || 'anonymous'}`,
          );
        }

        // Validate query depth to prevent DoS via deeply nested subscriptions
        if (payload.query) {
          let document: DocumentNode;
          try {
            document = typeof payload.query === 'string' ? parse(payload.query) : payload.query;
          } catch (error: unknown) {
            // A thrown parse error escapes into graphql-ws' generic server
            // logger. Return a safe error before its token-bearing source does.
            if (error instanceof GraphQLError && isBoardShareTokenDocument(payload.query)) {
              return [sanitizeBoardShareGraphqlError(error, payload.query)];
            }
            // graphql-ws prints a thrown error whole with console.error, and a
            // syntax error echoes client text. Rethrow it clipped: the socket still
            // closes with 4500, and the code, locations and extensions survive.
            throw error instanceof GraphQLError ? clipThrownGraphqlError(error) : error;
          }
          const depthError = validateQueryDepth(document);
          if (depthError) {
            return [new GraphQLError(depthError)];
          }
        }
      },
      // No admission read per delivery: the sweep closes a deleted account's socket
      // within a second, and a read here would make every live update wait on the
      // primary.
      onNext: (_ctx: ServerContext, _id: string, payload, _executionArgs, result) =>
        sanitizeBoardShareResult(result, payload.query),
      onError: (_ctx: ServerContext, _id: string, payload, errors) => {
        const safeErrors = errors.map((error) =>
          sanitizeBoardShareGraphqlError(sanitizeAppleAdsGraphqlError(error), payload.query),
        );
        logger.error('GraphQL error:', safeErrors.map(clipGraphqlErrorForLog));
        // Only report errors that wrap an internal exception. GraphQLError
        // instances without `originalError` are validation/parse/auth/depth
        // errors triggered by malformed client input — noisy, not actionable.
        for (const err of safeErrors) {
          if (err instanceof GraphQLError && !err.originalError) continue;
          Sentry.captureException(err, { tags: { source: 'graphql-ws' } });
        }
        return safeErrors;
      },
      onComplete: (_ctx: ServerContext, _id: string, payload) => {
        if (DEBUG) {
          logger.info(
            `Subscription completed: ${payload.operationName?.slice(0, MAX_LOGGED_HEADER_LENGTH) || 'anonymous'}`,
          );
        }
      },
    },
    wss,
  );

  // Ping/pong heartbeat to detect dead connections.
  // When a client's network drops silently (phone sleep, WiFi switch, tab killed),
  // the TCP connection becomes half-open and onDisconnect never fires.
  // This interval pings every client; if it doesn't respond before the next ping,
  // the socket is terminated, which triggers onDisconnect and cleans up Redis state.
  wss.on('connection', (ws: WebSocket) => {
    ws.once('close', () => humanBindings.delete(ws));
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.on('pong', () => {
      aliveWs.isAlive = true;
    });
  });

  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const aliveWs = ws as AliveWebSocket;
      if (!aliveWs.isAlive) {
        if (DEBUG) logger.info('[WebSocket] Terminating unresponsive connection');
        aliveWs.terminate();
        return;
      }
      aliveWs.isAlive = false;
      aliveWs.ping();
    });
  }, WS_PING_INTERVAL_MS);

  return { wss, pingInterval };
}

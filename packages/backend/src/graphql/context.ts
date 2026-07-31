import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { logger } from '../utils/logger';

const DEBUG = process.env.NODE_ENV === 'development';

/**
 * Module-level map to track connection contexts.
 * This allows us to look up session info by connectionId.
 * Only WebSocket connections should be stored here — HTTP requests are stateless.
 */
const connections = new Map<string, ConnectionContext>();

/**
 * Options for {@link createContext}. Deliberately an options object rather than
 * a positional list: every field is an optional string, so a positional call
 * could put clientIp in the controllerMac slot and still type-check.
 */
export type CreateContextOptions = {
  connectionId?: string;
  isAuthenticated?: boolean;
  userId?: string;
  controllerId?: string;
  controllerApiKey?: string;
  controllerMac?: string;
  /** Rate-limit identity for anonymous callers; see websocket/client-ip.ts. */
  clientIp?: string;
};

/**
 * Create a new connection context.
 * Called when a WebSocket connection is established.
 */
export function createContext({
  connectionId,
  isAuthenticated,
  userId,
  controllerId,
  controllerApiKey,
  controllerMac,
  clientIp,
}: CreateContextOptions = {}): ConnectionContext {
  const id = connectionId || uuidv4();
  const context: ConnectionContext = {
    connectionId: id,
    transport: 'ws',
    sessionId: undefined,
    userId: userId,
    isAuthenticated: isAuthenticated || false,
    controllerId,
    controllerApiKey,
    controllerMac,
    clientIp,
  };
  connections.set(id, context);
  if (DEBUG) {
    logger.info(
      `[Context] createContext: ${id} (authenticated: ${isAuthenticated}, userId: ${userId}, controllerId: ${controllerId}, mac: ${controllerMac}). Total connections: ${connections.size}`,
    );
  }
  return context;
}

/**
 * Get an existing connection context by ID.
 */
export function getContext(connectionId: string): ConnectionContext | undefined {
  return connections.get(connectionId);
}

/**
 * Update an existing connection context.
 * Used when a user joins/leaves a session.
 * Gracefully handles missing connections (expected when WS disconnects mid-operation).
 */
export function updateContext(connectionId: string, updates: Partial<Omit<ConnectionContext, 'connectionId'>>): void {
  const context = connections.get(connectionId);
  if (!context) {
    logger.warn(
      `[Context] updateContext: connection ${connectionId} not found (likely disconnected mid-operation). Map has ${connections.size} entries.`,
    );
    return;
  }

  if (DEBUG) {
    logger.info(
      `[Context] updateContext: ${connectionId} -> sessionId=${updates.sessionId}, participantId=${updates.participantId}, userId=${updates.userId}`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'sessionId')) {
    context.sessionId = updates.sessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'participantId')) {
    context.participantId = updates.participantId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'userId')) {
    context.userId = updates.userId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'isAuthenticated')) {
    context.isAuthenticated = updates.isAuthenticated;
  }
}

/**
 * Remove a connection context.
 * Called when a WebSocket connection is closed.
 * @returns The removed context, or undefined if not found
 */
export function removeContext(connectionId: string): ConnectionContext | undefined {
  const context = connections.get(connectionId);
  connections.delete(connectionId);
  return context;
}

/**
 * Get all connection IDs for a given session.
 * Useful for broadcasting to all users in a session.
 */
export function getConnectionsForSession(sessionId: string): string[] {
  const result: string[] = [];
  for (const [connId, ctx] of connections) {
    if (ctx.sessionId === sessionId) {
      result.push(connId);
    }
  }
  return result;
}

/**
 * Get total count of active connections.
 * Useful for debugging.
 */
export function getConnectionCount(): number {
  return connections.size;
}

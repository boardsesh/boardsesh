import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { QUANTUM_RELAY_RETENTION_HARD_LIMITS } from './constants';
import { QuantumSyncError, quantumSyncErrorMessage } from './errors';
import type { LoadNostrEvents, QuantumManifestQuery } from './types';

export type NostrWebSocketEvent = { data?: unknown };

export type NostrWebSocketLike = {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: NostrWebSocketEvent) => void): void;
  removeEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: NostrWebSocketEvent) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type NostrWebSocketFactory = (relayUrl: string) => NostrWebSocketLike;
export type QueryNostrRelay = (relayUrl: string, query: Readonly<QuantumManifestQuery>) => Promise<readonly unknown[]>;

export type LoadNostrRelayOptions = {
  webSocketFactory?: NostrWebSocketFactory;
  queryRelay?: QueryNostrRelay;
};

export function createNostrEventLoader(options: LoadNostrRelayOptions = {}): LoadNostrEvents {
  const queryRelay =
    options.queryRelay ??
    ((relayUrl: string, query: Readonly<QuantumManifestQuery>) =>
      queryNostrRelay(relayUrl, query, options.webSocketFactory));

  return async (query) => {
    assertRelayRetentionLimits(query);
    const settled = await Promise.allSettled(
      query.relays.map(async (relayUrl) => {
        const relayEvents = await queryRelay(relayUrl, query);
        if (relayEvents.length > query.maxEventsPerRelay) {
          throw new QuantumSyncError(
            'NOSTR_RELAY_FAILED',
            `Quantum Nostr relay ${relayUrl} exceeded the configured event limit.`,
          );
        }
        return relayEvents;
      }),
    );
    const successes = settled.filter(
      (result): result is PromiseFulfilledResult<readonly unknown[]> => result.status === 'fulfilled',
    );
    if (successes.length === 0) {
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => quantumSyncErrorMessage(result.reason));
      throw new QuantumSyncError(
        'NOSTR_RELAY_FAILED',
        `Every Quantum Nostr relay query failed (${failures.join('; ')}).`,
      );
    }

    const events: unknown[] = [];
    const seenIds = new Set<string>();
    for (const success of successes) {
      for (const event of success.value) {
        const eventId = readEventId(event);
        if (eventId && seenIds.has(eventId)) continue;
        if (eventId) seenIds.add(eventId);
        events.push(event);
      }
    }
    return events;
  };
}

export async function queryNostrRelay(
  relayUrl: string,
  query: Readonly<QuantumManifestQuery>,
  webSocketFactory: NostrWebSocketFactory = defaultWebSocketFactory,
): Promise<readonly unknown[]> {
  assertRelayRetentionLimits(query);
  const socket = webSocketFactory(relayUrl);
  const subscriptionId = `boardsesh-quantum-${randomBytes(8).toString('hex')}`;

  return await new Promise<readonly unknown[]>((resolve, reject) => {
    const events: unknown[] = [];
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      query.signal?.removeEventListener('abort', onAbort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };

    const finish = (result: readonly unknown[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.send(JSON.stringify(['CLOSE', subscriptionId]));
      } catch {
        // A relay can close between EOSE and our CLOSE frame. The result is
        // already complete, so transport cleanup must not turn it into failure.
      }
      try {
        socket.close(1000, 'manifest query complete');
      } catch {
        // The peer may already be closed after sending EOSE.
      }
      resolve(result);
    };

    const fail = (message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.close(1000, 'manifest query failed');
      } catch {
        // Closing a CONNECTING browser socket can throw. Rejection still has to
        // settle the query so an unavailable relay cannot hang the daemon.
      }
      reject(new QuantumSyncError('NOSTR_RELAY_FAILED', message, { cause }));
    };

    const onOpen = () => {
      const filter = {
        kinds: [query.kind],
        authors: [query.signerPubkey],
        '#d': [query.dTag],
        limit: query.maxEventsPerRelay,
      };
      try {
        socket.send(JSON.stringify(['REQ', subscriptionId, filter]));
      } catch (error) {
        fail(`Quantum Nostr relay ${relayUrl} rejected the manifest request.`, error);
      }
    };

    const onMessage = (event: NostrWebSocketEvent) => {
      const payloadByteLength = websocketPayloadByteLength(event.data);
      if (payloadByteLength === null) return;
      if (payloadByteLength > maximumRelayMessageBytes(query.maxManifestBytes)) {
        fail(`Quantum Nostr relay ${relayUrl} sent an oversized message.`);
        return;
      }
      const text = websocketText(event.data);
      if (text === null) return;

      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (!Array.isArray(message) || message.length < 2) return;
      if (message[0] === 'EOSE' && message[1] === subscriptionId) {
        finish(Object.freeze([...events]));
        return;
      }
      if (message[0] === 'CLOSED' && message[1] === subscriptionId) {
        fail(`Quantum Nostr relay ${relayUrl} closed the manifest subscription.`);
        return;
      }
      if (message[0] !== 'EVENT' || message[1] !== subscriptionId || message.length < 3) return;
      if (events.length >= query.maxEventsPerRelay) {
        fail(`Quantum Nostr relay ${relayUrl} exceeded the configured event limit.`);
        return;
      }
      const candidate = message[2];
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        fail(`Quantum Nostr relay ${relayUrl} sent a malformed manifest event.`);
        return;
      }
      const content = (candidate as Record<string, unknown>).content;
      if (typeof content !== 'string') {
        fail(`Quantum Nostr relay ${relayUrl} sent a malformed manifest event.`);
        return;
      }
      if (Buffer.byteLength(content, 'utf8') > query.maxManifestBytes) {
        fail(`Quantum Nostr relay ${relayUrl} sent an oversized manifest event.`);
        return;
      }
      events.push(candidate);
    };

    const onError = (event: NostrWebSocketEvent) => {
      fail(`Quantum Nostr relay ${relayUrl} failed.`, event);
    };
    const onClose = () => {
      fail(`Quantum Nostr relay ${relayUrl} closed before EOSE.`);
    };
    const onAbort = () => {
      fail('Quantum Nostr relay query was aborted.');
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    query.signal?.addEventListener('abort', onAbort, { once: true });
    timeoutId = setTimeout(() => {
      fail(`Quantum Nostr relay ${relayUrl} did not reach EOSE before the timeout.`);
    }, query.relayTimeoutMs);

    if (query.signal?.aborted) onAbort();
  });
}

const RELAY_EVENT_ENVELOPE_BYTES = 64 * 1024;

function maximumRelayMessageBytes(maxManifestBytes: number): number {
  // The manifest JSON is itself JSON-escaped in the Nostr EVENT frame. Two
  // frame bytes per manifest byte plus a bounded envelope covers valid payload
  // escaping while preventing the former fixed 2 MiB allocation.
  return maxManifestBytes * 2 + RELAY_EVENT_ENVELOPE_BYTES;
}

function assertRelayRetentionLimits(query: Readonly<QuantumManifestQuery>): void {
  if (
    !Number.isSafeInteger(query.maxManifestBytes) ||
    query.maxManifestBytes <= 0 ||
    query.maxManifestBytes > QUANTUM_RELAY_RETENTION_HARD_LIMITS.maxManifestBytes
  ) {
    throw new QuantumSyncError(
      'CONFIG_INVALID',
      `Quantum maxManifestBytes must be between 1 and ${QUANTUM_RELAY_RETENTION_HARD_LIMITS.maxManifestBytes}.`,
    );
  }
  if (
    !Number.isSafeInteger(query.maxEventsPerRelay) ||
    query.maxEventsPerRelay <= 0 ||
    query.maxEventsPerRelay > QUANTUM_RELAY_RETENTION_HARD_LIMITS.maxEventsPerRelay
  ) {
    throw new QuantumSyncError(
      'CONFIG_INVALID',
      `Quantum maxEventsPerRelay must be between 1 and ${QUANTUM_RELAY_RETENTION_HARD_LIMITS.maxEventsPerRelay}.`,
    );
  }
}

function websocketPayloadByteLength(value: unknown): number | null {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}

function defaultWebSocketFactory(relayUrl: string): NostrWebSocketLike {
  if (typeof WebSocket === 'undefined') {
    throw new QuantumSyncError('NOSTR_RELAY_FAILED', 'This runtime does not provide WebSocket support.');
  }
  return new WebSocket(relayUrl) as unknown as NostrWebSocketLike;
}

function websocketText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  }
  return null;
}

function readEventId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

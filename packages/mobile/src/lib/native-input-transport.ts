/** Temporary diagnostic transport. No application callback ever waits for it. */
export const INPUT_TRACE_STAGES = [
  'raw-wrapper',
  'raw-wrapper-returned',
  'make-toggle-entry',
  'make-toggle-disabled-return',
  'before-haptic',
  'after-haptic',
  'before-parent-callback',
  'after-parent-callback',
  'parent-handler-entry',
  'parent-start-pending-return',
  'state-queue-request',
  'state-queued',
  'visibility-analytics-called',
  'switch-row-mounted',
  'switch-row-unmounted',
  'switch-row-props-committed',
  'pre-session-mounted',
  'pre-session-unmounted',
  'pre-session-state-committed',
  'diagnostic-heartbeat',
  'trace-window-ack',
] as const;
export const INPUT_TRACE_STRINGS = [
  'stage',
  'timestamp',
  'runtimeId',
  'attemptId',
  'interactionId',
  'switchRowId',
  'componentId',
  'parentId',
  'semanticRole',
  'challengeId',
] as const;
export const INPUT_TRACE_BOOLEANS = [
  'isOn',
  'next',
  'capturedDisabled',
  'capturedIsStartPending',
  'isPublic',
  'isStartPending',
  'value',
  'disabled',
] as const;
export type InputTrace = Record<string, string | boolean | number>;
export type InputTraceCounters = { sourceSequence: number; queueDepth: number; dropped: number; errors: number };
export type InputTracePacket = { runtimeId: string; events: InputTrace[]; counters: InputTraceCounters };
export type InputTraceRequest = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
export function createInputTraceTransport(options: {
  runtimeId: string;
  url: string;
  request?: InputTraceRequest;
  serialize?: (packet: InputTracePacket) => string;
}) {
  const request = options.request ?? fetch;
  const serialize = options.serialize ?? JSON.stringify;
  const queue: InputTrace[] = [];
  let sourceSequence = 0,
    dropped = 0,
    errors = 0,
    closed = false,
    inFlight = false,
    scheduled = false;
  const heartbeats = new Set<ReturnType<typeof setInterval>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let cancelDeadline: (() => void) | undefined;
  const seenChallenges = new Set<string>();
  let pendingChallenge: string | undefined;
  const counters = (): InputTraceCounters => ({ sourceSequence, queueDepth: queue.length, dropped, errors });
  function schedule() {
    try {
      if (closed || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void flush();
      });
    } catch {
      scheduled = false;
      errors++;
      dropped += queue.length;
      queue.length = 0;
    }
  }
  function emit(fields: Record<string, unknown>): void {
    try {
      const sequence = ++sourceSequence;
      if (closed || queue.length >= 128 || sourceSequence > 512) {
        dropped++;
        return;
      }
      const event: InputTrace = { runtimeId: options.runtimeId, sourceSequence: sequence };
      for (const field of INPUT_TRACE_STRINGS) {
        const content = fields[field];
        if (typeof content === 'string' && /^[\w.:+-]{1,120}$/.test(content)) event[field] = content;
      }
      for (const field of INPUT_TRACE_BOOLEANS) {
        const content = fields[field];
        if (typeof content === 'boolean') event[field] = content;
      }
      event.runtimeId = options.runtimeId;
      if (!INPUT_TRACE_STAGES.includes(event.stage as (typeof INPUT_TRACE_STAGES)[number])) {
        dropped++;
        return;
      }
      queue.push(event);
      schedule();
    } catch {
      errors++;
      dropped++;
    }
  }
  async function flush(): Promise<void> {
    if (closed || inFlight || queue.length === 0) return;
    inFlight = true;
    let batch: InputTrace[] = [];
    try {
      batch = queue.splice(0, 4);
      const destination = new URL(options.url);
      if (destination.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(destination.hostname))
        throw Error('diagnostic_loopback_required');
      const body = serialize({ runtimeId: options.runtimeId, events: batch, counters: counters() });
      if (body.length > 8192) throw Error('diagnostic_packet_size');
      controller = new AbortController();
      // Promise race bounds even a diagnostic request implementation ignoring abort.
      const deadline = new Promise<never>((_, reject) => {
        cancelDeadline = () => reject(Error('diagnostic_closed'));
        timer = setTimeout(() => {
          controller?.abort();
          reject(Error('diagnostic_timeout'));
        }, 1000);
      });
      const response = await Promise.race([
        request(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (!response.ok) throw Error('diagnostic_rejected');
      const reply = await Promise.race([response.json() as Promise<{ challengeId?: unknown }>, deadline]);
      if (
        typeof reply.challengeId === 'string' &&
        /^[\w-]{1,64}$/.test(reply.challengeId) &&
        !seenChallenges.has(reply.challengeId)
      ) {
        seenChallenges.add(reply.challengeId);
        pendingChallenge = reply.challengeId;
      }
    } catch {
      errors++;
      dropped += batch.length;
    } finally {
      if (timer) clearTimeout(timer);
      timer = undefined;
      cancelDeadline = undefined;
      controller = undefined;
      inFlight = false;
      if (!closed) {
        if (queue.length) schedule();
        else if (pendingChallenge) {
          const challengeId = pendingChallenge;
          pendingChallenge = undefined;
          emit({ stage: 'trace-window-ack', challengeId, timestamp: new Date().toISOString() });
        }
      }
    }
  }
  return {
    emit,
    counters,
    startHeartbeat(fields: () => Record<string, unknown>): () => void {
      let ownedTimer: ReturnType<typeof setInterval> | undefined;
      try {
        ownedTimer = setInterval(() => {
          try {
            emit({ stage: 'diagnostic-heartbeat', timestamp: new Date().toISOString(), ...fields() });
          } catch {
            errors++;
            dropped++;
          }
        }, 1000);
        heartbeats.add(ownedTimer);
      } catch {
        errors++;
        dropped++;
      }
      return () => {
        if (ownedTimer) {
          clearInterval(ownedTimer);
          heartbeats.delete(ownedTimer);
          ownedTimer = undefined;
        }
      };
    },
    close() {
      closed = true;
      pendingChallenge = undefined;
      for (const heartbeat of heartbeats) clearInterval(heartbeat);
      heartbeats.clear();
      if (timer) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      cancelDeadline?.();
      dropped += queue.length;
      queue.length = 0;
    },
  };
}

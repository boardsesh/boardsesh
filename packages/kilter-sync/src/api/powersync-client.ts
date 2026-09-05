// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { KILTER_POWERSYNC_STREAM_URL } from './types';
import { KilterApiError } from './errors';

/**
 * Streams Kilter's PowerSync `/sync/stream` endpoint and yields parsed
 * row operations grouped by table.
 *
 * Kilter's PowerSync wire is application/x-ndjson: one JSON object per
 * line. Two line shapes:
 *
 *   1. `{"checkpoint": {...}}` — checkpoint envelope with bucket list,
 *      counts, op_ids, subscriptions, streams. One per request.
 *   2. `{"data": {"bucket": "<name>", "after": "<op_id>", "has_more": bool,
 *                 "data": [<op>, <op>, ...]}}` — a batch of operations
 *      against a single bucket.
 *
 * Each op is `{"op_id", "op": "PUT"|"REMOVE", "object_type", "object_id",
 *              "checksum", "subkey", "data": {...row...}}`. The row fields
 *      live under `op.data` (snake_case keys).
 *
 * Subscribing to a subset of streams (e.g. `user_buckets` only) avoids
 * draining the full catalog when we only want per-user state. The Kilter
 * server requires every subscription to specify `override_priority` (we
 * pass null) and `parameters` (we pass {}).
 */

export type KilterStream = 'global' | 'global_gyms' | 'global_climbs' | 'user_buckets' | 'circuit_buckets';

export type PowerSyncOp = {
  op_id: string;
  op: 'PUT' | 'REMOVE';
  object_type: string;
  object_id: string;
  checksum?: number;
  subkey?: string;
  data?: Record<string, unknown>;
};

/**
 * Abort only when the stream STOPS MAKING PROGRESS, not after a fixed wall
 * clock. This used to be a flat 120s cap on the whole request, which is the
 * wrong shape twice over:
 *
 *   - The duration of a snapshot scales with the size of the account. A cap
 *     that a small account never reaches is one a large account can never
 *     satisfy, so it reads as "upstream is broken" when the real meaning is
 *     "this climber has a lot of ticks". One production account sat permanently
 *     at ~127s against the 120s cap and could never complete a sync.
 *   - `onOp` is awaited inline in the read loop, so time spent writing to
 *     Postgres counted against what is nominally a network timeout. A slow
 *     database made the upstream look unresponsive.
 *
 * Progress means a line arrived OR an op finished applying, so a long flush is
 * not mistaken for a stall. A genuinely hung upstream still trips this in one
 * idle window.
 */
const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Absolute backstop so a pathological stream cannot occupy the daemon forever
 * — it syncs one user per cycle, so an unbounded read would starve everyone
 * else. Deliberately far above any healthy snapshot: this is a runaway guard,
 * not a latency budget.
 */
const STREAM_MAX_DURATION_MS = 10 * 60_000;

/** How often the stall detector checks. Cheap; granularity is not critical. */
const STALL_CHECK_INTERVAL_MS = 5_000;

function buildRequestBody(streams: KilterStream[]): string {
  return JSON.stringify({
    streams: {
      include_defaults: false,
      subscriptions: streams.map((name) => ({
        stream: name,
        override_priority: null,
        parameters: {},
      })),
    },
  });
}

/**
 * Read a fetch Response's body as an async iterator of complete NDJSON
 * lines. Tolerates partial lines straddling chunk boundaries.
 */
async function* readNdjsonLines(response: Response): AsyncIterable<string> {
  if (!response.body) {
    throw new KilterApiError('powersync', 'PowerSync response has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield line;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export type CheckpointEnvelope = {
  checkpoint: {
    last_op_id: string;
    buckets: Array<{
      bucket: string;
      checksum: number;
      count: number;
      priority: number;
      subscriptions: Array<{ default: number }>;
    }>;
    streams: Array<{ name: string; is_default: boolean; errors: unknown[] }>;
  };
};

export type DataEnvelope = {
  data: {
    bucket: string;
    after: string;
    has_more: boolean;
    next_after?: string;
    data: PowerSyncOp[];
  };
};

/**
 * Sent once Kilter has finished delivering the initial snapshot for every
 * subscribed bucket. After this line the server holds the connection open
 * for live updates and emits periodic `token_expires_in` keepalives —
 * neither of which we want for a one-shot sync, so the caller aborts the
 * fetch on this signal.
 */
export type CheckpointCompleteEnvelope = {
  checkpoint_complete: Record<string, unknown>;
};

/**
 * Periodic keepalive from the server after `checkpoint_complete`. We
 * never get here because we abort first, but the type is here for
 * completeness if we ever want to support a long-lived sync.
 */
export type TokenExpiresInEnvelope = {
  token_expires_in: number;
};

export type StreamLine = CheckpointEnvelope | DataEnvelope | CheckpointCompleteEnvelope | TokenExpiresInEnvelope;

/**
 * Open a PowerSync stream with the given subscriptions and consume every
 * row. The connection stays open until Kilter completes the snapshot —
 * for the catalog buckets that's tens of seconds and tens of MBs. The
 * caller's `onOp` is called once per operation, ordered as Kilter sends
 * them (and the protocol guarantees FK-safe ordering inside a bucket
 * because the sync rules ensure parents arrive before children).
 *
 * `onCheckpoint` fires once near the top of the stream with the bucket
 * list. We use it to size logs and to early-abort if a required bucket
 * isn't present.
 */
export async function streamKilterPowerSync(args: {
  accessToken: string;
  streams: KilterStream[];
  onOp: (op: PowerSyncOp) => void | Promise<void>;
  onCheckpoint?: (checkpoint: CheckpointEnvelope['checkpoint']) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { accessToken, streams, onOp, onCheckpoint, signal } = args;

  // Fast-path: a pre-aborted caller signal must short-circuit to the
  // documented "cancelled by caller" error. addEventListener('abort', …)
  // does NOT fire for a signal that's already aborted, so without this
  // guard the fetch would proceed normally and the cancellation intent
  // would be lost. See Batch E fix 18.
  if (signal?.aborted === true) {
    throw new KilterApiError('powersync', 'PowerSync stream cancelled by caller');
  }

  // Combine the caller's signal with our snapshot-complete signal so a
  // checkpoint_complete envelope shuts down the live-update part of the
  // stream cleanly. Track the caller signal and the timeout signal
  // separately so the catch block below can distinguish caller-shutdown
  // (intentional) from timeout (transient) from snapshot-complete (success).
  const completionController = new AbortController();

  // The stall detector runs even when the caller supplies a signal. Previously
  // a caller signal REPLACED the timeout, so anyone passing a shutdown signal
  // silently gave up every timeout protection — a latent footgun that happened
  // not to bite only because the one caller that passes a signal is short-lived.
  const stallController = new AbortController();
  let timeoutReason: 'idle' | 'max-duration' | null = null;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  // True while an op is being applied. The idle check is suspended for that
  // window: this timeout exists to detect an UNRESPONSIVE UPSTREAM, and a slow
  // local write is not that. Counting write time as idleness is the same
  // category error the old fixed cap made, just at a smaller scale — a big
  // flush against a busy database would abort a perfectly healthy stream.
  let applying = false;
  const markProgress = () => {
    lastProgressAt = Date.now();
  };
  const stallTimer = setInterval(() => {
    const now = Date.now();
    // The absolute ceiling still applies while applying: it is a runaway guard,
    // so it deliberately covers local work too.
    if (now - startedAt > STREAM_MAX_DURATION_MS) {
      timeoutReason = 'max-duration';
      stallController.abort();
      return;
    }
    if (!applying && now - lastProgressAt > STREAM_IDLE_TIMEOUT_MS) {
      timeoutReason = 'idle';
      stallController.abort();
    }
  }, STALL_CHECK_INTERVAL_MS);

  for (const upstream of [signal, stallController.signal]) {
    upstream?.addEventListener('abort', () => completionController.abort(upstream.reason), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(KILTER_POWERSYNC_STREAM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: buildRequestBody(streams),
      signal: completionController.signal,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new KilterApiError('timeout', `PowerSync stream timed out`);
    }
    throw new KilterApiError('network', `PowerSync stream open failed: ${(err as Error).message ?? err}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new KilterApiError('unauthorized', `PowerSync stream rejected token: ${text.slice(0, 200)}`, 401);
    }
    throw new KilterApiError(
      'powersync',
      `PowerSync stream HTTP ${response.status}: ${text.slice(0, 200)}`,
      response.status,
    );
  }

  try {
    // Always abort the fetch on any loop exit — success
    // (checkpoint_complete `return`), an `onOp` throw, a caller/timeout
    // abort, or an unexpected read error. Without this, only the
    // checkpoint_complete path released the connection, leaking the open
    // HTTP stream on every other exit. The catch block below still owns
    // error classification; the `finally` only frees the socket.
    for await (const line of readNdjsonLines(response)) {
      markProgress();
      let parsed: StreamLine;
      try {
        parsed = JSON.parse(line) as StreamLine;
      } catch {
        // Skip un-parseable lines instead of aborting; they're rare and
        // usually an empty keepalive in well-formed PowerSync streams.
        continue;
      }

      if ('checkpoint' in parsed && parsed.checkpoint) {
        onCheckpoint?.(parsed.checkpoint);
        continue;
      }

      if ('checkpoint_complete' in parsed) {
        // Snapshot done. Return to release the connection — the `finally`
        // aborts the fetch, which the server would otherwise hold open
        // for live updates we don't want.
        return;
      }

      if ('token_expires_in' in parsed) {
        // Keepalive — we return on checkpoint_complete so we shouldn't
        // normally see one, but tolerate it gracefully.
        continue;
      }

      if ('data' in parsed && parsed.data && Array.isArray(parsed.data.data)) {
        for (const op of parsed.data.data) {
          if (op.op !== 'PUT' && op.op !== 'REMOVE') continue;
          // Intentional: any throw from `onOp` propagates up and exits
          // the read loop for this cycle (the `finally` below then aborts
          // the underlying fetch so we don't leak the HTTP stream). The
          // trade-off is strict — one bad op drops the user's entire
          // pull — but the alternative (catch + continue) would leave the
          // partial applied set with no signal that something was
          // skipped. The daemon's transient-error retry policy re-runs
          // the cycle next tick, so a transient writer failure
          // self-heals. A persistent one becomes a Sentry-visible
          // failure for the user, which is what we want.
          applying = true;
          try {
            await onOp(op);
          } finally {
            applying = false;
            // Restart the idle window from the end of the write, not its start.
            markProgress();
          }
        }
      }
    }
  } catch (err) {
    // Aborting an in-flight fetch surfaces as DOMException/AbortError in
    // the reader. Three cases worth distinguishing — they all hit this
    // catch as an AbortError but mean different things to the caller:
    //   (a) Snapshot-complete swallow: we aborted ourselves because the
    //       server sent checkpoint_complete. Neither the caller's signal
    //       nor the timeout signal fired. Treat as success.
    //   (b) Caller-initiated shutdown (daemon SIGTERM, request cancel):
    //       the caller's `signal` is aborted. Surface as a powersync
    //       error rather than 'timeout' so the daemon's shutdown path
    //       doesn't think the upstream is flaky and retry.
    //   (c) Per-request timeout: REQUEST_TIMEOUT_MS elapsed and our
    //       internal AbortSignal.timeout fired. Surface as 'timeout' so
    //       isTransientKilterError lets the daemon retry next cycle.
    // TS narrowed `signal.aborted` to `false` after the early-return
    // guard at the top (which throws when it's `true` at call time).
    // The listener can still abort it asynchronously while we read; the
    // cast keeps the runtime check honest without weakening the type at
    // the top.
    const callerAborted = (signal as AbortSignal | undefined)?.aborted === true;
    const timedOut = timeoutReason !== null;
    if (completionController.signal.aborted && !callerAborted && !timedOut) {
      return;
    }
    if (callerAborted) {
      throw new KilterApiError('powersync', 'PowerSync stream cancelled by caller');
    }
    if (timedOut || (err instanceof Error && err.name === 'AbortError')) {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      // Name the reason: "stalled" and "ran too long" call for different
      // responses, and the old single message made a size problem look like an
      // upstream outage.
      const detail =
        timeoutReason === 'max-duration'
          ? `exceeded the ${Math.round(STREAM_MAX_DURATION_MS / 1000)}s ceiling`
          : timeoutReason === 'idle'
            ? `no progress for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s`
            : 'aborted';
      throw new KilterApiError('timeout', `PowerSync stream ${detail} after ${elapsedSeconds}s`);
    }
    throw err;
  } finally {
    clearInterval(stallTimer);
    // Release the underlying fetch/HTTP stream on every exit path. The
    // catch above runs first (JS evaluates catch before finally), so its
    // error classification still observes the pre-abort
    // `completionController.signal.aborted` state. abort() on an already
    // aborted controller is a no-op, so the checkpoint_complete and
    // caller/timeout paths are unaffected.
    completionController.abort();
  }
}

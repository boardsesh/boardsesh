// The live "how much is waiting" gauge behind the connectivity banner (issue
// #4862). The banner has to say "3 changes waiting" and then count them down as
// the drainer works, so a one-shot read at mount is not enough.
//
// Every number here comes from a fresh `getOutboxSummary` against the outbox
// table — never from arithmetic on the previous value. A counter incremented per
// enqueue and decremented per ack drifts the first time anything writes the
// outbox outside these two paths (the sign-out purge, a dead letter retried from
// the sync-issues screen, a drain that lands while the app is backgrounded), and
// a banner stuck at "1 change waiting" over an empty queue is worse than no
// count at all. Re-reading is a grouped SELECT against a table that holds tens of
// rows, so the cost of being right is negligible.
//
// A module store rather than context: the writes that dirty it (`enqueue` in
// use-offline-mutations) are plain async functions with no React scope, and the
// drain acks arrive from a non-React listener.

import { useCallback, useSyncExternalStore } from 'react';
import { getOutboxSummary, type SqlExecutor } from '@boardsesh/offline-sync';
import { subscribeMutationDelivery } from './offline-sync-adapter';

/**
 * Pending + dead-lettered counts, or `null` for "we don't know". `null` is the
 * cold-start state and the read-failure state — the schema is created lazily, so
 * a query before it exists throws — and the banner hides its count line rather
 * than claiming a zero it hasn't verified.
 */
export type OutboxSummarySnapshot = { pendingCount: number; deadLetterCount: number } | null;

// A drain acknowledges mutations one at a time, so a backlog of twelve fires
// twelve delivery events inside a few hundred milliseconds. Coalesce them into a
// single read; the count animating down in ~150ms steps is also the honest
// reading of what is happening.
const REFRESH_DEBOUNCE_MS = 150;

let snapshot: OutboxSummarySnapshot = null;
let boundDatabase: SqlExecutor | null = null;
const listeners = new Set<() => void>();

let deliveryUnsubscribe: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
// Reads are async and can overlap (a delivery burst during a slow query), and
// SQLite makes no promise about which finishes first. Only the newest read may
// publish, or a stale count can land on top of a fresher one.
let refreshGeneration = 0;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function isSameSnapshot(left: OutboxSummarySnapshot, right: OutboxSummarySnapshot): boolean {
  if (left === null || right === null) return left === right;
  return left.pendingCount === right.pendingCount && left.deadLetterCount === right.deadLetterCount;
}

// `useSyncExternalStore` compares snapshots by identity, so publishing an
// equal-but-new object on every drain ack would re-render the banner (and its
// bottom-chrome consumers) for a value that did not change.
function publish(next: OutboxSummarySnapshot): void {
  if (isSameSnapshot(snapshot, next)) return;
  snapshot = next;
  notify();
}

async function runRefresh(): Promise<void> {
  const database = boundDatabase;
  // Re-check the subscriber count here, not only when the read was scheduled: a
  // debounced read whose last consumer unmounted mid-wait has nobody to tell.
  if (database === null || listeners.size === 0) return;
  const generation = ++refreshGeneration;
  try {
    const summary = await getOutboxSummary(database);
    if (generation !== refreshGeneration) return;
    publish({ pendingCount: summary.pendingCount, deadLetterCount: summary.deadLetterCount });
  } catch {
    if (generation !== refreshGeneration) return;
    // No table yet, or a handle that closed under us. Report "unknown", never 0 —
    // the banner would otherwise tell a climber their sends are through when the
    // truth is that we could not look.
    publish(null);
  }
}

function scheduleRefresh(): void {
  // Reads happen only while at least one subscriber exists. That is a weaker
  // guarantee than it sounds: the banner stays MOUNTED for the whole session
  // (it renders null when hidden), so in practice something is nearly always
  // subscribed. What this really buys is the pre-mount window and the tests —
  // the real cost control is the debounce below plus the fact that an idle app
  // produces no delivery events to read for.
  if (listeners.size === 0) return;
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void runRefresh();
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * Something wrote the outbox. Called by the enqueue sites in
 * use-offline-mutations after their transaction commits — a no-op while nothing
 * is subscribed, and otherwise one debounced re-read.
 */
export function notifyOutboxChanged(): void {
  scheduleRefresh();
}

function startWatching(): void {
  if (deliveryUnsubscribe === null) {
    // Each acknowledged / dead-lettered mutation removes or reclassifies a row,
    // which is exactly what the count is made of.
    deliveryUnsubscribe = subscribeMutationDelivery(() => scheduleRefresh());
  }
  // No AppState listener here on purpose: this module sits in the hooks
  // barrel's import graph (use-offline-mutations → here), and a static
  // `react-native` import would drag its Flow source into every Vitest suite
  // that loads the barrel. The foreground re-read lives in the banner hook
  // (use-connectivity-banner.ts), which already runs inside the app and calls
  // notifyOutboxChanged() on `active`.
}

function stopWatching(): void {
  deliveryUnsubscribe?.();
  deliveryUnsubscribe = null;
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) startWatching();
  // First subscriber (or a re-subscribe after the handle changed) needs a read;
  // later ones just join the one already published.
  scheduleRefresh();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWatching();
  };
}

function getOutboxSnapshot(): OutboxSummarySnapshot {
  return snapshot;
}

// The handle arrives late (null until the SQLite schema is ready) and changes on
// sign-out. Counts read from a handle nobody holds any more describe a database
// that is gone, so drop them rather than show them against the new one.
function bindOutboxDatabase(database: SqlExecutor | null): void {
  if (database === boundDatabase) return;
  boundDatabase = database;
  snapshot = null;
}

/**
 * Live outbox counts for `db`, or `null` while unknown. Pass the nullable handle
 * straight from `getDatabaseHandle()` — a null handle simply means no counts.
 */
export function useOutboxSummary(db: SqlExecutor | null): OutboxSummarySnapshot {
  // Binding inside `subscribe` (rather than an effect) is what keeps the store
  // and React in step: React re-subscribes whenever this callback's identity
  // changes, so the handle is bound and the first read scheduled in the same
  // pass that starts watching, and `getSnapshot` is read again straight after.
  const subscribe = useCallback(
    (listener: () => void) => {
      bindOutboxDatabase(db);
      return subscribeOutbox(listener);
    },
    [db],
  );
  return useSyncExternalStore(subscribe, getOutboxSnapshot);
}

export function __resetOutboxStoreForTests(): void {
  stopWatching();
  listeners.clear();
  snapshot = null;
  boundDatabase = null;
  refreshGeneration = 0;
}

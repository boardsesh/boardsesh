import { useSyncExternalStore } from 'react';
import type { ScopeDownloadProgress, SyncProgress } from '@boardsesh/offline-sync';

export type DownloadActivity = {
  progress: ScopeDownloadProgress;
  status: 'active' | 'waiting' | 'failed' | 'done';
};

const listeners = new Set<() => void>();
const activitiesByScope = new Map<string, DownloadActivity>();
const queuedUserScopes = new Set<string>();
const retiredScopes = new Set<string>();
let enabledScopes: Set<string> | null = null;
let current: DownloadActivity | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
const STALE_MS = 60_000;
const DONE_MS = 3_000;

export function getDownloadActivity(): DownloadActivity | null {
  return current;
}

/** Async work from an earlier signed-in session must not revive its indicator. */
export function getDownloadActivityGeneration(): number {
  return generation;
}

export function subscribeDownloadActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: DownloadActivity | null): void {
  const previous = current;
  current = next;
  if (
    previous?.status === next?.status &&
    previous?.progress.scopeKey === next?.progress.scopeKey &&
    previous?.progress.phase === next?.progress.phase &&
    Math.round((previous?.progress.fraction ?? -1) * 100) === Math.round((next?.progress.fraction ?? -1) * 100) &&
    previous?.progress.queuedScopes === next?.progress.queuedScopes &&
    previous?.progress.rowsProcessed === next?.progress.rowsProcessed
  ) {
    current = previous;
    return;
  }
  for (const listener of listeners) listener();
}

function waitingActivity(scopeKey: string): DownloadActivity {
  return {
    status: 'waiting',
    progress: { scopeKey, phase: 'preparing', fraction: null, wireBytes: null, wireBytesDone: null, queuedScopes: 0 },
  };
}

function acceptsScope(scopeKey: string): boolean {
  return !retiredScopes.has(scopeKey) && (enabledScopes === null || enabledScopes.has(scopeKey));
}

function display(activity: DownloadActivity | null): void {
  if (!activity) {
    publish(null);
    return;
  }
  const knownQueued = Math.max(0, activitiesByScope.size - 1);
  // Older progress producers may only supply a count. Current engine frames
  // name every pending scope, so removals and local taps can be reconciled.
  const queuedScopes = activity.progress.pendingScopeKeys
    ? knownQueued
    : Math.max(knownQueued, activity.progress.queuedScopes);
  publish({ ...activity, progress: { ...activity.progress, queuedScopes } });
}

function promotePending(): void {
  clearTimeout(expiry);
  const pending = [...activitiesByScope.values()];
  const next = pending.find((activity) => activity.status === 'active') ?? pending[0] ?? null;
  display(next);
  if (next?.status === 'active') renewDeadline();
}

function renewDeadline(): void {
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    if (current?.status !== 'active') return;
    const waiting = { ...current, status: 'waiting' as const };
    activitiesByScope.set(waiting.progress.scopeKey, waiting);
    display(waiting);
  }, STALE_MS);
}

/** Settings are authoritative, including for automatic downloads and late callbacks. */
export function setDownloadActivityEnabledScopes(scopeKeys: readonly string[]): void {
  const nextEnabled = new Set(scopeKeys);
  if (enabledScopes) {
    for (const scopeKey of nextEnabled) {
      if (!enabledScopes.has(scopeKey)) retiredScopes.delete(scopeKey);
    }
  }
  enabledScopes = nextEnabled;
  for (const scopeKey of activitiesByScope.keys()) {
    if (!nextEnabled.has(scopeKey)) forgetDownloadActivity(scopeKey);
  }
  if (current?.status === 'done' && !nextEnabled.has(current.progress.scopeKey)) {
    clearTimeout(expiry);
    promotePending();
  }
}

/** New frames refresh the stall deadline without rendering on byte-count noise. */
export function noteDownloadActivity(progress: SyncProgress): void {
  if (progress.download) {
    const incoming = progress.download;
    if (!acceptsScope(incoming.scopeKey)) return;
    if (incoming.pendingScopeKeys) {
      const pending = new Set(incoming.pendingScopeKeys.filter(acceptsScope));
      pending.add(incoming.scopeKey);
      for (const scopeKey of activitiesByScope.keys()) {
        if (!pending.has(scopeKey) && !queuedUserScopes.has(scopeKey)) activitiesByScope.delete(scopeKey);
      }
      for (const scopeKey of pending) {
        if (!activitiesByScope.has(scopeKey)) activitiesByScope.set(scopeKey, waitingActivity(scopeKey));
      }
    }
    queuedUserScopes.delete(incoming.scopeKey);
    const previous = activitiesByScope.get(incoming.scopeKey);
    const frame = {
      ...incoming,
      fraction: incoming.fraction === null ? null : Math.max(previous?.progress.fraction ?? 0, incoming.fraction),
    };
    const activity: DownloadActivity = { progress: frame, status: 'active' };
    for (const [scopeKey, pendingActivity] of activitiesByScope) {
      if (scopeKey !== frame.scopeKey && pendingActivity.status === 'active') {
        activitiesByScope.set(scopeKey, { ...pendingActivity, status: 'waiting' });
      }
    }
    activitiesByScope.set(frame.scopeKey, activity);
    display(activity);
    renewDeadline();
  }
  if (
    !progress.download &&
    progress.phase !== 'idle' &&
    current &&
    (current.status === 'active' || current.status === 'waiting') &&
    (progress.currentTable === current.progress.scopeKey ||
      progress.currentTable?.endsWith(`:${current.progress.scopeKey}`))
  ) {
    const active = { ...current, status: 'active' as const };
    activitiesByScope.set(active.progress.scopeKey, active);
    display(active);
    renewDeadline();
  }
  if (progress.phase === 'idle' && current && current.status !== 'done') {
    clearTimeout(expiry);
    const settled = { ...current, status: progress.failed ? ('failed' as const) : ('waiting' as const) };
    activitiesByScope.set(settled.progress.scopeKey, settled);
    display(settled);
  }
}

/** Repeated taps preserve FIFO order; a retry starts a new progress attempt. */
export function queueDownloadActivity(scopeKey: string): void {
  retiredScopes.delete(scopeKey);
  if (!acceptsScope(scopeKey)) return;
  if (!queuedUserScopes.has(scopeKey) && !activitiesByScope.has(scopeKey)) {
    queuedUserScopes.add(scopeKey);
    activitiesByScope.set(scopeKey, waitingActivity(scopeKey));
  } else if (activitiesByScope.get(scopeKey)?.status === 'failed') {
    activitiesByScope.set(scopeKey, waitingActivity(scopeKey));
    queuedUserScopes.add(scopeKey);
  }
  if (current && current.status !== 'done' && activitiesByScope.has(current.progress.scopeKey)) {
    display(activitiesByScope.get(current.progress.scopeKey) ?? null);
  } else {
    promotePending();
  }
}

export function completeDownloadActivity(scopeKey: string): void {
  const completed = activitiesByScope.get(scopeKey);
  if (!completed) return;
  activitiesByScope.delete(scopeKey);
  queuedUserScopes.delete(scopeKey);
  retiredScopes.add(scopeKey);
  if (current?.progress.scopeKey !== scopeKey) {
    if (current) display(activitiesByScope.get(current.progress.scopeKey) ?? current);
    return;
  }
  if (activitiesByScope.size > 0) {
    promotePending();
    return;
  }
  clearTimeout(expiry);
  publish({ status: 'done', progress: { ...completed.progress, queuedScopes: 0, phase: 'finishing', fraction: 1 } });
  expiry = setTimeout(() => {
    if (current?.progress.scopeKey === scopeKey && current.status === 'done') publish(null);
  }, DONE_MS);
}

export function forgetDownloadActivity(scopeKey: string): void {
  const wasPending = activitiesByScope.delete(scopeKey);
  queuedUserScopes.delete(scopeKey);
  retiredScopes.add(scopeKey);
  // A legacy count-only producer cannot identify which pending entry left.
  for (const [pendingScopeKey, activity] of activitiesByScope) {
    if (wasPending && !activity.progress.pendingScopeKeys && activity.progress.queuedScopes > 0) {
      activitiesByScope.set(pendingScopeKey, {
        ...activity,
        progress: { ...activity.progress, queuedScopes: activity.progress.queuedScopes - 1 },
      });
    }
  }
  if (current?.progress.scopeKey === scopeKey) promotePending();
  else if (current) display(activitiesByScope.get(current.progress.scopeKey) ?? current);
}

export function resetDownloadActivity(): void {
  generation += 1;
  clearTimeout(expiry);
  activitiesByScope.clear();
  queuedUserScopes.clear();
  retiredScopes.clear();
  enabledScopes = null;
  publish(null);
}

const serverSnapshot = (): null => null;
export function useDownloadActivity(): DownloadActivity | null {
  return useSyncExternalStore(subscribeDownloadActivity, getDownloadActivity, serverSnapshot);
}

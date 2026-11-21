// A request exists before SQLite or connectivity can admit any download work.
// Keep its identity outside settings' reactive store: lifecycle changes must not
// re-render every settings consumer, and byte/progress frames never come here.

import { randomUUID } from 'expo-crypto';
import { createMMKV } from 'react-native-mmkv';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../lib/analytics';

export type DownloadLifecycleState =
  | 'requested'
  | 'recovered'
  | 'deferred'
  | 'started'
  | 'paused'
  | 'resumed'
  | 'completed'
  | 'abandoned'
  | 'failed';

export type DownloadLifecycleContext = {
  scopeKey: string;
  requestId: string;
  attemptId?: string;
};

export type DownloadLifecycleTransitionDetails = {
  reason?: string;
  stage?: string;
  attemptId?: string;
  completionSource?: 'download' | 'cached' | 'recovered';
};

export type DownloadRequest = DownloadLifecycleContext & {
  requestedAt: number | null;
  trigger: string;
  origin: 'requested' | 'recovered';
  state: DownloadLifecycleState;
  reason?: string;
  stage?: string;
  completionSource?: DownloadLifecycleTransitionDetails['completionSource'];
};

type LifecycleStorage = Pick<ReturnType<typeof createMMKV>, 'getString' | 'set' | 'remove'>;
const STORAGE_ID = 'boardsesh-offline-download-lifecycle-v1';
const REQUESTS_KEY = 'requests';
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'requested',
  'recovered',
  'deferred',
  'started',
  'paused',
  'resumed',
]);
const TERMINAL_STATES: ReadonlySet<DownloadLifecycleState> = new Set(['completed', 'abandoned', 'failed']);

let storage: LifecycleStorage | null | undefined;
let ownerId: string | null = null;
let requests = new Map<string, DownloadRequest>();
let fallbackIdSequence = 0;

function getStorage(): LifecycleStorage | null {
  if (storage === undefined) {
    try {
      storage = createMMKV({ id: STORAGE_ID });
    } catch {
      storage = null;
    }
  }
  return storage;
}

function clearPersistedRequests(): void {
  try {
    getStorage()?.remove(REQUESTS_KEY);
  } catch {
    // The owner check remains the boundary when native cleanup is unavailable.
  }
}

function isDownloadRequest(candidate: unknown, scopeKey: string): candidate is DownloadRequest {
  if (candidate === null || typeof candidate !== 'object') return false;
  const request = candidate as Record<string, unknown>;
  return (
    request.scopeKey === scopeKey &&
    typeof request.requestId === 'string' &&
    request.requestId.length > 0 &&
    typeof request.trigger === 'string' &&
    (request.origin === 'requested' || request.origin === 'recovered') &&
    (request.requestedAt === null ||
      (typeof request.requestedAt === 'number' && Number.isFinite(request.requestedAt))) &&
    typeof request.state === 'string' &&
    ACTIVE_STATES.has(request.state) &&
    (request.attemptId === undefined || typeof request.attemptId === 'string') &&
    (request.reason === undefined || typeof request.reason === 'string') &&
    (request.stage === undefined || typeof request.stage === 'string')
  );
}

function readOwnedRequests(userId: string): Map<string, DownloadRequest> {
  const ownedRequests = new Map<string, DownloadRequest>();
  try {
    const serialized = getStorage()?.getString(REQUESTS_KEY);
    if (!serialized) return ownedRequests;
    const parsed: unknown = JSON.parse(serialized);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ownedRequests;
    const envelope = parsed as Record<string, unknown>;
    // A clear that failed at sign-out can leave a valid file behind. Its owner
    // stamp, rather than the success of that cleanup, is the privacy boundary.
    if (envelope.ownerId !== userId) {
      clearPersistedRequests();
      return ownedRequests;
    }
    if (envelope.requests === null || typeof envelope.requests !== 'object' || Array.isArray(envelope.requests)) {
      return ownedRequests;
    }
    for (const [scopeKey, candidate] of Object.entries(envelope.requests)) {
      if (isDownloadRequest(candidate, scopeKey)) ownedRequests.set(scopeKey, candidate);
    }
  } catch {
    // Operational work survives unavailable/corrupt bookkeeping storage.
  }
  return ownedRequests;
}

function persistRequests(): void {
  // Pre-auth requests may be observed in this process, but must never overwrite
  // a previous account's file or silently acquire the next signed-in owner.
  if (ownerId === null) return;
  try {
    const target = getStorage();
    if (requests.size) target?.set(REQUESTS_KEY, JSON.stringify({ ownerId, requests: Object.fromEntries(requests) }));
    else target?.remove(REQUESTS_KEY);
  } catch {
    // Keep the in-memory identity stable even when a disk write fails.
  }
}

/** Bind the authenticated identity before publishing a signed-in session. */
export function setDownloadLifecycleOwner(userId: string | null): void {
  const nextOwnerId = userId || null;
  if (nextOwnerId === null) {
    ownerId = null;
    requests = new Map();
    return;
  }
  if (ownerId === nextOwnerId) return;
  ownerId = nextOwnerId;
  // Unknown pre-auth requests have no provable owner. Enabled scopes can be
  // recovered by the adapter after binding; their old timestamps are not reused.
  requests = readOwnedRequests(nextOwnerId);
}

function emit(request: DownloadRequest): void {
  try {
    // The existing analytics wrapper owns consent. No private queue or later
    // replay of interactions observed without consent is introduced here.
    track(SHARED_EVENTS.OfflineBoardDownloadLifecycle, {
      scopeKey: request.scopeKey,
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      trigger: request.trigger,
      origin: request.origin,
      state: request.state,
      ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.stage === undefined ? {} : { stage: request.stage }),
      ...(request.completionSource === undefined ? {} : { completionSource: request.completionSource }),
    });
  } catch {
    // Observability must never prevent a download from running or finishing.
  }
}

function newRequestId(): string {
  try {
    return randomUUID();
  } catch {
    // These are correlation IDs, not credentials. A missing native crypto
    // module must not turn operational bookkeeping into a download failure.
    fallbackIdSequence += 1;
    return `download-${Date.now()}-${fallbackIdSequence}-${Math.random().toString(36).slice(2)}`;
  }
}

/** A retry or duplicate enable joins the current request rather than opening another. */
export function requestDownload(
  scopeKey: string,
  trigger: string,
  origin: DownloadRequest['origin'] = 'requested',
): DownloadRequest {
  const current = requests.get(scopeKey);
  if (current) return { ...current };
  const request: DownloadRequest = {
    scopeKey,
    requestId: newRequestId(),
    requestedAt: origin === 'requested' ? Date.now() : null,
    trigger,
    origin,
    state: origin,
  };
  requests.set(scopeKey, request);
  persistRequests();
  emit(request);
  return { ...request };
}

export function getDownloadRequest(scopeKey: string): DownloadRequest | undefined {
  const request = requests.get(scopeKey);
  return request ? { ...request } : undefined;
}

export function getDownloadRequests(): DownloadRequest[] {
  return [...requests.values()].map((request) => ({ ...request }));
}

/** Stale completions cannot finish a replacement request or recreate a closed one. */
export function transitionDownload(
  context: DownloadLifecycleContext,
  state: Exclude<DownloadLifecycleState, 'requested' | 'recovered'>,
  details: DownloadLifecycleTransitionDetails = {},
): void {
  const current = requests.get(context.scopeKey);
  if (!current || current.requestId !== context.requestId) return;
  const attemptId = details.attemptId ?? context.attemptId ?? current.attemptId;
  if (
    current.state === state &&
    current.reason === details.reason &&
    current.stage === details.stage &&
    current.attemptId === attemptId &&
    current.completionSource === details.completionSource
  ) {
    return;
  }
  const next: DownloadRequest = {
    scopeKey: current.scopeKey,
    requestId: current.requestId,
    requestedAt: current.requestedAt,
    trigger: current.trigger,
    origin: current.origin,
    state,
    ...details,
    ...(attemptId === undefined ? {} : { attemptId }),
  };
  if (TERMINAL_STATES.has(state)) requests.delete(context.scopeKey);
  else requests.set(context.scopeKey, next);
  persistRequests();
  emit(next);
}

/** Account boundaries discard identities without attributing them to the next climber. */
export function resetDownloadLifecycle(): void {
  requests = new Map();
  ownerId = null;
  clearPersistedRequests();
}

/** A cold process loses memory while keeping the native store. */
export function __resetDownloadLifecycleMemoryForTests(): void {
  requests = new Map();
  ownerId = null;
  storage = undefined;
  fallbackIdSequence = 0;
}

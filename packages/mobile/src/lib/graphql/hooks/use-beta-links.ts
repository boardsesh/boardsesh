import type { Climb } from '@boardsesh/shared-schema';
import type { BoardConfig } from '../../../components/play-drawer/play-drawer-types';
import { useHttpActionScope } from '../use-http-action-scope';
import { subscribeHttpOperationScope } from '../use-auth-token';
import type { HttpOperation } from '../http-operation';
import type { ToastGuard } from '../../../components/Toast';
import {
  useCallback,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { hashKey, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import {
  GET_BETA_LINKS,
  type GetBetaLinksQueryResponse,
  type GetBetaLinksQueryVariables,
} from '@boardsesh/graphql/operations/beta-links';
import { dedupeBetaLinks } from '@boardsesh/shared-schema';
import { mapBetaLinks } from '../../beta-video-url';
import { useHttpFiniteQuery } from '../use-http-finite-query';
import { useHttpQueryScope, type HttpQueryScope } from '../use-http-query-scope';
import { createHttpScopedCache } from '../http-scoped-cache';

// Deletion retires authority immediately. React subscriber delivery alone is
// deferred beyond insertion cleanup, and removed listeners are never resumed.
function notifyBetaListeners(listeners: Set<() => void>, deferred = false) {
  const captured = Array.from(listeners);
  const deliver = () => {
    for (const listener of captured) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        /* Every remaining owner is notified. */
      }
    }
  };
  if (deferred) queueMicrotask(deliver);
  else deliver();
}

export type BetaReaderOwner = Readonly<{
  identity: object;
  view: string | undefined;
  boardType: string;
  climbUuid: string;
  assertCurrent(): void;
  subscribe(listener: () => void): () => void;
}>;
export function betaReaderOwnerKey(scope: HttpQueryScope, boardType: string, climbUuid: string): string | undefined {
  return scope.scoped ? hashKey(scope.key(['betaLinks', boardType, climbUuid])) : undefined;
}
/** Called INSIDE the keyed reader body. Insertion cleanup is actual owner
 * deletion, not Suspense's temporary layout disconnection. */
export function useBetaReaderOwner(boardType: string, climbUuid: string): BetaReaderOwner | undefined {
  const scope = useHttpQueryScope();
  const lifetime = useRef({ mounted: true, listeners: new Set<() => void>() });
  useInsertionEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
      notifyBetaListeners(lifetime.current.listeners, true);
    };
  }, []);
  const [original] = useState(() =>
    Object.freeze({
      identity: Object.freeze({}),
      view: scope.scope,
      boardType,
      climbUuid,
      assertCurrent() {
        if (!lifetime.current.mounted) throw new BrowserBackendConsumerError('superseded');
        scope.assertView();
      },
      subscribe(listener: () => void) {
        lifetime.current.listeners.add(listener);
        const releaseView = subscribeHttpOperationScope(listener);
        return () => {
          releaseView();
          lifetime.current.listeners.delete(listener);
        };
      },
    }),
  );
  return scope.scoped ? original : undefined;
}
export function isBetaReaderCurrent(owner: BetaReaderOwner | undefined): boolean {
  try {
    owner?.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

type Reader = Readonly<{
  assertCurrent(): void;
  refetch(assertCurrent: () => void, options?: { requireFreshAfterJoin?: boolean }): Promise<unknown>;
}>;
const readers = new WeakMap<QueryClient, Map<string, Set<Reader>>>();
function registered(client: QueryClient, key: string): Set<Reader> {
  let byKey = readers.get(client);
  if (!byKey) {
    byKey = new Map();
    readers.set(client, byKey);
  }
  let entries = byKey.get(key);
  if (!entries) {
    entries = new Set();
    byKey.set(key, entries);
  }
  return entries;
}
/** Snapshot an existing owner before the first await. Never adopt a reader
 * registered later merely because an older write marked its key stale. */
export async function refreshOriginalBetaLinks(
  client: QueryClient,
  scope: HttpQueryScope,
  boardType: string,
  climbUuid: string,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const logical = ['betaLinks', boardType, climbUuid];
  const originalReaders = [...(readers.get(client)?.get(hashKey(scope.key(logical))) ?? [])];
  const cache = createHttpScopedCache({ client, key: scope.key, assertCurrent });
  await cache.invalidateQueries({ queryKey: logical, exact: true, refetchType: 'none' });
  assertCurrent();
  for (const reader of originalReaders) {
    try {
      reader.assertCurrent();
    } catch {
      continue;
    }
    const assertOriginal = () => {
      assertCurrent();
      reader.assertCurrent();
      assertCurrent();
    };
    assertOriginal();
    await reader.refetch(assertOriginal, { requireFreshAfterJoin: true });
    assertOriginal();
    return;
  }
}

/** Raw response cache and TanStack select are preserved. Selected readers must
 * supply their actual committed owner; a key alone cannot reset selectError. */
export function useBetaLinks(boardType: string, climbUuid: string, enabled = true, owner?: BetaReaderOwner) {
  const scope = useHttpQueryScope();
  const client = useQueryClient();
  const assertOwner = () => {
    scope.assertView();
    if (scope.scoped) {
      if (!owner || owner.view !== scope.scope || owner.boardType !== boardType || owner.climbUuid !== climbUuid)
        throw new BrowserBackendConsumerError('superseded');
      owner.assertCurrent();
    }
  };
  let ownerReady = true;
  try {
    assertOwner();
  } catch {
    ownerReady = false;
  }
  const query = useHttpFiniteQuery({
    queryKey: ['betaLinks', boardType, climbUuid],
    queryFn: (operation) => {
      assertOwner();
      return operation.request<GetBetaLinksQueryResponse, GetBetaLinksQueryVariables>(GET_BETA_LINKS, {
        boardType,
        climbUuid,
      });
    },
    select: (response) => dedupeBetaLinks(mapBetaLinks(response.betaLinks)),
    ...(scope.scoped ? { assertDispatch: assertOwner } : {}),
    enabled: enabled && ownerReady,
    staleTime: 5 * 60 * 1000,
  });
  useLayoutEffect(() => {
    if (!scope.scoped || !ownerReady || !enabled) return;
    const key = hashKey(scope.key(['betaLinks', boardType, climbUuid]));
    const entries = registered(client, key);
    const entry = Object.freeze({ assertCurrent: assertOwner, refetch: query.refetchOriginal });
    entries.add(entry);
    return () => {
      entries.delete(entry);
      if (!entries.size) readers.get(client)?.delete(key);
    };
  }, [client, scope, owner, ownerReady, enabled, boardType, climbUuid, query.refetchOriginal]);
  return { ...query, assertOwner };
}

let nextBetaOpening = 0;
export type BetaOpening = Readonly<{
  id: string;
  entity: string;
  assertAction(): void;
  assertPresentation(): void;
  assertCleanup(): void;
  accept(): void;
  close(options?: { deferNotifications?: boolean }): void;
  completeClose(dispatch: () => void): void;
  retire(options?: { deferNotifications?: boolean }): void;
  subscribe(listener: () => void): () => void;
}>;
// Private cause observers abort owned work synchronously even when producer
// deletion must defer its public React subscriber notifications.
const openingCauses = new WeakMap<BetaOpening, Set<(deferred: boolean) => void>>();
function subscribeOpeningCause(opening: BetaOpening, listener: (deferred: boolean) => void) {
  const callbacks = openingCauses.get(opening);
  if (!callbacks) throw new BrowserBackendConsumerError('unavailable');
  callbacks.add(listener);
  return () => {
    callbacks.delete(listener);
  };
}
/** Owned by the actual event producer, outside React updater execution. */
export function createBetaOpeningCoordinator() {
  let current: BetaOpening | undefined;
  let sequence = 0;
  return Object.freeze({
    open(scope: HttpQueryScope, entity: string): BetaOpening {
      scope.assertView();
      const originalSequence = ++sequence;
      current?.retire();
      scope.assertView();
      if (sequence !== originalSequence) throw new BrowserBackendConsumerError('superseded');
      let phase: 'open' | 'accepted' | 'closed' | 'retired' = 'open';
      const listeners = new Set<() => void>();
      const causes = new Set<(deferred: boolean) => void>();
      const notify = (deferred: boolean) => {
        for (const listener of Array.from(causes)) {
          if (!causes.has(listener)) continue;
          try {
            listener(deferred);
          } catch {
            /* Abort every remaining cause. */
          }
        }
        notifyBetaListeners(listeners, deferred);
      };
      const assertPresentation = () => {
        if (phase === 'retired' || current !== opening) throw new BrowserBackendConsumerError('superseded');
        scope.assertView();
      };
      const opening: BetaOpening = Object.freeze({
        id: `beta-opening-${++nextBetaOpening}`,
        entity,
        assertAction() {
          assertPresentation();
          if (phase !== 'open') throw new BrowserBackendConsumerError('superseded');
        },
        assertPresentation,
        assertCleanup() {
          if (current !== opening || (phase !== 'retired' && phase !== 'closed'))
            throw new BrowserBackendConsumerError('superseded');
          scope.assertView();
        },
        accept() {
          opening.assertAction();
          phase = 'accepted';
        },
        close(options) {
          // A genuine cancel is distinct from an accepted close handoff.
          if (phase !== 'closed') opening.retire(options);
        },
        completeClose(dispatch: () => void) {
          assertPresentation();
          if (phase !== 'accepted') throw new BrowserBackendConsumerError('superseded');
          phase = 'closed';
          dispatch();
          assertPresentation();
        },
        retire(options) {
          if (phase === 'retired') return;
          phase = 'retired';
          notify(options?.deferNotifications ?? false);
        },
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      });
      openingCauses.set(opening, causes);
      current = opening;
      opening.assertAction();
      return opening;
    },
    current: () => current,
    retire(options?: { deferNotifications?: boolean }) {
      current?.retire(options);
    },
  });
}

export type BetaCompletion = ToastGuard & Readonly<{ close(dispatch: () => void): void }>;
export type BetaCauseKeeper = ReturnType<typeof createBetaCauseKeeper>;
/** A beta-only owner of ONE actual operation. The sampler only vetoes; every
 * assertion reads the original cause directly, including between timer ticks. */
export function createBetaCauseKeeper(options: {
  opening: BetaOpening;
  operation: Pick<HttpOperation, 'assertView' | 'assertDeliveries' | 'assertErrorDeliveries' | 'dispose'>;
  assertIntent: () => void;
  signal?: AbortSignal;
  abort: () => void;
  onReleased: () => void;
}) {
  const { opening, assertIntent, signal, abort, onReleased } = options;
  const { assertView, dispose } = options.operation;
  let cause: (() => void) | undefined;
  let accepted = false;
  let retired = false;
  let coordinator = true;
  let consumers = 0;
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const assertCurrent = () => {
    if (released || retired) throw new BrowserBackendConsumerError('superseded');
    opening.assertPresentation();
    assertView();
    if (!accepted) assertIntent();
    cause?.();
    opening.assertPresentation();
  };
  const notify = (deferred = false) => notifyBetaListeners(listeners, deferred);
  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const cleanup = () => {
    if (coordinator || consumers || released) return;
    released = true;
    stopTimer();
    releaseView();
    releaseOpening();
    signal?.removeEventListener('abort', retireBeforeAcceptance);
    dispose();
    onReleased();
    listeners.clear();
  };
  const retire = (deferred = false) => {
    if (retired || released) return;
    retired = true;
    stopTimer();
    abort();
    notify(deferred);
    cleanup();
  };
  const observe = (deferred = false) => {
    if (retired || released) return;
    try {
      assertCurrent();
    } catch {
      retire(deferred);
    }
  };
  const schedule = () => {
    if (!cause || retired || released || (!coordinator && consumers === 0) || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      observe();
      schedule();
    }, 100);
  };
  const retireBeforeAcceptance = () => {
    if (!accepted) retire();
  };
  const releaseOpening = subscribeOpeningCause(opening, observe);
  const releaseView = subscribeHttpOperationScope(() => observe());
  signal?.addEventListener('abort', retireBeforeAcceptance, { once: true });
  const retain = (): ToastGuard => {
    if (!cause || consumers >= 16) throw new BrowserBackendConsumerError('unavailable');
    assertCurrent();
    consumers += 1;
    let active = true;
    return Object.freeze({
      assertCurrent() {
        if (!active) throw new BrowserBackendConsumerError('superseded');
        assertCurrent();
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      release() {
        if (!active) return;
        active = false;
        consumers -= 1;
        cleanup();
      },
    });
  };
  if (signal?.aborted) retireBeforeAcceptance();
  return Object.freeze({
    assertCurrent,
    settled(assertCause: () => void) {
      if (cause) throw new BrowserBackendConsumerError('superseded');
      assertCause();
      cause = assertCause;
      assertCurrent();
      schedule();
    },
    retain,
    acceptCompletion(): BetaCompletion {
      assertCurrent();
      if (!cause || accepted) throw new BrowserBackendConsumerError('superseded');
      // Remove the producer-deletion abort affinity BEFORE intentional close.
      opening.accept();
      accepted = true;
      signal?.removeEventListener('abort', retireBeforeAcceptance);
      const presentation = retain();
      return Object.freeze({
        ...presentation,
        close(dispatch: () => void) {
          presentation.assertCurrent();
          opening.completeClose(dispatch);
          presentation.assertCurrent();
        },
      });
    },
    abandonProducer() {
      if (!accepted) retire(true);
    },
    releaseCoordinator() {
      coordinator = false;
      cleanup();
    },
    retire,
  });
}

// The actual share receiver stamps an opening before navigation. A route param
// only locates that original local object; it never constructs authority.
const shareBetaOpenings = createBetaOpeningCoordinator();
export function openShareBeta(scope: HttpQueryScope, link: string): BetaOpening {
  return shareBetaOpenings.open(scope, link);
}
export function findShareBetaOpening(id: string, link: string): BetaOpening | undefined {
  const opening = shareBetaOpenings.current();
  if (!opening || opening.id !== id || opening.entity !== link) return undefined;
  try {
    opening.assertAction();
    return opening;
  } catch {
    return undefined;
  }
}
export function useBetaOpeningCurrent(opening: BetaOpening | undefined): boolean {
  return useSyncExternalStore(
    (listener) => {
      const releaseView = subscribeHttpOperationScope(listener);
      const releaseOpening = opening?.subscribe(listener);
      return () => {
        releaseOpening?.();
        releaseView();
      };
    },
    () => {
      if (!opening) return false;
      try {
        opening.assertPresentation();
        return true;
      } catch {
        return false;
      }
    },
    () => false,
  );
}

/** UI-record holds are independent from coordinator and Toast holds. Marks are
 * enqueued first in the same owner so React must rerun the pure guarded updater.
 * Only exact committed marks release a refused publication, never a later lane. */
export function useBetaComposer(opening: BetaOpening) {
  const actions = useHttpActionScope();
  const draftRevision = useRef(0);
  const [draft, setDraft] = useState<Readonly<{ opening: BetaOpening; text: string; revision: number }>>({
    opening,
    text: '',
    revision: 0,
  });
  const [record, setRecord] = useState<
    Readonly<{
      opening: BetaOpening;
      ticket: object;
      error: string | null;
      guard?: ToastGuard;
      action?: ReturnType<typeof actions.capture>;
    }>
  >();
  const [marks, setMarks] = useState<readonly object[]>([]);
  const pending = useRef<ReturnType<typeof actions.capture> | undefined>(undefined);
  const pendingOpening = useRef<BetaOpening | undefined>(undefined);
  const publications = useRef(
    new Map<object, Readonly<{ guard?: ToastGuard; action?: ReturnType<typeof actions.capture> }>>(),
  );
  const currentRecord = useRef(record);
  const [busy, setBusy] = useState<Readonly<{ opening: BetaOpening; action: ReturnType<typeof actions.capture> }>>();
  const finishPending = useCallback((action: ReturnType<typeof actions.capture>, keepAction = false) => {
    if (pending.current === action) pending.current = undefined;
    if (!keepAction) action.finish();
    // Terminal bookkeeping is exact-invocation cleanup, not a data verdict.
    setBusy((previous) => (previous?.action === action ? undefined : previous));
  }, []);
  const current = useBetaOpeningCurrent(opening);
  const assertAction = useCallback(() => opening.assertAction(), [opening]);
  const publish = useCallback(
    (
      error: string | null,
      guard?: ToastGuard,
      action?: ReturnType<typeof actions.capture>,
      assertLocal?: () => void,
    ) => {
      const assertCurrent = () => {
        opening.assertPresentation();
        assertLocal?.();
        guard?.assertCurrent();
        if (!guard) action?.assertView();
      };
      try {
        assertCurrent();
      } catch {
        guard?.release();
        if (action) finishPending(action);
        return;
      }
      if (publications.current.size >= 16) {
        guard?.release();
        if (action) finishPending(action);
        return;
      }
      const ticket = Object.freeze({});
      publications.current.set(ticket, Object.freeze({ guard, action }));
      setMarks((previous) => [...previous.filter((mark) => publications.current.has(mark)), ticket]);
      setRecord((previous) => {
        try {
          assertCurrent();
          return Object.freeze({ opening, ticket, error, guard, action });
        } catch {
          return previous;
        }
      });
      if (action) setBusy((previous) => (previous?.action === action ? undefined : previous));
    },
    [opening, finishPending],
  );
  useLayoutEffect(() => {
    const old = currentRecord.current;
    currentRecord.current = record;
    if (old && (old !== record || old.opening !== opening)) {
      old.guard?.release();
      old.action?.finish();
    }
    for (const ticket of marks) {
      const publication = publications.current.get(ticket);
      if (!publication) continue;
      publications.current.delete(ticket);
      if (record?.ticket !== ticket) {
        publication.guard?.release();
        publication.action?.finish();
      }
      if (publication.action)
        finishPending(publication.action, record?.ticket === ticket && !!record.guard && record.opening === opening);
    }
  }, [marks, record, opening, finishPending]);
  useInsertionEffect(
    () => () => {
      currentRecord.current?.guard?.release();
      currentRecord.current?.action?.finish();
      for (const publication of publications.current.values()) {
        publication.guard?.release();
        publication.action?.finish();
      }
      publications.current.clear();
      pending.current?.finish();
      pending.current = undefined;
    },
    [],
  );
  const recordCurrent = useSyncExternalStore(
    (listener) => record?.guard?.subscribe(listener) ?? (() => {}),
    () => {
      try {
        record?.guard?.assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    () => false,
  );
  const captureDraft = useCallback(() => {
    const revision = draft.opening === opening ? draft.revision : draftRevision.current;
    const text = draft.opening === opening ? draft.text : '';
    return Object.freeze({
      text,
      assertCurrent() {
        assertAction();
        if (draftRevision.current !== revision) throw new BrowserBackendConsumerError('superseded');
      },
    });
  }, [draft, opening, assertAction]);
  return {
    current,
    draft: current && draft.opening === opening ? draft.text : '',
    error: current && recordCurrent && record?.opening === opening ? (record.error ?? null) : null,
    busy: current && busy?.opening === opening,
    assertAction,
    captureDraft,
    changeDraft(this: void, next: string) {
      try {
        assertAction();
      } catch {
        return;
      }
      const revision = ++draftRevision.current;
      if (pending.current) finishPending(pending.current);
      const assertRevision = () => {
        assertAction();
        if (draftRevision.current !== revision) throw new BrowserBackendConsumerError('superseded');
      };
      // Mark before the draft update too: stale eager input updates cannot
      // overwrite a newer draft when React rebases a lower-priority lane.
      publish(null, undefined, undefined, assertRevision);
      setDraft((previous) => {
        try {
          assertRevision();
          return Object.freeze({ opening, text: next, revision });
        } catch {
          return previous;
        }
      });
    },
    begin() {
      // Capture BEFORE pending/latch changes. Local identity is not a receipt.
      const original = actions.capture();
      const revision = draftRevision.current;
      const assertInput = () => {
        original.assertView();
        if (draftRevision.current !== revision) throw new BrowserBackendConsumerError('superseded');
      };
      const action = Object.freeze({
        ...original,
        assertView: assertInput,
        isCurrent() {
          try {
            assertInput();
            return true;
          } catch {
            return false;
          }
        },
      });
      try {
        assertAction();
        if (pending.current) {
          // Retired actions are no longer an active latch for the new opening.
          if (pendingOpening.current === opening && pending.current.isCurrent()) {
            action.finish();
            return undefined;
          }
          finishPending(pending.current);
        }
      } catch {
        action.finish();
        return undefined;
      }
      pending.current = action;
      pendingOpening.current = opening;
      setBusy((previous) => {
        try {
          action.assertView();
          assertAction();
          return Object.freeze({ opening, action });
        } catch {
          return previous;
        }
      });
      return action;
    },
    settle: publish,
  };
}

export function betaLocalToastGuard(
  opening: BetaOpening,
  action: ReturnType<ReturnType<typeof useHttpActionScope>['capture']>,
): ToastGuard {
  let active = true;
  return Object.freeze({
    assertCurrent() {
      if (!active) throw new BrowserBackendConsumerError('superseded');
      opening.assertAction();
      action.assertView();
    },
    subscribe(listener: () => void) {
      const releaseView = subscribeHttpOperationScope(listener);
      const releaseOpening = opening.subscribe(listener);
      action.signal.addEventListener('abort', listener);
      return () => {
        releaseView();
        releaseOpening();
        action.signal.removeEventListener('abort', listener);
      };
    },
    release() {
      if (!active) return;
      active = false;
      action.finish();
    },
  });
}

export type BetaPinnedTarget = Readonly<{ climb: Climb; boardConfig: BoardConfig }>;
/** Consumed by PlayCore with its actual pinned-target and visibility setters.
 * This is beta admission only; it never drives the board or supplies HTTP proof. */
export function useBetaVideoProducer({
  displayedClimb,
  boardConfig,
  setTarget,
  setVisible,
}: {
  displayedClimb: Climb | null | undefined;
  boardConfig: BoardConfig;
  setTarget: (target: BetaPinnedTarget) => void;
  setVisible: (visible: boolean) => void;
}) {
  const scope = useHttpQueryScope();
  const actions = useHttpActionScope();
  const [openings] = useState(createBetaOpeningCoordinator);
  const [opening, setOpening] = useState<BetaOpening>();
  const lifetime = useRef(true);
  const { boardName, layoutId, sizeId, setIds, angle } = boardConfig;
  const semanticKey = JSON.stringify([scope.scope, displayedClimb?.uuid, boardName, layoutId, sizeId, setIds, angle]);
  const committed = useRef({ key: semanticKey, identity: Object.freeze({}) });
  // A discarded render is not a committed entity replacement. A committed B
  // followed by A still mints a distinct owner and never revives old A events.
  const owner = useMemo(
    () =>
      committed.current.key === semanticKey ? committed.current : { key: semanticKey, identity: Object.freeze({}) },
    [semanticKey],
  );
  useLayoutEffect(() => {
    committed.current = owner;
  }, [owner]);
  useInsertionEffect(() => {
    lifetime.current = true;
    const release = scope.scoped
      ? subscribeHttpOperationScope(() => {
          const current = openings.current();
          try {
            current?.assertPresentation();
          } catch {
            current?.retire();
          }
        })
      : () => {};
    return () => {
      lifetime.current = false;
      release();
      openings.retire({ deferNotifications: true });
    };
  }, [openings, scope.scoped]);
  const nativeOpenForClimb = useCallback(
    (climb: Climb, config: BoardConfig) => {
      setTarget({ climb, boardConfig: config });
      setVisible(true);
    },
    [setTarget, setVisible],
  );
  const selectedOpenForClimb = useCallback(
    (climb: Climb, config: BoardConfig) => {
      let action: ReturnType<typeof actions.capture> | undefined;
      let admitted: BetaOpening | undefined;
      try {
        action = actions.capture();
        const assertOriginal = () => {
          action!.assertView();
          if (!lifetime.current || committed.current.identity !== owner.identity)
            throw new BrowserBackendConsumerError('superseded');
        };
        assertOriginal();
        const pinned = Object.freeze({ climb: Object.freeze({ ...climb }), boardConfig: Object.freeze({ ...config }) });
        admitted = openings.open(scope, `${pinned.boardConfig.boardName}:${pinned.climb.uuid}`);
        const originalOpening = admitted;
        assertOriginal();
        originalOpening.assertAction();
        setOpening((previous) => {
          try {
            originalOpening.assertAction();
            return originalOpening;
          } catch {
            return previous;
          }
        });
        assertOriginal();
        setTarget(pinned);
        assertOriginal();
        originalOpening.assertAction();
        setVisible(true);
      } catch {
        if (admitted && openings.current() === admitted) admitted.retire();
      } finally {
        action?.finish();
      }
    },
    [actions, scope, owner, openings, setTarget, setVisible],
  );
  const openForClimb = scope.scoped ? selectedOpenForClimb : nativeOpenForClimb;
  const open = useCallback(() => {
    if (!displayedClimb) return;
    openForClimb(displayedClimb, { boardName, layoutId, sizeId, setIds, angle });
  }, [displayedClimb, boardName, layoutId, sizeId, setIds, angle, openForClimb]);
  const close = useCallback(
    (expected?: BetaOpening) => {
      if (scope.scoped) {
        if (!expected || openings.current() !== expected || !lifetime.current) return;
        try {
          expected.assertPresentation();
        } catch {
          return;
        }
        expected.close();
      }
      setVisible(false);
    },
    [scope.scoped, openings, setVisible],
  );
  return { scoped: scope.scoped, opening, currentOpening: openings.current, open, openForClimb, close };
}

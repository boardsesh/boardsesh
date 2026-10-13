import { useLayoutEffect, useRef } from 'react';
import { onlineManager } from '@tanstack/react-query';
import {
  getErrorStatus,
  isNetworkError,
  isServerFailureSignal,
  isServerUnavailableError,
} from '@boardsesh/offline-sync/error-classification';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { GET_CLIMB, type GetClimbQueryResponse } from '../../lib/graphql/operations';
import { isGraphqlRequestTimeoutError } from '../../lib/graphql/request-timeout';
import { getPrivacyRevocationGeneration } from '../../lib/privacy/privacy-cache';
import { isClimbResolved } from '../../lib/queue-climb-resolution';

const READ_DEADLINE_MS = 20_000;
const RETRY_DELAY_MS = 1_000;

export type QueueClimbReadDemand = {
  climbUuid: string;
  angle: number;
  /** Object identity plus role/slot distinguishes a new FullSync from reducer churn. */
  expectedClimb: object;
  targetKey: string;
  apply: (climb: Climb) => void;
};

type ReadScope = Pick<UserBoard, 'boardType' | 'layoutId' | 'sizeId' | 'setIds'> & { generation: number };
type ReadEntry = {
  status: 'pending' | 'retry' | 'settled';
  attempt: number;
  addressed: QueueClimbReadDemand[];
  succeeded: boolean;
  recoverOnReconnect: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
};

function sameDemand(left: QueueClimbReadDemand, right: QueueClimbReadDemand): boolean {
  return left.expectedClimb === right.expectedClimb && left.targetKey === right.targetKey;
}

/** One provider-owned lifetime for reads shared by restore, regrade, and playlist peeks. */
export class QueueClimbReads {
  private scope: ReadScope | null = null;
  private scopeKey = '';
  private owners = new Map<string, QueueClimbReadDemand[]>();
  private entries = new Map<string, ReadEntry>();
  private scheduled = false;
  private lifetime = 0;
  private reconnectEpoch = 0;

  setScope(board: UserBoard | null | undefined, generation: number): void {
    const scope = board
      ? { boardType: board.boardType, layoutId: board.layoutId, sizeId: board.sizeId, setIds: board.setIds, generation }
      : null;
    const scopeKey = JSON.stringify(scope);
    if (scopeKey === this.scopeKey) return;
    this.retire();
    this.scope = scope;
    this.scopeKey = scopeKey;
  }

  register(owner: string, demands: QueueClimbReadDemand[]): void {
    this.owners.set(owner, demands);
    this.schedule();
  }

  unregister(owner: string): void {
    this.owners.delete(owner);
    this.schedule();
  }

  reconnect(): void {
    this.reconnectEpoch += 1;
    for (const [key, entry] of this.entries) {
      if (entry.status === 'settled' && entry.recoverOnReconnect) this.entries.delete(key);
    }
    this.schedule();
  }

  retire(): void {
    this.lifetime += 1;
    this.scheduled = false;
    for (const entry of this.entries.values()) this.clearTimers(entry);
    this.entries.clear();
    this.owners.clear();
    this.scope = null;
    this.scopeKey = '';
  }

  private clearTimers(entry: ReadEntry): void {
    clearTimeout(entry.deadline);
    clearTimeout(entry.retry);
  }

  private key(demand: QueueClimbReadDemand): string {
    return JSON.stringify([this.scopeKey, demand.climbUuid, demand.angle]);
  }

  private demandsFor(key: string): QueueClimbReadDemand[] {
    return [...this.owners.values()].flat().filter((demand) => this.key(demand) === key);
  }

  private current(key: string, entry: ReadEntry, scope: ReadScope): boolean {
    return (
      this.scope === scope && scope.generation === getPrivacyRevocationGeneration() && this.entries.get(key) === entry
    );
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const lifetime = this.lifetime;
    // Both hooks publish their committed demand before any request starts.
    queueMicrotask(() => {
      if (lifetime !== this.lifetime) return;
      this.scheduled = false;
      this.reconcile();
    });
  }

  private reconcile(): void {
    const scope = this.scope;
    if (!scope || scope.generation !== getPrivacyRevocationGeneration()) return;
    const demands = new Map<string, QueueClimbReadDemand[]>();
    for (const demand of [...this.owners.values()].flat()) {
      const key = this.key(demand);
      const existing = demands.get(key);
      if (existing) existing.push(demand);
      else demands.set(key, [demand]);
    }
    for (const [key, entry] of this.entries) {
      if (!demands.has(key)) {
        this.clearTimers(entry);
        this.entries.delete(key);
      }
    }
    for (const [key, targets] of demands) {
      const entry = this.entries.get(key);
      // Suppress a successful answer only until its dispatched update commits.
      // A later committed registration still asking for even the SAME thin
      // object means another update overwrote hydration, so it needs a new read.
      // Failed/null reads stay bounded across unrelated commits of that object.
      if (
        entry &&
        (entry.status !== 'settled' ||
          targets.every((target) =>
            entry.addressed.some((previous) => (entry.succeeded ? previous === target : sameDemand(previous, target))),
          ))
      )
        continue;
      const nextEntry: ReadEntry = {
        status: 'pending',
        attempt: 0,
        addressed: [],
        succeeded: false,
        recoverOnReconnect: false,
      };
      this.entries.set(key, nextEntry);
      this.start(key, nextEntry, scope, targets[0]);
    }
  }

  private start(key: string, entry: ReadEntry, scope: ReadScope, demand: QueueClimbReadDemand): void {
    entry.status = 'pending';
    const attempt = ++entry.attempt;
    const startedOffline = !onlineManager.isOnline();
    const reconnectEpoch = this.reconnectEpoch;
    let finished = false;
    const finish = (response?: GetClimbQueryResponse, error?: unknown, timedOut = false) => {
      if (finished || !this.current(key, entry, scope) || entry.attempt !== attempt) return;
      finished = true;
      clearTimeout(entry.deadline);
      const targets = this.demandsFor(key);
      const transient =
        timedOut ||
        isGraphqlRequestTimeoutError(error) ||
        isNetworkError(error) ||
        isServerUnavailableError(error) ||
        isServerFailureSignal(error) ||
        getErrorStatus(error) === 429;
      if (error !== undefined || timedOut) {
        if (transient && attempt === 1) {
          entry.status = 'retry';
          entry.retry = setTimeout(() => {
            if (!this.current(key, entry, scope)) return;
            const latest = this.demandsFor(key)[0];
            if (latest) this.start(key, entry, scope, latest);
            else this.entries.delete(key);
          }, RETRY_DELAY_MS);
          return;
        }
        entry.recoverOnReconnect = transient;
      } else {
        const climb = response?.climb;
        entry.recoverOnReconnect = !climb && (startedOffline || !onlineManager.isOnline());
        if (
          climb &&
          isClimbResolved(climb) &&
          climb.uuid === demand.climbUuid &&
          climb.angle === demand.angle &&
          (!climb.boardType || climb.boardType === scope.boardType) &&
          (climb.layoutId == null || climb.layoutId === scope.layoutId)
        ) {
          entry.succeeded = true;
          // Reconcile the answer with current committed demand, independently of
          // other reads. No response can restore a captured, removed queue item.
          for (const target of targets) target.apply(climb);
        }
      }
      entry.status = 'settled';
      entry.addressed = targets;
      // A local miss may finish after the reconnect notification. Consume that
      // recovery edge now rather than waiting for another queue edit or reconnect.
      if (entry.recoverOnReconnect && reconnectEpoch !== this.reconnectEpoch && onlineManager.isOnline()) {
        this.entries.delete(key);
        this.schedule();
      }
    };
    entry.deadline = setTimeout(() => finish(undefined, undefined, true), READ_DEADLINE_MS);
    void offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, {
      boardName: scope.boardType,
      layoutId: scope.layoutId,
      sizeId: scope.sizeId,
      setIds: scope.setIds,
      climbUuid: demand.climbUuid,
      angle: demand.angle,
    }).then(
      (response) => finish(response),
      (error: unknown) => finish(undefined, error),
    );
  }
}

export function useQueueClimbReads({
  activeBoard,
  privacyRevocationGeneration,
}: {
  activeBoard: UserBoard | null | undefined;
  privacyRevocationGeneration?: number;
}): QueueClimbReads {
  const readsRef = useRef<QueueClimbReads | null>(null);
  if (!readsRef.current) readsRef.current = new QueueClimbReads();
  const reads = readsRef.current;
  useLayoutEffect(() => {
    reads.setScope(activeBoard, getPrivacyRevocationGeneration());
  }, [
    reads,
    activeBoard?.boardType,
    activeBoard?.layoutId,
    activeBoard?.sizeId,
    activeBoard?.setIds,
    privacyRevocationGeneration,
  ]);
  useLayoutEffect(() => {
    const unsubscribe = onlineManager.subscribe((online) => {
      if (online) reads.reconnect();
    });
    return () => {
      unsubscribe();
      reads.retire();
    };
  }, [reads]);
  return reads;
}

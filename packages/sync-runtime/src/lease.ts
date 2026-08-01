/**
 * Holder side of the daemon lease. All I/O is injected so this package stays
 * dependency-free; the Postgres implementation lives in
 * @boardsesh/db `queries/sync/daemon-lease.ts`.
 *
 * IMPORTANT: this is an optimisation, not mutual exclusion. A TTL lease has no
 * fencing token — if the holder stalls past the TTL (GC pause, a long await
 * inside a cycle, a partition to Postgres, a suspended container) another
 * instance legitimately takes over while this one is still running and still
 * believes it holds the lease. What the lease buys is that the ordinary case,
 * two healthy containers overlapping during a rolling deploy, stops doing
 * every sync twice. Correctness has to come from the individual writes being
 * safe under concurrency (the credential claim, the shared-sync compare-and-set
 * and the deterministic notification uuid), and it does.
 *
 * Because of that, {@link DaemonLease.assertStillHeld} exists: a cycle that
 * discovers mid-flight that it lost the lease stops at its next checkpoint
 * instead of running to completion alongside the new holder.
 */

export type DaemonLeaseIo = {
  /** Take the lease, or renew it if we hold it. Resolves true when we hold it after the call. */
  acquireOrRenew: () => Promise<boolean>;
  /** Best-effort release on shutdown; must be scoped to this holder. */
  release: () => Promise<void>;
};

export type DaemonLeaseRuntime = {
  heartbeatMs?: number;
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
};

/** Thrown by {@link DaemonLease.assertStillHeld} when the lease was taken over mid-cycle. */
export class DaemonLeaseLostError extends Error {
  constructor(daemonName: string) {
    super(
      `Daemon lease for ${daemonName} was taken over by another instance mid-cycle; ` +
        `stopping this cycle at its next checkpoint`,
    );
    this.name = 'DaemonLeaseLostError';
  }
}

export class DaemonLease {
  private readonly daemonName: string;
  private readonly io: DaemonLeaseIo;
  private readonly heartbeatMs: number;
  private readonly log: (message: string) => void;
  private readonly onError: (error: unknown) => void;
  private readonly startTimer: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly stopTimer: (handle: ReturnType<typeof setInterval>) => void;

  private held = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly inFlightHeartbeats = new Set<Promise<void>>();

  constructor(daemonName: string, io: DaemonLeaseIo, runtime: DaemonLeaseRuntime = {}) {
    this.daemonName = daemonName;
    this.io = io;
    this.heartbeatMs = runtime.heartbeatMs ?? 30_000;
    this.log = runtime.onLog ?? (() => {});
    this.onError = runtime.onError ?? (() => {});
    this.startTimer = runtime.setInterval ?? ((handler, ms) => setInterval(handler, ms));
    this.stopTimer = runtime.clearInterval ?? ((handle) => clearInterval(handle));
  }

  /**
   * The daemon loop's `acquireSlot`. Takes or renews the lease and starts the
   * heartbeat once we hold it, so a long cycle (a full catalog pull can run for
   * many minutes) keeps renewing without depending on the cycle cadence.
   */
  acquire = async (): Promise<boolean> => {
    const acquired = await this.io.acquireOrRenew();
    this.held = acquired;

    if (acquired) {
      this.startHeartbeat();
    } else {
      this.stopHeartbeat();
    }

    return acquired;
  };

  /** True while we believe we hold the lease. Only ever a belief — see the module note. */
  isHeld(): boolean {
    return this.held;
  }

  /**
   * Checkpoint for a long cycle. Call between units of work; throws
   * {@link DaemonLeaseLostError} once a heartbeat has observed a takeover, so
   * the cycle unwinds instead of continuing to write alongside the new holder.
   * The daemon loop catches it via `onCycleError` and drops into standby.
   */
  assertStillHeld(): void {
    if (!this.held) {
      throw new DaemonLeaseLostError(this.daemonName);
    }
  }

  /** Release on shutdown so a rolling deploy hands over immediately, not after a TTL. */
  async stop(): Promise<void> {
    this.stopHeartbeat();
    if (this.held) {
      this.held = false;
      try {
        await this.io.release();
        this.log(`[SyncRunner] Released the ${this.daemonName} daemon lease`);
      } catch (error) {
        // A failed release just means the next instance waits out the TTL.
        this.onError(error);
      }
    }

    // A heartbeat may already be awaiting its renew query when shutdown starts.
    // It observes held=false after that query and, if the renew re-created our
    // row after the release above, performs a compensating release in beat(). Do
    // not let callers close their database pool until that cleanup has settled.
    while (this.inFlightHeartbeats.size > 0) {
      await Promise.allSettled(this.inFlightHeartbeats);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = this.startTimer(() => {
      const heartbeatCompletion = this.beat();
      this.inFlightHeartbeats.add(heartbeatCompletion);
      void heartbeatCompletion.then(
        () => this.inFlightHeartbeats.delete(heartbeatCompletion),
        () => this.inFlightHeartbeats.delete(heartbeatCompletion),
      );
    }, this.heartbeatMs);
    // Never keep the process alive just to renew a lease.
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    this.stopTimer(this.heartbeat);
    this.heartbeat = null;
  }

  private async beat(): Promise<void> {
    // stop() may have run between this tick being scheduled and firing.
    if (!this.held) return;

    try {
      const stillOurs = await this.io.acquireOrRenew();

      // stop() ran while the renew was in flight. Its DELETE may have landed
      // BEFORE this upsert, in which case the renew just re-created the row we
      // were trying to give up — a zombie holding the lease under a dead
      // process's id, blocking the incoming instance for a full TTL instead of
      // the milliseconds the SIGTERM release exists to buy. Undo it.
      if (!this.held) {
        if (stillOurs) {
          try {
            await this.io.release();
          } catch (error) {
            this.onError(error);
          }
        }
        return;
      }

      if (!stillOurs) {
        this.held = false;
        this.stopHeartbeat();
        this.log(
          `[SyncRunner] Lost the ${this.daemonName} daemon lease to another instance ` +
            `(this one stalled past the lease TTL); standing down at the next checkpoint`,
        );
      }
    } catch (error) {
      // A transient DB error must not hand the lease away on its own — the TTL
      // does that if the outage outlasts it. Surface it and keep beating.
      this.onError(error);
    }
  }
}

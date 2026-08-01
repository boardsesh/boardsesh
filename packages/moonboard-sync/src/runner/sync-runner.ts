import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { closePool, createDb, type DbInstance } from '@boardsesh/db/client';
import { acquireOrRenewDaemonLease, MOONBOARD_SYNC_DAEMON, releaseDaemonLease } from '@boardsesh/db/queries';
import {
  DaemonLease,
  resolveDaemonOptions,
  runDaemonLoop,
  type DaemonLoopRuntime,
  type DaemonOptions,
  type ResolvedDaemonOptions,
} from '@boardsesh/sync-runtime';

import { syncMoonBoardLocations } from '../sync/locations-sync';

/**
 * MoonBoard's public map changes much less often than climb/user data. A six to
 * eight hour jitter keeps new public boards reasonably fresh without repeatedly
 * logging in to the upstream service on a tight user-sync cadence.
 */
export const DEFAULT_MOONBOARD_DAEMON_OPTIONS: DaemonOptions = {
  minDelayMinutes: 6 * 60,
  maxDelayMinutes: 8 * 60,
};

export type MoonBoardSyncRunnerConfig = {
  username: string;
  password: string;
  onLog?: (message: string) => void;
  onError?: (error: Error) => void;
};

/** Test/runtime hooks that cannot replace the runner's signal, lease, or error reporting. */
export type MoonBoardDaemonRuntime = Pick<DaemonLoopRuntime, 'now' | 'random' | 'sleep'>;

type ActiveDaemonRun = {
  controller: AbortController;
  completion: Promise<void>;
};

type RunnerStop = {
  completion: Promise<void>;
};

export class MoonBoardSyncRunner {
  private readonly config: MoonBoardSyncRunnerConfig;
  private readonly leaseHolderId = randomUUID();
  private activeDaemonRun: ActiveDaemonRun | null = null;
  private runnerStop: RunnerStop | null = null;
  private database: DbInstance | null = null;
  private lease: DaemonLease | null = null;

  constructor(config: MoonBoardSyncRunnerConfig) {
    this.config = config;
  }

  async syncLocations() {
    return syncMoonBoardLocations({
      db: this.getDatabase(),
      username: this.config.username,
      password: this.config.password,
      // Preserve the one-shot CLI's `--verbose` contract. Daemon lifecycle
      // messages still use this.log and remain visible without verbose mode.
      log: this.config.onLog,
    });
  }

  async runDaemon(options: DaemonOptions = {}, runtime: MoonBoardDaemonRuntime = {}): Promise<void> {
    if (this.activeDaemonRun) {
      throw new Error('MoonBoard daemon mode is already running');
    }
    if (this.runnerStop) {
      throw new Error('MoonBoard sync runner is stopping');
    }

    const resolved: ResolvedDaemonOptions = resolveDaemonOptions({
      ...DEFAULT_MOONBOARD_DAEMON_OPTIONS,
      ...options,
    });
    const controller = new AbortController();
    const lease = this.getLease();
    const activeDaemonRun: ActiveDaemonRun = {
      controller,
      // Start on the next microtask so the active-run identity is installed
      // before any injected runtime or database callback can re-enter the runner.
      completion: Promise.resolve().then(async () => {
        try {
          await runDaemonLoop(
            async () => {
              // A stop requested while lease acquisition was in flight must not
              // start a fresh location write after the signal arrived.
              if (controller.signal.aborted) return;
              await this.syncLocations();
              // A location apply is idempotent, but stop after a stale holder notices
              // a lease takeover rather than starting another overlapping cycle.
              lease.assertStillHeld();
            },
            resolved,
            {
              ...runtime,
              signal: controller.signal,
              acquireSlot: lease.acquire,
              onLog: (message) => this.log(message),
              onCycleError: (error) => {
                const normalizedError = error instanceof Error ? error : new Error(String(error));
                this.handleError(normalizedError);
                this.log(`[MoonBoardSyncRunner] Daemon cycle error: ${normalizedError.message}`);
              },
            },
          );
        } finally {
          // Keep the lease until runDaemonLoop has allowed an active location
          // write to settle. This must complete before stop() closes Postgres.
          await lease.stop();
        }
      }),
    };
    this.activeDaemonRun = activeDaemonRun;

    try {
      await activeDaemonRun.completion;
    } finally {
      // A rejected reentrant call must never clear or replace another run's
      // controller. Clear only the run whose completion we just observed.
      if (this.activeDaemonRun === activeDaemonRun) {
        this.activeDaemonRun = null;
      }
    }
  }

  /** Request loop shutdown without releasing the lease or closing Postgres. */
  requestStop(): void {
    this.activeDaemonRun?.controller.abort();
  }

  stop(): Promise<void> {
    if (this.runnerStop) {
      return this.runnerStop.completion;
    }

    const activeDaemonRun = this.activeDaemonRun;
    const runnerStop: RunnerStop = {
      // Defer cleanup until after runnerStop is installed. This prevents a new
      // daemon run from starting between the active run settling and pool close.
      completion: Promise.resolve().then(async () => {
        try {
          await activeDaemonRun?.completion;
        } finally {
          // runDaemon normally released this lease already. The extra stop is
          // needed for one-shot use and is idempotent when a daemon just ended.
          await this.lease?.stop();
          if (this.database) {
            try {
              await closePool();
            } finally {
              this.database = null;
            }
          }
        }
      }),
    };
    this.runnerStop = runnerStop;
    runnerStop.completion = runnerStop.completion.finally(() => {
      if (this.runnerStop === runnerStop) {
        this.runnerStop = null;
      }
    });
    // Install the shared cleanup promise before abort dispatches synchronous
    // listeners, so even a reentrant stop() call observes the same cleanup.
    activeDaemonRun?.controller.abort();

    return runnerStop.completion;
  }

  private getDatabase(): DbInstance {
    if (!this.database) {
      this.database = createDb();
    }
    return this.database;
  }

  private getLease(): DaemonLease {
    if (!this.lease) {
      this.lease = new DaemonLease(
        MOONBOARD_SYNC_DAEMON,
        {
          acquireOrRenew: () =>
            acquireOrRenewDaemonLease(this.getDatabase(), {
              daemonName: MOONBOARD_SYNC_DAEMON,
              holderId: this.leaseHolderId,
              hostname: hostname(),
            }),
          release: () =>
            releaseDaemonLease(this.getDatabase(), {
              daemonName: MOONBOARD_SYNC_DAEMON,
              holderId: this.leaseHolderId,
            }),
        },
        {
          onLog: (message) => this.log(message),
          onError: (error) => this.handleError(error instanceof Error ? error : new Error(String(error))),
        },
      );
    }
    return this.lease;
  }

  private log(message: string): void {
    if (this.config.onLog) {
      this.config.onLog(message);
    } else {
      console.info(message);
    }
  }

  private handleError(error: Error): void {
    if (this.config.onError) {
      this.config.onError(error);
    } else {
      console.error('[MoonBoardSyncRunner] Error:', error);
    }
  }
}

import { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import {
  JOB_QUEUE_TIMER_OPTIONS,
  WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS,
  WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS,
  createJobQueueClient,
} from '../job-queue-client';

// pg-boss validates its options in the constructor and only connects on
// start(), so an unreachable connection string is enough here.
const connectionString = 'postgres://unused@127.0.0.1:1/unused';

describe('job queue client timers', () => {
  it('builds backend and worker clients with the slowed timers', () => {
    expect(() => createJobQueueClient({ connectionString, poolSize: 2, owner: 'backend' })).not.toThrow();
    expect(() => createJobQueueClient({ connectionString, poolSize: 1, owner: 'worker' })).not.toThrow();
  });

  it('stays inside the cron monitor ceiling that pg-boss enforces at construction', () => {
    // A value past 45 s (300 was once proposed) throws before the backend boots.
    expect(() => new PgBoss({ connectionString, ...JOB_QUEUE_TIMER_OPTIONS, cronMonitorIntervalSeconds: 46 })).toThrow(
      /cronMonitorIntervalSeconds/,
    );
  });
});

describe('job queue client deadlines (#6683)', () => {
  // pg-boss's default Db keeps the config it hands to pg.Pool, so this is what pg sees.
  const poolConfig = (boss: PgBoss) => (boss.getDb() as unknown as { config: Record<string, unknown> }).config;

  it('gives the worker pool a client-side read deadline', () => {
    const worker = createJobQueueClient({ connectionString, poolSize: 1, owner: 'worker' });
    expect(poolConfig(worker).query_timeout).toBe(WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS);
  });

  it('gives the worker pool a server-side deadline that fires before the client gives up', () => {
    const worker = createJobQueueClient({ connectionString, poolSize: 1, owner: 'worker' });
    expect(poolConfig(worker).statement_timeout).toBe(WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS);
    // The server must roll back its own statement first, or an abandoned fetch commits later.
    expect(WORKER_JOB_QUEUE_STATEMENT_TIMEOUT_MS).toBeLessThan(WORKER_JOB_QUEUE_QUERY_TIMEOUT_MS);
  });

  it('leaves the backend pool without either, so long supervision passes are not cut off', () => {
    const backend = createJobQueueClient({ connectionString, poolSize: 2, owner: 'backend' });
    expect(poolConfig(backend)).not.toHaveProperty('query_timeout');
    expect(poolConfig(backend)).not.toHaveProperty('statement_timeout');
  });
});

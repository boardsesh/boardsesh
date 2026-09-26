import { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { JOB_QUEUE_TIMER_OPTIONS, createJobQueueClient } from '../job-queue-client';

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

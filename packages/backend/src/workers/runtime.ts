import { createServer } from 'node:http';
import { and, count, eq, inArray, max, min } from 'drizzle-orm';
import { createDb, closePool } from '@boardsesh/db/client';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import { assertQueuePrimary, assertWorkerPrivileges, createJobQueueClient } from '../services/job-queue-client';
import { logger } from '../utils/logger';
import { enqueueOn } from '../services/job-queue';
import { executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from './jobs';
import type { WorkerConfig } from './config';

export async function startWorker(config: WorkerConfig) {
  const database = createDb();
  const boss = createJobQueueClient({ connectionString: config.databaseUrl, poolSize: 1, owner: 'worker' });
  const handler = handlerForRole(config.role);
  const shutdown = new AbortController();
  let ready = false;
  let stopping = false;
  let lastContact = 0;
  let pending = 0;
  let oldest: Date | null = null;
  let lastSuccess: Date | null = null;
  let completed = 0;
  let failed = 0;
  let active = 0;
  let monitor: ReturnType<typeof setTimeout> | undefined;
  let monitoring: Promise<void> | undefined;
  let polling: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  const health = createServer((request, response) => {
    const healthy = ready && !stopping && Date.now() - lastContact < 60_000;
    if (request.url === '/metrics') {
      response.setHeader('Content-Type', 'text/plain; version=0.0.4');
      const samples = {
        ready: Number(healthy),
        paused: Number(config.paused),
        active,
        pending,
        oldest_pending_seconds: oldest ? Math.max(0, (Date.now() - oldest.getTime()) / 1000) : 0,
        last_success_seconds: lastSuccess ? lastSuccess.getTime() / 1000 : 0,
        completed_total: completed,
        failures_total: failed,
        rss_bytes: process.memoryUsage().rss,
        peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
        process_start_seconds: started / 1000,
      };
      response.end(
        Object.entries(samples)
          .map(([name, sample]) => `boardsesh_worker_${name}{role="${config.role}"} ${sample}\n`)
          .join(''),
      );
      return;
    }
    if (request.url !== '/health') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ready: healthy, paused: config.paused, role: config.role }));
  });
  const probe = async () => {
    try {
      await assertQueuePrimary(boss.getDb());
      if (!(await boss.getQueue(handler.queue))) throw new Error('QUEUE_NOT_INITIALIZED');
      const [backlog] = await database
        .select({ pending: count(), oldest: min(backgroundJobRuns.createdAt) })
        .from(backgroundJobRuns)
        .where(
          and(
            eq(backgroundJobRuns.role, config.role),
            inArray(backgroundJobRuns.status, ['queued', 'running', 'retrying']),
          ),
        );
      const [success] = await database
        .select({ latest: max(backgroundJobRuns.finishedAt) })
        .from(backgroundJobRuns)
        .where(and(eq(backgroundJobRuns.role, config.role), eq(backgroundJobRuns.status, 'succeeded')));
      pending = backlog.pending;
      oldest = backlog.oldest;
      lastSuccess = success.latest;
      lastContact = Date.now();
      ready = !stopping;
    } catch {
      ready = false;
    }
  };
  try {
    await assertQueuePrimary(enqueueOn(database));
    await boss.start();
    await assertQueuePrimary(boss.getDb());
    await assertWorkerPrivileges(boss.getDb());
    await probe();
    if (!ready) throw new Error('WORKER_NOT_READY');
    await new Promise<void>((resolve, reject) => {
      health.once('error', reject);
      health.listen(config.healthPort, '0.0.0.0', () => {
        health.removeListener('error', reject);
        resolve();
      });
    });
    // Explicit fetch/settle avoids pg-boss work() acknowledging a superseding
    // attempt by job ID after an old handler loses its lease.
    const poll = async () => {
      try {
        const jobs = await boss.fetch<BackgroundJobPayload>(handler.queue, { includeMetadata: true, batchSize: 1 });
        for (const job of jobs) {
          if (stopping) break;
          active++;
          try {
            const outcome = await executeBackgroundJob(database, boss, job, handler, shutdown.signal);
            if (outcome === 'succeeded') completed++;
            if (outcome === 'failed') failed++;
          } finally {
            active--;
          }
        }
      } catch {
        ready = false;
        logger.warn('[worker] poll failed', { role: config.role });
      } finally {
        if (!stopping) {
          pollTimer = setTimeout(pollTick, 2_000);
          pollTimer.unref();
        }
      }
    };
    const pollTick = () => {
      polling = poll();
    };
    if (!config.paused) pollTick();
    const tick = () => {
      monitoring = probe().finally(() => {
        if (!stopping) {
          monitor = setTimeout(tick, 15_000);
          monitor.unref();
        }
      });
    };
    monitor = setTimeout(tick, 15_000);
    monitor.unref();
    logger.info('[worker] started', { role: config.role, paused: config.paused });
  } catch (error) {
    health.close();
    await boss.stop({ graceful: false, close: true });
    await closePool();
    throw error;
  }
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      ready = false;
      clearTimeout(monitor);
      clearTimeout(pollTimer);
      // Abort fetches/batches first; handlers cannot commit after their fence is lost.
      shutdown.abort();
      await polling;
      await monitoring;
      await boss.stop({ graceful: true, close: true, timeout: 115_000 });
      await closePool();
      await new Promise<void>((resolve) => health.close(() => resolve()));
      logger.info('[worker] stopped', { role: config.role });
    },
  };
}

import { createServer } from 'node:http';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PgBoss } from 'pg-boss';
import { count, inArray, min, sql } from 'drizzle-orm';
import { sprayWallDetections } from '@boardsesh/db/schema';
import { createDb, closePool } from '@boardsesh/db/client';
import { claimSprayDetection, finishSprayDetection, retrySprayDetectionAttempt } from '@boardsesh/db/queries';
import { SPRAY_DETECTION_QUEUE, type SprayDetectionJob } from '@boardsesh/shared-schema';
import { detectorConfig } from './config';
import { InferenceRunner } from './inference';
import { detectionProposal } from './result';

async function main(): Promise<void> {
  const config = detectorConfig();
  const database = createDb();
  const [primary] = await database.execute<{ writable: boolean }>(
    sql`SELECT NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off' AS writable`,
  );
  if (!primary?.writable) throw new Error('WRITABLE_PRIMARY_REQUIRED');
  const storage = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const inference = new InferenceRunner(config.model);
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    max: 3,
    migrate: false,
    supervise: false,
    schedule: false,
  });
  let ready = false;
  let stopping = false;
  let completed = 0;
  let failures = 0;
  let lastCompletedMs = 0;
  let lastQueueContact = 0;
  let pendingCount = 0;
  let oldestPendingAt: Date | null = null;
  const processStartedAt = Date.now() / 1000;
  boss.on('error', () => {
    ready = false;
    console.error(JSON.stringify({ event: 'queue_connection_failed' }));
  });
  const health = createServer((request, response) => {
    const healthy = ready && inference.ready && Date.now() - lastQueueContact < 60_000;
    if (request.url === '/metrics') {
      response.setHeader('Content-Type', 'text/plain; version=0.0.4');
      response.end(
        `boardsesh_detector_ready ${healthy ? 1 : 0}\nboardsesh_detector_completed_total ${completed}\nboardsesh_detector_failures_total ${failures}\nboardsesh_detector_last_duration_ms ${lastCompletedMs}\nboardsesh_detector_rss_bytes ${process.memoryUsage().rss}\nboardsesh_detector_pending ${pendingCount}\nboardsesh_detector_oldest_pending_seconds ${oldestPendingAt ? Math.max(0, (Date.now() - oldestPendingAt.getTime()) / 1000) : 0}\nboardsesh_detector_process_start_seconds ${processStartedAt}\nboardsesh_detector_model_info{version="${config.model.version}",sha256="${config.model.weightsSha256}"} 1\n`,
      );
      return;
    }
    response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ready: healthy, modelVersion: config.model.version }));
  });
  health.listen(config.healthPort, '0.0.0.0');
  await inference.start();
  await boss.start();
  await boss.work<SprayDetectionJob>(
    SPRAY_DETECTION_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs) => {
      for (const job of jobs) {
        const claim = await claimSprayDetection(database, job.data.detectionId, job.id);
        if (!claim) continue;
        const started = Date.now();
        try {
          if (claim.modelVersion !== config.model.version || claim.weightsSha256 !== config.model.weightsSha256)
            throw new Error('MODEL_MISMATCH');
          const object = await storage.send(new GetObjectCommand({ Bucket: config.bucket, Key: claim.photoKey }), {
            abortSignal: AbortSignal.timeout(20_000),
          });
          const cap = 20 * 1024 * 1024;
          if (!object.Body || (object.ContentLength ?? 0) > cap) throw new Error('INVALID_PHOTO');
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
            bytes += chunk.byteLength;
            if (bytes > cap) throw new Error('PHOTO_TOO_LARGE');
            chunks.push(chunk);
          }
          const result = await inference.run(Buffer.concat(chunks));
          const proposal = detectionProposal(result, { width: claim.photoWidth, height: claim.photoHeight });
          if (await finishSprayDetection(database, claim.id, claim.attemptToken, proposal)) completed++;
          lastCompletedMs = Date.now() - started;
          console.info(
            JSON.stringify({
              event: 'detection_finished',
              modelVersion: config.model.version,
              durationMs: lastCompletedMs,
              candidateCount: proposal.candidates.length,
              rssBytes: process.memoryUsage().rss,
            }),
          );
        } catch {
          failures++;
          await retrySprayDetectionAttempt(database, claim.id, claim.attemptToken);
          // pg-boss persists thrown errors. Never include private keys, URLs or image bytes.
          throw new Error('DETECTION_FAILED');
        }
      }
    },
  );
  const probe = async () => {
    try {
      await boss.getQueue(SPRAY_DETECTION_QUEUE);
      const [backlog] = await database
        .select({ pending: count(), oldest: min(sprayWallDetections.createdAt) })
        .from(sprayWallDetections)
        .where(inArray(sprayWallDetections.status, ['pending', 'running']));
      pendingCount = backlog.pending;
      oldestPendingAt = backlog.oldest;
      lastQueueContact = Date.now();
      ready = !stopping;
    } catch {
      ready = false;
    }
  };
  await probe();
  const heartbeat = setInterval(() => {
    void probe();
  }, 15_000);
  heartbeat.unref();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    ready = false;
    clearInterval(heartbeat);
    const deadline = setTimeout(() => process.exit(1), 130_000);
    deadline.unref();
    await boss.stop({ graceful: true, close: true, timeout: 115_000 });
    await inference.stop();
    storage.destroy();
    await closePool();
    health.close();
    clearTimeout(deadline);
  };
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
}

void main().catch(() => {
  console.error(JSON.stringify({ event: 'detector_start_failed' }));
  process.exit(1);
});

import { workerConfig, configureWorkerPools } from './config';
import { logger } from '../utils/logger';

async function main() {
  const config = workerConfig();
  configureWorkerPools();
  const { startWorker } = await import('./runtime');
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping || !worker) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 120_000);
    timeout.unref();
    try {
      await worker.stop();
    } catch {
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  };
  worker = await startWorker(config, {
    // A wedged job queue (#6683): drain like a SIGTERM, then exit non-zero so
    // Docker's `restart: unless-stopped` starts a fresh process. If the drain
    // itself hangs, the 120 s timer above still ends the process.
    onStalled: () => {
      process.exitCode = 1;
      void stop().finally(() => process.exit(1));
    },
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
}

void main().catch(() => {
  logger.error('[worker] startup failed', new Error('WORKER_START_FAILED'));
  process.exit(1);
});

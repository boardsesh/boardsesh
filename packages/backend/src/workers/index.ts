import { workerConfig, configureWorkerPools } from './config';
import { logger } from '../utils/logger';

async function main() {
  const config = workerConfig();
  configureWorkerPools();
  const { startWorker } = await import('./runtime');
  const worker = await startWorker(config);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
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

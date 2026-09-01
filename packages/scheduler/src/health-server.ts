import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeError, type SchedulerLogger } from './logger';
import type { JobStatus } from './runner';

export type HealthServer = {
  /** Resolves with the bound port (useful when starting on port 0 in tests). */
  start(): Promise<number>;
  stop(): Promise<void>;
};

export type CreateHealthServerOptions = {
  readonly port: number;
  readonly getStatus: () => JobStatus[];
  readonly logger: SchedulerLogger;
};

/** A scheduled job whose most recent run failed and has not since succeeded. */
function isDegraded(jobs: JobStatus[]): boolean {
  return jobs.some((job) => job.scheduled && job.lastError !== null);
}

/**
 * Two endpoints, split the way `packages/backend` splits `/health` from
 * `/health/db` (see docs/db-connectivity.md):
 *
 * - `GET /health` — liveness. 200 whenever the process is up, which is what
 *   Railway's `healthcheckPath = "/health"` polls. It deliberately does NOT go
 *   red on a failing job: restarting the container cannot fix a rotated
 *   `CRON_SECRET` or a WAF rule, and a restart would wipe the `lastError` that
 *   says which of the two it is. The body still reports `status: 'degraded'`
 *   so a human or a log scrape can see it.
 * - `GET /health/jobs` — job health. 503 when a scheduled job's last run
 *   failed, 200 otherwise. Point an alert at this one; Railway must not, or it
 *   will restart-loop on a problem restarts don't solve.
 */
export function createHealthServer({ port, getStatus, logger }: CreateHealthServerOptions): HealthServer {
  const server: Server = createServer((request, response) => {
    const requestPath = (request.url ?? '/').split('?')[0];

    if (request.method === 'GET' && (requestPath === '/health' || requestPath === '/health/jobs')) {
      const jobs = getStatus();
      const degraded = isDegraded(jobs);
      const body = JSON.stringify({ status: degraded ? 'degraded' : 'ok', degraded, jobs });
      const statusCode = requestPath === '/health/jobs' && degraded ? 503 : 200;
      response.writeHead(statusCode, { 'Content-Type': 'application/json' });
      response.end(body);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });

  return {
    start() {
      return new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          const boundPort = typeof address === 'object' && address !== null ? (address as AddressInfo).port : port;
          logger.info('health server listening', { port: boundPort });
          resolve(boundPort);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
      });
    },
    stop() {
      return new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            logger.warn('health server close failed', { error: describeError(error) });
          }
          resolve();
        });
        // Idle keep-alive sockets would otherwise hold the close open until
        // their timeout; the scheduler has no long-lived clients to drain.
        server.closeIdleConnections();
      });
    },
  };
}

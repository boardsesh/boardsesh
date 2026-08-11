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

/**
 * `GET /health` for Railway's healthcheck (`healthcheckPath = "/health"` in
 * railway.toml) and for a cheap ops answer to "are the crons actually
 * ticking?" — the per-job `lastRunAt` / `lastError` come straight off the
 * runner's status map.
 */
export function createHealthServer({ port, getStatus, logger }: CreateHealthServerOptions): HealthServer {
  const server: Server = createServer((request, response) => {
    const requestPath = (request.url ?? '/').split('?')[0];

    if (request.method === 'GET' && requestPath === '/health') {
      const body = JSON.stringify({ status: 'ok', jobs: getStatus() });
      response.writeHead(200, { 'Content-Type': 'application/json' });
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

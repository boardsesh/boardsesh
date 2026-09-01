import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';
import { pubsub } from '../pubsub/index';
import { getDbConnectRetryStats, probeDatabase } from '../services/db-health';
import { BUILD_RELEASE } from '../build-release';

const HEALTH_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

/**
 * Health check endpoint handler
 * GET /health
 *
 * The status code stays governed by Redis alone, and reports Postgres as data
 * rather than gating on it. /health is what the e2e workflow polls with
 * `wait-on http-get://localhost:8080/health` (.github/workflows/e2e-tests.yml
 * lines 336 and 584), what the dev orchestrator waits on
 * (scripts/dev-orchestrator.ts:424), and what the branch-deploy compose
 * healthcheck hits (docs/branch-deploys.md:442). Failing it during a Postgres
 * blip would strand all three, and party sessions over WebSocket keep working
 * without the database. Alert on /health/db instead.
 */
export async function handleHealthCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  const redisRequired = pubsub.isRedisRequired();
  const redisConnected = pubsub.isRedisConnected();
  const database = await probeDatabase();
  const retries = getDbConnectRetryStats();

  const databasePayload = {
    reachable: database.reachable,
    latencyMs: database.latencyMs,
    checkedAt: database.checkedAt,
    error: database.error,
    connectRetries: retries.count,
    lastConnectRetryAt: retries.lastRetryAt,
  };
  const deploymentIdentity = {
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID?.trim() || 'unknown',
    release: BUILD_RELEASE,
  };

  // If Redis is required but not connected, report unhealthy
  if (redisRequired && !redisConnected) {
    res.writeHead(503, HEALTH_RESPONSE_HEADERS);
    res.end(
      JSON.stringify({
        status: 'unhealthy',
        ...deploymentIdentity,
        timestamp: Date.now(),
        redis: { required: true, connected: false },
        database: databasePayload,
      }),
    );
    return;
  }

  res.writeHead(200, HEALTH_RESPONSE_HEADERS);
  res.end(
    JSON.stringify({
      status: 'healthy',
      ...deploymentIdentity,
      timestamp: Date.now(),
      redis: { required: redisRequired, connected: redisConnected },
      database: databasePayload,
    }),
  );
}

/**
 * Database health endpoint
 * GET /health/db
 *
 * 503 when Postgres does not answer. Deliberately not the Railway
 * `healthcheckPath` — this is the endpoint to point an external monitor or a
 * Sentry cron at, so a database outage pages someone instead of restarting a
 * backend that cannot fix it.
 */
export async function handleDatabaseHealthCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  const database = await probeDatabase();
  const retries = getDbConnectRetryStats();

  res.writeHead(database.reachable ? 200 : 503, HEALTH_RESPONSE_HEADERS);
  res.end(
    JSON.stringify({
      status: database.reachable ? 'healthy' : 'unhealthy',
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID?.trim() || 'unknown',
      release: BUILD_RELEASE,
      timestamp: Date.now(),
      database: {
        reachable: database.reachable,
        latencyMs: database.latencyMs,
        checkedAt: database.checkedAt,
        error: database.error,
        connectRetries: retries.count,
        lastConnectRetryAt: retries.lastRetryAt,
      },
    }),
  );
}

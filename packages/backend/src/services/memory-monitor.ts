import { memoryUsage, uptime } from 'node:process';
import sharp from 'sharp';
import { BUILD_RELEASE } from '../build-release';
import { getConnectionCount } from '../graphql/context';
import { getBoardGeometryCacheStats } from '../handlers/board-geometry';
import { maintainInstagramMetaCache } from '../lib/instagram-meta';
import { maintainTikTokMetaCache } from '../lib/tiktok-meta';
import { pubsub } from '../pubsub';
import { logger } from '../utils/logger';
import { getBoardRenderRuntimeStats } from './board-render';
import { roomManager } from './room-manager';

/** Counts and bytes only: never log tokens, URLs, user IDs, or cached payloads. */
export function collectBackendMemorySample() {
  return {
    event: 'backend.memory',
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID?.trim() || 'unknown',
    replicaId: process.env.RAILWAY_REPLICA_ID?.trim() || process.env.HOSTNAME || 'local',
    release: BUILD_RELEASE,
    uptimeSeconds: Math.floor(uptime()),
    memory: memoryUsage(),
    connections: getConnectionCount(),
    rooms: roomManager.getRuntimeStats(),
    subscriptions: pubsub.getRuntimeStats(),
    caches: {
      instagram: maintainInstagramMetaCache(),
      tiktok: maintainTikTokMetaCache(),
      geometry: getBoardGeometryCacheStats(),
    },
    renderer: getBoardRenderRuntimeStats(),
    sharp: { cache: sharp.cache(), tasks: sharp.counters() },
  };
}

/** The server owns this timer and clears it alongside its other intervals. */
export function startBackendMemoryMonitoring(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      logger.info('[Memory] Backend runtime sample', collectBackendMemorySample());
    } catch (error) {
      logger.warn('[Memory] Could not collect runtime sample:', error);
    }
  }, 60_000);
  timer.unref();
  return timer;
}

import { resourceUsage } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { collectBackendMemorySample, startBackendMemoryMonitoring } from '../memory-monitor';
import { maintainInstagramMetaCache } from '../../lib/instagram-meta';
import { maintainTikTokMetaCache } from '../../lib/tiktok-meta';
import { logger } from '../../utils/logger';

vi.mock('node:process', async (importOriginal) => {
  const processModule = await importOriginal<typeof import('node:process')>();
  return { ...processModule, resourceUsage: vi.fn(() => processModule.resourceUsage()) };
});

vi.mock('../../lib/instagram-meta', () => ({
  maintainInstagramMetaCache: vi.fn(() => ({ entries: 0, serializedBytes: 0 })),
}));
vi.mock('../../lib/tiktok-meta', () => ({
  maintainTikTokMetaCache: vi.fn(() => ({ entries: 0, serializedBytes: 0 })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('backend memory monitoring', () => {
  it('identifies the replica and reports counts without cached payloads', () => {
    vi.stubEnv('RAILWAY_DEPLOYMENT_ID', 'deployment');
    vi.stubEnv('RAILWAY_REPLICA_ID', 'replica');
    const sample = collectBackendMemorySample();
    expect(sample).toMatchObject({ event: 'backend.memory', deploymentId: 'deployment', replicaId: 'replica' });
    expect(sample.memory.rss).toBeGreaterThan(0);
    expect(sample.memory.heapUsed).toBeGreaterThan(0);
    expect(sample.subscriptions.queue).toEqual({ channels: 0, subscribers: 0 });
    expect(sample.rooms.pendingWrites).toBe(0);
    expect(sample.caches.instagram).toEqual({ entries: 0, serializedBytes: 0 });
  });

  it('sweeps idle caches once a minute and stops when the server clears its timer', async () => {
    vi.useFakeTimers();
    vi.mocked(maintainInstagramMetaCache).mockClear();
    vi.mocked(maintainTikTokMetaCache).mockClear();
    const log = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const timer = startBackendMemoryMonitoring();
    expect(timer.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(maintainInstagramMetaCache).toHaveBeenCalledTimes(1);
    expect(maintainTikTokMetaCache).toHaveBeenCalledTimes(1);
    clearInterval(timer);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('reports the process lifetime RSS peak in bytes, not just sampled RSS', () => {
    vi.mocked(resourceUsage).mockReturnValueOnce({ ...resourceUsage(), maxRSS: 12 * 1024 * 1024 });
    const sample = collectBackendMemorySample();
    expect(sample.memory.peakRssBytes).toBe(12 * 1024 * 1024 * 1024);
    expect(sample.memory.rss).toBeGreaterThan(0);
  });
});

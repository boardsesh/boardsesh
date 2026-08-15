import { describe, expect, it } from 'vitest';
import { evaluateSnapshotHeartbeat, snapshotHeartbeatDecision } from '../scripts/snapshot-heartbeat-watchdog';
import { DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS } from '../scripts/snapshot-contract';

const NOW_MS = Date.parse('2026-08-15T12:00:00.000Z');
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const MANIFEST_GENERATED_AT = '2026-08-15T11:54:59.000Z';

function heartbeat(runKind: 'refresh' | 'full', completedAt = '2026-08-15T11:55:00.000Z'): unknown {
  return {
    formatVersion: 1,
    completedAt,
    runKind,
    source: 'replica',
    imageDigest: IMAGE_DIGEST,
    keyPrefix: 'board-snapshots/v1-gzip',
    stableBefore: '2026-08-15T11:54:30.000Z',
    targetLsn: '0/16B6C50',
    replayLsn: '0/16B6C50',
    systemIdentifier: '7612345678901234567',
    timelineId: 1,
    manifestGeneratedAt: MANIFEST_GENERATED_AT,
    refreshedLayouts: 0,
  };
}

describe('snapshot heartbeat watchdog', () => {
  it('accepts a fresh live-prefix heartbeat from the intended homelab replica publisher', () => {
    expect(
      evaluateSnapshotHeartbeat({
        payload: heartbeat('refresh'),
        expectedRunKind: 'refresh',
        expectedImageDigest: IMAGE_DIGEST,
        expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
        nowMs: NOW_MS,
        maxAgeSeconds: 45 * 60,
      }),
    ).toEqual({ stale: false, ageSeconds: 300, reason: 'fresh' });
  });

  it('fails closed for stale, future, partial-prefix, or mutable-image claims', () => {
    const stale = evaluateSnapshotHeartbeat({
      payload: heartbeat('refresh', '2026-08-15T10:00:00.000Z'),
      expectedRunKind: 'refresh',
      expectedImageDigest: IMAGE_DIGEST,
      expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
      nowMs: NOW_MS,
      maxAgeSeconds: 45 * 60,
    });
    expect(stale.stale).toBe(true);

    const future = evaluateSnapshotHeartbeat({
      payload: heartbeat('refresh', '2026-08-15T12:10:01.000Z'),
      expectedRunKind: 'refresh',
      expectedImageDigest: IMAGE_DIGEST,
      expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
      nowMs: NOW_MS,
      maxAgeSeconds: 45 * 60,
    });
    expect(future).toMatchObject({ stale: true, reason: expect.stringContaining('future') });

    const wrongPrefix = { ...(heartbeat('refresh') as Record<string, unknown>), keyPrefix: 'shadow/v1-gzip' };
    expect(
      evaluateSnapshotHeartbeat({
        payload: wrongPrefix,
        expectedRunKind: 'refresh',
        expectedImageDigest: IMAGE_DIGEST,
        expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
        nowMs: NOW_MS,
        maxAgeSeconds: 45 * 60,
      }),
    ).toMatchObject({ stale: true, reason: expect.stringContaining('not for') });

    const mutableImage = { ...(heartbeat('refresh') as Record<string, unknown>), imageDigest: 'latest' };
    expect(
      evaluateSnapshotHeartbeat({
        payload: mutableImage,
        expectedRunKind: 'refresh',
        expectedImageDigest: IMAGE_DIGEST,
        expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
        nowMs: NOW_MS,
        maxAgeSeconds: 45 * 60,
      }),
    ).toMatchObject({ stale: true, reason: expect.stringContaining('immutable') });
  });

  it('rejects an otherwise-fresh full heartbeat without a current refresh lineage anchor', async () => {
    const decision = await snapshotHeartbeatDecision({
      publicBaseUrl: 'https://example.test/',
      expectedImageDigest: IMAGE_DIGEST,
      nowMs: NOW_MS,
      fetchHeartbeat: async (url) => {
        if (url.includes('/manifest.json')) {
          return { formatVersion: 1, generatedAt: MANIFEST_GENERATED_AT, entries: [] };
        }
        if (url.includes('/refresh.json')) throw new Error('refresh missing');
        return heartbeat('full');
      },
    });

    expect(decision.refresh).toEqual({ stale: true, ageSeconds: null, reason: 'refresh missing' });
    expect(decision.full).toEqual({
      stale: true,
      ageSeconds: null,
      reason: 'current refresh heartbeat is unavailable for PostgreSQL lineage validation',
    });
  });

  it('accepts the matching refresh and full heartbeat pair emitted by a full run', async () => {
    const decision = await snapshotHeartbeatDecision({
      publicBaseUrl: 'https://example.test/',
      expectedImageDigest: IMAGE_DIGEST,
      nowMs: NOW_MS,
      fetchHeartbeat: async (url) => {
        if (url.includes('/manifest.json')) {
          return { formatVersion: 1, generatedAt: MANIFEST_GENERATED_AT, entries: [] };
        }
        if (url.includes('/refresh.json')) return heartbeat('refresh');
        return heartbeat('full');
      },
    });

    expect(decision.refresh).toEqual({ stale: false, ageSeconds: 300, reason: 'fresh' });
    expect(decision.full).toEqual({ stale: false, ageSeconds: 300, reason: 'fresh' });
  });

  it('requires HTTPS outside explicit loopback development URLs', async () => {
    await expect(
      snapshotHeartbeatDecision({
        publicBaseUrl: 'http://snapshots.example.test',
        expectedImageDigest: IMAGE_DIGEST,
        nowMs: NOW_MS,
        fetchHeartbeat: async () => heartbeat('refresh'),
      }),
    ).rejects.toThrow('must use HTTPS');

    const fetchedUrls: string[] = [];
    const decision = await snapshotHeartbeatDecision({
      publicBaseUrl: 'http://127.0.0.1:3000/',
      expectedImageDigest: IMAGE_DIGEST,
      nowMs: NOW_MS,
      fetchHeartbeat: async (url) => {
        fetchedUrls.push(url);
        if (url.includes('/manifest.json')) {
          return { formatVersion: 1, generatedAt: MANIFEST_GENERATED_AT, entries: [] };
        }
        if (url.includes('/refresh.json')) return heartbeat('refresh');
        return heartbeat('full');
      },
    });
    expect(decision.refresh.stale).toBe(false);
    expect(fetchedUrls).toHaveLength(3);
    expect(fetchedUrls.every((url) => url.startsWith('http://127.0.0.1:3000/'))).toBe(true);
  });

  it('rejects a full heartbeat from an older PostgreSQL lineage', async () => {
    const oldFull = {
      ...(heartbeat('full') as Record<string, unknown>),
      systemIdentifier: '7699999999999999999',
    };
    const decision = await snapshotHeartbeatDecision({
      publicBaseUrl: 'https://example.test/',
      expectedImageDigest: IMAGE_DIGEST,
      nowMs: NOW_MS,
      fetchHeartbeat: async (url) => {
        if (url.includes('/manifest.json')) {
          return { formatVersion: 1, generatedAt: MANIFEST_GENERATED_AT, entries: [] };
        }
        if (url.includes('/refresh.json')) return heartbeat('refresh');
        return oldFull;
      },
    });

    expect(decision.refresh.stale).toBe(false);
    expect(decision.full).toMatchObject({ stale: true, reason: expect.stringContaining('lineage') });
  });

  it('rejects an expired cutoff with the shared publisher and verifier default', () => {
    const completedAtMs = NOW_MS - 5 * 60 * 1000;
    const expiredCutoff = {
      ...(heartbeat('refresh', new Date(completedAtMs).toISOString()) as Record<string, unknown>),
      stableBefore: new Date(completedAtMs - (DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS + 1) * 1000).toISOString(),
    };
    expect(
      evaluateSnapshotHeartbeat({
        payload: expiredCutoff,
        expectedRunKind: 'refresh',
        expectedImageDigest: IMAGE_DIGEST,
        expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
        nowMs: NOW_MS,
        maxAgeSeconds: 45 * 60,
      }),
    ).toMatchObject({ stale: true, reason: expect.stringContaining('cutoff') });
  });

  it('rejects a heartbeat whose run kind does not match its object key', () => {
    expect(
      evaluateSnapshotHeartbeat({
        payload: heartbeat('full'),
        expectedRunKind: 'refresh',
        expectedImageDigest: IMAGE_DIGEST,
        expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
        nowMs: NOW_MS,
        maxAgeSeconds: 45 * 60,
      }),
    ).toMatchObject({ stale: true, reason: 'expected refresh heartbeat' });
  });

  it('rejects a valid but different released image digest', () => {
    expect(
      evaluateSnapshotHeartbeat({
        payload: heartbeat('refresh'),
        expectedRunKind: 'refresh',
        expectedImageDigest: `sha256:${'b'.repeat(64)}`,
        expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
        nowMs: NOW_MS,
        maxAgeSeconds: 45 * 60,
      }),
    ).toMatchObject({ stale: true, reason: expect.stringContaining('configured release') });
  });

  it('rejects a heartbeat from a different manifest generation', () => {
    expect(
      evaluateSnapshotHeartbeat({
        payload: heartbeat('refresh'),
        expectedRunKind: 'refresh',
        expectedImageDigest: IMAGE_DIGEST,
        expectedManifestGeneratedAt: '2026-08-15T11:59:00.000Z',
        nowMs: NOW_MS,
        maxAgeSeconds: 45 * 60,
      }),
    ).toMatchObject({ stale: true, reason: expect.stringContaining('currently published manifest') });
  });

  it('rejects a heartbeat without the fenced PostgreSQL identity', () => {
    const missingIdentity = { ...(heartbeat('refresh') as Record<string, unknown>) };
    delete missingIdentity.systemIdentifier;
    expect(
      evaluateSnapshotHeartbeat({
        payload: missingIdentity,
        expectedRunKind: 'refresh',
        expectedImageDigest: IMAGE_DIGEST,
        expectedManifestGeneratedAt: MANIFEST_GENERATED_AT,
        nowMs: NOW_MS,
        maxAgeSeconds: 45 * 60,
      }),
    ).toMatchObject({ stale: true, reason: expect.stringContaining('system identifier') });
  });
});

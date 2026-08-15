// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { SnapshotSource } from '@boardsesh/offline-sync';

const snapshotConfig = vi.hoisted(() => ({ available: true }));
const mobileSnapshotSource = vi.hoisted(
  () =>
    ({
      fetchManifest: vi.fn(async () => null),
      downloadArtifact: vi.fn(async () => null),
      downloadGradesArtifact: vi.fn(async () => null),
      deleteArtifact: vi.fn(async () => {}),
      releaseArtifact: vi.fn(async () => {}),
    }) satisfies SnapshotSource,
);

vi.mock('../../lib/env', () => ({ isSnapshotBaseUrlConfigured: () => snapshotConfig.available }));
vi.mock('../snapshot-source', () => ({ mobileSnapshotSource }));

import { useSnapshotSource } from '../use-snapshot-source';
import { useSnapshotSource as useWebSnapshotSource } from '../use-snapshot-source.web';

beforeEach(() => {
  snapshotConfig.available = true;
});

afterEach(() => {
  cleanup();
});

describe('useSnapshotSource', () => {
  it('always hands native sync the full snapshot source when the build URL exists', () => {
    const { result } = renderHook(() => useSnapshotSource());

    expect(result.current).toBe(mobileSnapshotSource);
    expect(result.current?.downloadGradesArtifact).toBeTypeOf('function');
    expect(result.current?.releaseArtifact).toBeTypeOf('function');
  });

  it('uses the safe paged fallback only when this build has no snapshot URL', () => {
    snapshotConfig.available = false;

    const { result } = renderHook(() => useSnapshotSource());

    expect(result.current).toBeUndefined();
  });

  it('never exposes native snapshot I/O to Expo web', () => {
    const { result } = renderHook(() => useWebSnapshotSource());

    expect(result.current).toBeUndefined();
  });
});

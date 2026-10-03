import { describe, expect, it } from 'vitest';
import type { SprayWallImportProgress } from '@boardsesh/shared-schema';
import { sprayImportCopy, sprayImportRoute } from '../spray-import-progress';

function progress(changes: Partial<SprayWallImportProgress> = {}): SprayWallImportProgress {
  return {
    wallUuid: 'wall-uuid',
    versionId: '42',
    detectionId: 'detection-uuid',
    stage: 'queued',
    queuePosition: 3,
    retryAt: null,
    isReset: false,
    ...changes,
  };
}

describe('spray import status and resume targets', () => {
  it.each([
    ['draft', 'sprayImport.draft'],
    ['running', 'sprayImport.running'],
    ['ready', 'sprayImport.ready'],
    ['failed', 'sprayImport.failed'],
  ] as const)('shows the saved %s stage', (stage, textI18nKey) => {
    expect(sprayImportCopy(progress({ stage }))).toEqual({ textI18nKey, params: {} });
  });

  it('shows queue position only while the eligible job is waiting', () => {
    expect(sprayImportCopy(progress())).toEqual({
      textI18nKey: 'sprayImport.queuePosition',
      params: { position: 3 },
    });
    expect(sprayImportCopy(progress({ queuePosition: null }))).toEqual({
      textI18nKey: 'sprayImport.queued',
      params: {},
    });
    expect(sprayImportCopy(progress({ retryAt: '2026-10-03T13:00:00Z' }))).toEqual({
      textI18nKey: 'sprayImport.retrying',
      params: {},
    });
  });

  it('masks stale waiting and running statuses without turning saved outcomes into failures', () => {
    expect(sprayImportCopy(progress(), true)).toEqual({ textI18nKey: 'sprayImport.offline', params: {} });
    expect(sprayImportCopy(progress({ stage: 'running' }), true)).toEqual({
      textI18nKey: 'sprayImport.offline',
      params: {},
    });
    expect(sprayImportCopy(progress({ stage: 'ready' }), true).textI18nKey).toBe('sprayImport.ready');
    expect(sprayImportCopy(progress({ stage: 'failed' }), true).textI18nKey).toBe('sprayImport.failed');
  });

  it('resumes the exact new-wall or reset version without losing its wall identity', () => {
    expect(sprayImportRoute(progress())).toEqual({
      pathname: '/boards/spray/new',
      params: { wallUuid: 'wall-uuid', versionId: '42' },
    });
    expect(sprayImportRoute(progress({ isReset: true }))).toEqual({
      pathname: '/boards/spray/reset',
      params: { wallUuid: 'wall-uuid', versionId: '42' },
    });
    expect(sprayImportRoute(progress({ versionId: null }))).toEqual({
      pathname: '/boards/spray/new',
      params: { wallUuid: 'wall-uuid' },
    });
  });
});

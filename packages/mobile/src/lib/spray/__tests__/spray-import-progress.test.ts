import { describe, expect, it } from 'vitest';
import type { SprayWallImportProgress } from '@boardsesh/shared-schema';
import { sprayImportCopy, sprayImportRoute, unfinishedSprayWallRoute } from '../spray-import-progress';

function progress(changes: Partial<SprayWallImportProgress> = {}): SprayWallImportProgress {
  return {
    wallUuid: 'wall-uuid',
    versionId: '42',
    detectionId: 'detection-uuid',
    stage: 'queued',
    queuePosition: 3,
    retryAt: null,
    resetOfWallUuid: null,
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

  it('resumes a new wall at its exact version and a reset clone through the wall it replaces', () => {
    expect(sprayImportRoute(progress())).toEqual({
      pathname: '/boards/spray/new',
      params: { wallUuid: 'wall-uuid', versionId: '42' },
    });
    expect(sprayImportRoute(progress({ resetOfWallUuid: 'old-wall-uuid' }))).toEqual({
      pathname: '/boards/spray/new',
      params: { resetOf: 'old-wall-uuid' },
    });
    expect(sprayImportRoute(progress({ versionId: null }))).toEqual({
      pathname: '/boards/spray/new',
      params: { wallUuid: 'wall-uuid' },
    });
  });
});

describe('where a My Boards / Manage row press goes', () => {
  const listedUnfinished = new Set(['wall-uuid']);

  it('follows the live import when there is one', () => {
    expect(unfinishedSprayWallRoute({ uuid: 'wall-uuid', sprayImport: progress() }, new Set())).toEqual({
      pathname: '/boards/spray/new',
      params: { wallUuid: 'wall-uuid', versionId: '42' },
    });
  });

  it('opens the wizard by wall for a wall the list called unfinished whose progress is gone', () => {
    expect(unfinishedSprayWallRoute({ uuid: 'wall-uuid', sprayImport: null }, listedUnfinished)).toEqual({
      pathname: '/boards/spray/new',
      params: { wallUuid: 'wall-uuid' },
    });
  });

  it('leaves every other board to the normal climbing path', () => {
    expect(unfinishedSprayWallRoute({ uuid: 'other', sprayImport: null }, listedUnfinished)).toBeNull();
  });
});

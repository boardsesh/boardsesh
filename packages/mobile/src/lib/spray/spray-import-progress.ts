import type { SprayWallImportProgress } from '@boardsesh/shared-schema';

export function sprayImportCopy(progress: SprayWallImportProgress, stale = false) {
  if (stale && (progress.stage === 'queued' || progress.stage === 'running')) {
    return { textI18nKey: 'sprayImport.offline', params: {} };
  }
  switch (progress.stage) {
    case 'draft':
      return { textI18nKey: 'sprayImport.draft', params: {} };
    case 'queued':
      if (progress.retryAt) return { textI18nKey: 'sprayImport.retrying', params: {} };
      return progress.queuePosition == null
        ? { textI18nKey: 'sprayImport.queued', params: {} }
        : { textI18nKey: 'sprayImport.queuePosition', params: { position: progress.queuePosition } };
    case 'running':
      return { textI18nKey: 'sprayImport.running', params: {} };
    case 'ready':
      return { textI18nKey: 'sprayImport.ready', params: {} };
    case 'failed':
      return { textI18nKey: 'sprayImport.failed', params: {} };
  }
}

export function sprayImportRoute(progress: Pick<SprayWallImportProgress, 'wallUuid' | 'versionId' | 'isReset'>) {
  return {
    pathname: progress.isReset ? ('/boards/spray/reset' as const) : ('/boards/spray/new' as const),
    params: {
      wallUuid: progress.wallUuid,
      ...(progress.versionId ? { versionId: progress.versionId } : {}),
    },
  };
}

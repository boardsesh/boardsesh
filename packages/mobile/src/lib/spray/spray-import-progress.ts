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

/**
 * A reset clone reopens through the wizard's reset path, which rejoins the
 * unfinished clone by the wall it replaces; any other import resumes its photo.
 */
export function sprayImportRoute(
  progress: Pick<SprayWallImportProgress, 'wallUuid' | 'versionId' | 'resetOfWallUuid'>,
): { pathname: '/boards/spray/new'; params: Record<string, string> } {
  if (progress.resetOfWallUuid) {
    return { pathname: '/boards/spray/new', params: { resetOf: progress.resetOfWallUuid } };
  }
  return {
    pathname: '/boards/spray/new',
    params: {
      wallUuid: progress.wallUuid,
      ...(progress.versionId ? { versionId: progress.versionId } : {}),
    },
  };
}

/**
 * Where a press on a My Boards / Manage row goes when the row is a spray wall
 * that is not finished yet, or null for a board that can be climbed on.
 *
 * `unfinishedWallUuids` are the walls the SERVER listed with an import
 * (`useSprayImportProgress`). A live progress read that later omits one clears
 * the row's `sprayImport`, but the row must still never activate, download or
 * open climb creation on the strength of that alone: it goes to the wizard by
 * wall uuid, which resumes an unfinished wall and binds a published one.
 */
export function unfinishedSprayWallRoute(
  board: { uuid: string; sprayImport?: SprayWallImportProgress | null },
  unfinishedWallUuids: ReadonlySet<string>,
): { pathname: '/boards/spray/new'; params: Record<string, string> } | null {
  if (board.sprayImport) return sprayImportRoute(board.sprayImport);
  if (unfinishedWallUuids.has(board.uuid)) {
    return { pathname: '/boards/spray/new', params: { wallUuid: board.uuid } };
  }
  return null;
}

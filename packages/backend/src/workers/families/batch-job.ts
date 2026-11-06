import type { JobLogger, JobSystemUserAuthority, JobTransact } from '@boardsesh/db/jobs';
import { AuthBackendUnavailableError } from '@boardsesh/auth-protocol/transport';
import { currentStoreBatchSystemUsersMode } from '../../auth/current-store/authority-configuration';
import { logger } from '../../utils/logger';
import type { BackgroundJobContext } from './types';

/**
 * The job bodies in `@boardsesh/db/jobs` take a write-batch runner. On the
 * worker that runner is the attempt fence, so every batch commits only while
 * this attempt still owns the run.
 */
export function fencedTransact(context: BackgroundJobContext): JobTransact {
  return (callback) => context.transaction((transaction) => callback(transaction));
}

/** Hand-built contexts cannot silently use a direct writer when staging is selected. */
export function systemUserAuthorityForContext(context: BackgroundJobContext): JobSystemUserAuthority {
  const authority = context.systemUserAuthority;
  if (authority) {
    if (authority.mode === 'legacy') return authority;
    if (authority.mode === 'backend-staging' && typeof authority.ensure === 'function') return authority;
    throw new AuthBackendUnavailableError();
  }
  if (currentStoreBatchSystemUsersMode() !== 'legacy') throw new AuthBackendUnavailableError();
  return { mode: 'legacy' };
}

/** Job progress lines, labelled with the family and run. */
export function jobLogger(context: BackgroundJobContext): JobLogger {
  const labels = { family: context.family, runId: context.runId };
  return {
    info: (message) => logger.info(message, labels),
    warn: (message) => logger.warn(message, labels),
  };
}

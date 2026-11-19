import { eq, sql } from 'drizzle-orm';
import { authAccount, authEmailProjection, authSession } from '@boardsesh/db/schema/auth';
import { identityMirrorMode } from '../../auth/authority/mirror-configuration';
import {
  CURRENT_EMAIL_NORMALIZER_VERSION,
  lockAuthorityGateExclusively,
} from '../../auth/current-store/foundation-context';
import type { ConsolidationTransaction } from './executor';
import { ConsolidationError } from './planner';

/** The legacy-only repair cannot keep a canonical identity copy in step. */
export async function lockConsolidationAuthority(transaction: ConsolidationTransaction): Promise<void> {
  await lockAuthorityGateExclusively(transaction);
  try {
    if (identityMirrorMode() !== 'off') throw new ConsolidationError('UNSUPPORTED_AUTHORITY');
  } catch {
    throw new ConsolidationError('UNSUPPORTED_AUTHORITY');
  }
  const [manifest] = await transaction
    .select({
      writerAuthority: authEmailProjection.writerAuthority,
      normalizerVersion: authEmailProjection.normalizerVersion,
      phase: authEmailProjection.phase,
      writerEpoch: authEmailProjection.writerEpoch,
    })
    .from(authEmailProjection)
    .where(eq(authEmailProjection.isCurrent, true));
  if (
    manifest &&
    (manifest.writerAuthority !== 'current-store' ||
      manifest.phase !== 'enforced' ||
      manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
      !Number.isSafeInteger(manifest.writerEpoch) ||
      manifest.writerEpoch <= 0)
  )
    throw new ConsolidationError('UNSUPPORTED_AUTHORITY');
  // The maintenance fence drains other writers. The exclusive gate keeps an
  // import, mirror or authority switch from changing this verdict before commit.
  const [canonical] = await transaction.execute<{ present: boolean }>(
    sql`SELECT EXISTS(SELECT 1 FROM ${authAccount}) OR EXISTS(SELECT 1 FROM ${authSession}) AS present`,
  );
  if (!canonical || canonical.present !== false) throw new ConsolidationError('UNSUPPORTED_AUTHORITY');
}

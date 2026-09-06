import type { ConnectionContext } from '@boardsesh/shared-schema';
import { validateArtwork } from '../../../services/cnc/worker-client';
import { applyRateLimit, requireAuthenticated } from '../shared/helpers';
import { resolveCncConfig } from './config';
import { toGraphQLWorkerError } from './queries';

/**
 * Write side of CNC build packs. Read-only for now: checkout, downloads and
 * regeneration land in later PRs.
 */

/**
 * Ceiling on artwork validations per minute.
 *
 * Higher than the layout limit because the placement editor debounces against
 * this while the buyer drags — a minute of steady repositioning is genuinely
 * dozens of calls. Authenticated-only, so the bucket is per user rather than
 * per IP.
 */
const RATE_LIMIT_VALIDATE_ARTWORK = 60;
const RATE_LIMIT_VALIDATE_ARTWORK_OP = 'validateCncArtwork';

export const cncPackMutations = {
  /**
   * The authoritative verdict on a configuration's artwork.
   *
   * The placement editor runs its own collision maths for live feedback while
   * the buyer drags, but that copy exists to feel instant, not to be right.
   * This is the generator's own answer, computed by the same code that will
   * route the panel, and it is what the Buy button waits on.
   *
   * Authenticated because artwork items reference uploaded assets, and because
   * there is no reason for an anonymous caller to be exercising the generator's
   * most expensive endpoint.
   */
  validateCncArtwork: async (
    _: unknown,
    { config }: { config: unknown },
    ctx: ConnectionContext,
  ): Promise<{ ok: boolean; collisions: unknown }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_VALIDATE_ARTWORK, RATE_LIMIT_VALIDATE_ARTWORK_OP);

    let verdict: unknown;
    try {
      // Run inside this try, alongside the generator call, so a mapping
      // error out of resolveCncConfig (bad option, unparseable sheet stock)
      // classifies as CNC_INVALID_CONFIG the same way a worker rejection does.
      const { layoutRequest, artwork } = resolveCncConfig(config);
      verdict = await validateArtwork(layoutRequest, artwork);
    } catch (error) {
      throw toGraphQLWorkerError(error);
    }

    // Fail closed on a shape we do not recognise. A malformed verdict read as
    // "no collisions" would let unroutable artwork through to checkout, which
    // is the one outcome this call exists to prevent.
    const body = (typeof verdict === 'object' && verdict !== null ? verdict : {}) as {
      ok?: unknown;
      collisions?: unknown;
    };
    return {
      ok: body.ok === true,
      collisions: Array.isArray(body.collisions) ? body.collisions : [],
    };
  },
};

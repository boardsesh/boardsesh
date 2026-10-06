import { MAX_ARCHIVED_SPRAY_WALLS_PER_USER } from '@boardsesh/board-config';
import type { SprayWallLifecycleRefusal } from '../graphql/extract-error-message';

/**
 * A lifecycle refusal (`sprayWallLifecycleRefusal`) said in the climber's own
 * language, with the archive cap's number where it has one, ahead of anything
 * the server wrote. Beside `spray-cap-copy.ts`, and for the same reason: the
 * server's prose is not translated and is never shown.
 */

/** Whatever renders a `boards` catalog key. */
export type SprayLifecycleTranslator = (key: string, values?: { max: number }) => string;

/**
 * The sentence for one refusal. A switch with literal keys, because the i18n
 * orphan check has to be able to find each one. Takes the `boards` namespace's `t`.
 */
export function sprayWallLifecycleMessage(refusal: SprayWallLifecycleRefusal, t: SprayLifecycleTranslator): string {
  switch (refusal) {
    case 'archived':
      return t('sprayWallErrors.archived');
    case 'holdsLocked':
      return t('sprayWallErrors.holdsLocked');
    case 'resetRetired':
      // Unreachable from this build: the server sends it only for the retired
      // in-place reset endpoints, which nothing here calls any more. Kept so the
      // code never falls through to the server's prose, and the copy tells a
      // climber on an old build to update.
      return t('sprayWallErrors.resetRetired');
    case 'resetOwnerOnly':
      return t('sprayWallErrors.resetOwnerOnly');
    case 'resetSourceUnpublished':
      return t('sprayWallErrors.resetSourceUnpublished');
    case 'archiveLimitReached':
      return t('sprayWallErrors.archiveLimitReached', { max: MAX_ARCHIVED_SPRAY_WALLS_PER_USER });
  }
}

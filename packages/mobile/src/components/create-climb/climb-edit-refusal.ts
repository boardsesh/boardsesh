import { extractGraphqlCode } from '../../lib/graphql/extract-error-message';

/**
 * The reasons `updateClimb` refuses an edit that the editor can say in the
 * climber's own language (#5955).
 *
 *  - `conflict`: the save was decided on a row another edit has since replaced,
 *    say from the setter's other phone.
 *  - `notAllowed`: the caller is not the climb's setter. The app offers Edit to
 *    the setter alone, so this is a draft opened from somewhere that skipped
 *    that check, or a server that changed its mind first.
 *  - `windowExpired`: a published climb, more than 24 hours after publishing,
 *    on any board, a spray wall included.
 *  - `notEditable`: a published climb with no publish date on record.
 */
export type ClimbEditRefusal = 'conflict' | 'notAllowed' | 'windowExpired' | 'notEditable';

/**
 * `extensions.code` for each. Mirrors `CLIMB_EDIT_CONFLICT_ERROR_CODE` and
 * `CLIMB_EDIT_REFUSAL_CODES` in the backend's `climb-revisions.ts`; those
 * constants are not exported to clients.
 */
const REFUSAL_BY_CODE: Record<string, ClimbEditRefusal> = {
  CLIMB_EDIT_CONFLICT: 'conflict',
  CLIMB_EDIT_NOT_ALLOWED: 'notAllowed',
  CLIMB_EDIT_WINDOW_EXPIRED: 'windowExpired',
  CLIMB_NOT_EDITABLE: 'notEditable',
};

/**
 * Which refusal a failed save was, or null for anything else (a dropped
 * connection, a validation error, a server that predates the codes).
 *
 * Matched on the code, never on the message text: the server's prose is not a
 * contract and is not translated, and it is never shown. Reads the code off
 * `GraphQLOperationError` (which lifts the first coded error's extensions onto
 * itself) and off a raw graphql-request error alike.
 */
export function climbEditRefusal(error: unknown): ClimbEditRefusal | null {
  if (!error || typeof error !== 'object') return null;
  const lifted = (error as { extensions?: { code?: unknown } | null }).extensions?.code;
  const code = typeof lifted === 'string' ? lifted : extractGraphqlCode(error);
  if (!code || !Object.hasOwn(REFUSAL_BY_CODE, code)) return null;
  return REFUSAL_BY_CODE[code];
}

/** Whatever renders a `climbs` catalog key. */
type Translate = (key: string) => string;

/**
 * The line the editor shows for a refusal. A switch with literal keys, because
 * the i18n orphan check has to be able to find each one.
 */
export function climbEditRefusalMessage(refusal: ClimbEditRefusal, t: Translate): string {
  switch (refusal) {
    case 'conflict':
      return t('createClimbForm.alerts.editConflict');
    case 'notAllowed':
      return t('createClimbForm.alerts.editNotAllowed');
    case 'windowExpired':
      return t('createClimbForm.alerts.editWindowExpired');
    case 'notEditable':
      return t('createClimbForm.alerts.editNotEditable');
  }
}

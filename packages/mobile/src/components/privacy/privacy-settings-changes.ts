import type { PrivacyResourceAudience, UpdatePrivacySettingsInput } from '@boardsesh/graphql/operations/privacy';
import type { ConfirmOptions } from '../../providers/dialog-provider';

/**
 * What a privacy change asks before it lands, and what it sends when it does.
 *
 * Pure functions of the current and next values, so the confirm rules and the
 * account-switch payload are table-tested without a renderer, and the Privacy
 * page and the inline `AudiencePicker` cannot drift apart on when to ask.
 */

/** A `t` bound to any namespace: every key below names its own (`settings:`). */
export type PrivacyTranslate = (key: string, options?: Record<string, unknown>) => string;

/** The dialog copy for a confirm: `useConfirm()` options without the styling flags. */
export type PrivacyConfirmCopy = Pick<ConfirmOptions, 'title' | 'message' | 'confirmLabel' | 'cancelLabel'>;

/**
 * Whether widening an audience to `next` needs a confirm first, and what it
 * says. `null` means apply straight away.
 *
 * Asks only when `confirmPublic` is set (a private account) and `next` reaches
 * people outside the approved followers: Public, or anyone with the link.
 * Re-picking the value already selected asks only with `reconfirmPublic` (a
 * stale consent the caller wants renewed). `resource` swaps the public message
 * for the session/board wording.
 */
export function audienceConfirmation({
  next,
  current,
  confirmPublic,
  reconfirmPublic = false,
  resource = false,
  t,
}: {
  next: PrivacyResourceAudience;
  current: PrivacyResourceAudience;
  confirmPublic: boolean;
  reconfirmPublic?: boolean;
  resource?: boolean;
  t: PrivacyTranslate;
}): PrivacyConfirmCopy | null {
  if (!confirmPublic) return null;
  if (next !== 'public' && next !== 'unlisted') return null;
  if (next === current && !reconfirmPublic) return null;
  if (next === 'unlisted') {
    return {
      title: t('settings:privacy.publishLinkTitle'),
      message: t('settings:privacy.publishLinkMessage'),
      confirmLabel: t('settings:privacy.publishLink'),
      cancelLabel: t('settings:privacy.cancel'),
    };
  }
  return {
    title: t('settings:privacy.publishPublicTitle'),
    message: resource ? t('settings:privacy.publishResourceMessage') : t('settings:privacy.publishPublicMessage'),
    confirmLabel: t('settings:privacy.publishPublic'),
    cancelLabel: t('settings:privacy.cancel'),
  };
}

/**
 * The confirm for the Privacy page's "New session audience" select: a private
 * account widening its default to Public (or link) is asked first, exactly as
 * the inline picker on a session asks.
 */
export function sessionAudienceConfirmation(
  next: PrivacyResourceAudience,
  current: PrivacyResourceAudience,
  isPrivate: boolean,
  t: PrivacyTranslate,
): PrivacyConfirmCopy | null {
  return audienceConfirmation({ next, current, confirmPublic: isPrivate, resource: true, t });
}

/**
 * Whether the "Private account" switch also opens new sessions to everyone:
 * going public turns the followers default that going private set back into
 * Public. The confirm says so, and the write only does it when it was said.
 */
export function accountSwitchReopensSessions(
  nextIsPrivate: boolean,
  currentSessionAudience: PrivacyResourceAudience,
): boolean {
  return !nextIsPrivate && currentSessionAudience === 'followers';
}

/**
 * The confirm for the "Private account" switch. Going private narrows who sees
 * your activity, so it applies at once; going public opens past activity to
 * everyone, so it is asked first, and names the session default it opens too.
 */
export function accountSwitchConfirmation(
  nextIsPrivate: boolean,
  currentSessionAudience: PrivacyResourceAudience,
  t: PrivacyTranslate,
): PrivacyConfirmCopy | null {
  if (nextIsPrivate) return null;
  const message = t('settings:privacy.makeAccountPublicMessage');
  return {
    title: t('settings:privacy.makeAccountPublicTitle'),
    message: accountSwitchReopensSessions(nextIsPrivate, currentSessionAudience)
      ? `${message} ${t('settings:privacy.makeAccountPublicSessionsNote')}`
      : message,
    confirmLabel: t('settings:privacy.publishPublic'),
    cancelLabel: t('settings:privacy.cancel'),
  };
}

/**
 * The one `updatePrivacySettings` write the "Private account" switch sends,
 * computed from the server's settings as freshly read as possible. The server
 * writes both fields in one transaction.
 *
 * The session default moves with the account so the two never contradict each
 * other, and only ever in the direction of the switch:
 *  - Going private, a default anyone can reach (Public, or anyone with the
 *    link) narrows to approved followers. Followers, invited people and only-me
 *    are already narrower, so they stay. Widening `invite_only` to `followers`
 *    here would open new sessions to people the climber never invited.
 *  - Going public, the followers default that going private set opens back up
 *    to Public, but only when `reopenSessions` says the climber was told (the
 *    confirm they accepted carried the note). Invited people and only-me were a
 *    deliberate narrower choice, so they stay.
 *
 * A default that would not change is left out, so the write never re-sends a
 * value it did not mean to set (the server rejects some stored defaults, such
 * as "anyone with the link", as input).
 */
export function accountSwitchPayload(
  nextIsPrivate: boolean,
  currentSessionAudience: PrivacyResourceAudience,
  { reopenSessions = true }: { reopenSessions?: boolean } = {},
): UpdatePrivacySettingsInput {
  let nextSessionAudience = currentSessionAudience;
  if (nextIsPrivate) {
    if (currentSessionAudience === 'public' || currentSessionAudience === 'unlisted') nextSessionAudience = 'followers';
  } else if (reopenSessions && accountSwitchReopensSessions(nextIsPrivate, currentSessionAudience)) {
    nextSessionAudience = 'public';
  }
  return nextSessionAudience === currentSessionAudience
    ? { isPrivate: nextIsPrivate }
    : { isPrivate: nextIsPrivate, defaultSessionAudience: nextSessionAudience };
}

import type { PartnerOAuthMode } from '@boardsesh/auth-protocol/partner-oauth-mode';
import {
  SIGN_IN_ERROR_PARAMETER,
  SIGNED_IN_PARAMETER,
  isPartnerRequestExpired,
  partnerAuthorizeUrl,
  partnerSignInPath,
  readPartnerOAuthRequest,
} from './authorization-query';

/** The www session as the pages see it (see sign-in-session.server.ts). */
export type PartnerPageSessionSummary = {
  account: string | null;
  recentGuardedSignIn: boolean;
  signedInAtMs: number | null;
};

/** How long after a sign-in the sign-in page assumes the climber has only just signed in. */
export const JUST_SIGNED_IN_WINDOW_MS = 3 * 60 * 1000;

/**
 * Why the sign-in form is showing.
 * - `signed-out`: no www session.
 * - `stale`: a session the backend would not take for consent: older than 30
 *   days, from before the web marked sign-ins `link_guarded` (every session on
 *   the day partner OAuth is switched on), or from before a password change.
 * - `just-signed-in`: a guarded sign-in from the last few minutes that the
 *   backend still refused. The likely cause is a password change in the minute
 *   before it: a sign-in counts only from 60 s after the last password write.
 */
export type PartnerSignInReason = 'signed-out' | 'stale' | 'just-signed-in';

export type PartnerSignInView =
  | { kind: 'unavailable' }
  | { kind: 'invalid' }
  | {
      kind: 'sign-in';
      reason: PartnerSignInReason;
      account: string | null;
      /** Where a finished sign-in returns: this page again, marked, so it forwards to authorize. */
      returnPath: string;
      /** Sign out, then come back to this page signed out. */
      signOutPath: string;
      /** A failed social sign-in's NextAuth code. */
      errorCode: string | null;
    };

export type PartnerSignInDecision = PartnerSignInView | { kind: 'forward'; url: string };

export type PartnerConsentView =
  | { kind: 'unavailable' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'sign-in-again'; signInPath: string }
  | {
      kind: 'consent';
      signedQuery: string;
      account: string | null;
      signInPath: string;
      signOutPath: string;
    };

type PageInput = {
  mode: PartnerOAuthMode;
  search: URLSearchParams;
  session: PartnerPageSessionSummary | null;
  nowMs: number;
};

export function signOutPathFor(returnPath: string): string {
  return `/auth/signout?${new URLSearchParams({ callbackUrl: returnPath }).toString()}`;
}

function signInReason(session: PartnerPageSessionSummary | null, nowMs: number): PartnerSignInReason {
  if (!session) return 'signed-out';
  const justSignedIn =
    session.recentGuardedSignIn &&
    session.signedInAtMs !== null &&
    nowMs - session.signedInAtMs < JUST_SIGNED_IN_WINDOW_MS;
  return justSignedIn ? 'just-signed-in' : 'stale';
}

/**
 * `/oauth/sign-in`. The backend sends a climber here when authorize finds no
 * www session, or one that cannot approve an app. After a sign-in this page
 * started, the climber has a session and the marker, and goes straight back to
 * authorize, which decides again. Without the marker the page never forwards
 * on its own, so a session the backend keeps refusing shows the form instead
 * of bouncing between the two hosts.
 */
export function decidePartnerSignIn({ mode, search, session, nowMs }: PageInput): PartnerSignInDecision {
  if (mode === 'off') return { kind: 'unavailable' };
  const request = readPartnerOAuthRequest(search);
  if (!request) return { kind: 'invalid' };
  if (session && search.get(SIGNED_IN_PARAMETER) === '1') {
    return { kind: 'forward', url: partnerAuthorizeUrl(request) };
  }
  const plainPath = partnerSignInPath(request);
  const errorCode = search.get(SIGN_IN_ERROR_PARAMETER);
  return {
    kind: 'sign-in',
    reason: signInReason(session, nowMs),
    account: session?.account ?? null,
    returnPath: partnerSignInPath(request, { [SIGNED_IN_PARAMETER]: '1' }),
    signOutPath: signOutPathFor(plainPath),
    errorCode: errorCode && /^[A-Za-z]{1,64}$/.test(errorCode) ? errorCode : null,
  };
}

/**
 * `/oauth/consent`. The backend sends a signed-in climber here with a signed
 * link. The page asks the backend what the link is for from the browser; this
 * only rules out the cases where that call cannot succeed.
 */
export function decidePartnerConsent({ mode, search, session, nowMs }: PageInput): PartnerConsentView {
  if (mode === 'off') return { kind: 'unavailable' };
  const request = readPartnerOAuthRequest(search);
  if (!request) return { kind: 'invalid' };
  if (isPartnerRequestExpired(request, nowMs)) return { kind: 'expired' };
  const signInPath = partnerSignInPath(request);
  if (!session) return { kind: 'sign-in-again', signInPath };
  return {
    kind: 'consent',
    signedQuery: request.signedQuery,
    account: session.account,
    signInPath,
    signOutPath: signOutPathFor(signInPath),
  };
}

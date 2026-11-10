import { z } from 'zod';
import { PARTNER_CONSENT_DETAILS_URL, PARTNER_CONSENT_URL } from './authorization-query';

/**
 * The two consent routes on api.boardsesh.com, called from the browser.
 *
 * They take the climber's www session cookie (`.boardsesh.com`, so a
 * credentialed request carries it) and refuse any `Origin` but
 * https://www.boardsesh.com, which a browser sets for us. That is why the calls
 * run here and not on the web server: a server-side call would also put every
 * climber behind the web server's one address, in one rate-limit bucket.
 *
 * `docs/integration-platform.md`, "Consent and the www session", has the
 * contract; `packages/backend/src/auth/partner/consent.ts` has the code.
 */

/**
 * The fields the screen shows. `developerName` is left out on purpose: until a
 * publisher name is stored it holds the developer's own account name, which the
 * screen must never show.
 */
const consentDetailsSchema = z.object({
  client: z.object({
    clientId: z.string(),
    name: z.string().nullable(),
    homepageUrl: z.string().nullable(),
    privacyPolicyUrl: z.string().nullable(),
    termsUrl: z.string().nullable(),
    redirectHost: z.string().nullable(),
  }),
  scopes: z.array(z.object({ scope: z.string(), includesOnlyMeTicks: z.boolean() })),
  reconnect: z.boolean(),
  reviewed: z.boolean(),
  expiresAt: z.string(),
});

export type ConsentDetails = z.infer<typeof consentDetailsSchema>;

const consentDecisionSchema = z.object({ redirect: z.literal(true), url: z.string() });

/** What went wrong, in the terms the screen explains. */
export type ConsentProblem =
  /** No session, or one too old to approve an app (decision 19). */
  | 'sign-in-again'
  /** The link was already answered, belongs to another login, or its 10 minutes ran out. */
  | 'expired'
  /** The app was switched off or removed. */
  | 'app-unavailable'
  /** At its connection cap, and its redirect could not be used to say so. */
  | 'app-full'
  /** Rate limited, paused (`hold`) or out of capacity: retrying helps. */
  | 'busy'
  /** Partner OAuth is off on the backend. */
  | 'unavailable'
  /** Anything else, a network failure included. */
  | 'failed';

export type ConsentDetailsOutcome =
  | { kind: 'ready'; details: ConsentDetails }
  | { kind: 'problem'; problem: ConsentProblem };

/** Where the app hears the answer, and what it will hear. */
export type ConsentRedirect =
  | { kind: 'connected'; url: string }
  | { kind: 'declined'; url: string }
  /** `temporarily_unavailable`: the app is at its connection cap. */
  | { kind: 'app-full'; url: string }
  /** `access_denied` after Allow: the app has no policy row, so it can gain no connections. */
  | { kind: 'app-not-ready'; url: string }
  /** Any other error on the app's redirect. */
  | { kind: 'app-error'; url: string };

export type ConsentDecisionOutcome =
  | { kind: 'redirect'; redirect: ConsentRedirect }
  | { kind: 'problem'; problem: ConsentProblem };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** `APP_UNAVAILABLE` in consent.ts. It shares `invalid_request` with a spent link, so only the text tells them apart. */
const APP_UNAVAILABLE_DESCRIPTION = 'This app cannot be connected.';

/** Schemes a redirect may never navigate to, whatever the app registered. */
const UNSAFE_SCHEMES: ReadonlySet<string> = new Set(['javascript:', 'data:', 'vbscript:', 'blob:', 'file:', 'about:']);

async function readErrorBody(response: Response): Promise<{ error?: string; description?: string }> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return {};
    const { error, error_description: description } = body as Record<string, unknown>;
    return {
      error: typeof error === 'string' ? error : undefined,
      description: typeof description === 'string' ? description : undefined,
    };
  } catch {
    return {};
  }
}

/** A refused consent request, as the screen explains it. */
export async function classifyConsentRefusal(response: Response): Promise<ConsentProblem> {
  if (response.status === 401) return 'sign-in-again';
  if (response.status === 404) return 'unavailable';
  if (response.status === 429 || response.status === 408 || response.status >= 500) return 'busy';
  const { error, description } = await readErrorBody(response);
  if (response.status === 400) {
    // Better Auth's own signature check: a changed query or one past `exp`.
    if (error === 'invalid_signature') return 'expired';
    if (error === 'invalid_request') return description === APP_UNAVAILABLE_DESCRIPTION ? 'app-unavailable' : 'expired';
  }
  if (response.status === 403) {
    // The cap refusal when the app's redirect could not carry it (fence.ts).
    if (error === 'temporarily_unavailable') return 'app-full';
    if (error === 'access_denied') return 'app-unavailable';
  }
  return 'failed';
}

function requestInit(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    // The session cookie is the only proof of who is approving.
    credentials: 'include',
    // The query carries a signed request; keep it out of any Referer.
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  };
}

/** What the screen shows for this link. Reading it spends nothing. */
export async function fetchConsentDetails(
  signedQuery: string,
  fetchImpl: FetchLike = fetch,
): Promise<ConsentDetailsOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(PARTNER_CONSENT_DETAILS_URL, requestInit({ oauth_query: signedQuery }));
  } catch {
    return { kind: 'problem', problem: 'failed' };
  }
  if (!response.ok) return { kind: 'problem', problem: await classifyConsentRefusal(response) };
  try {
    const parsed = consentDetailsSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ready', details: parsed.data } : { kind: 'problem', problem: 'failed' };
  } catch {
    return { kind: 'problem', problem: 'failed' };
  }
}

/** The app's redirect, or null when it is not somewhere a browser should go. */
export function readConsentRedirect(url: string, accepted: boolean): ConsentRedirect | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (UNSAFE_SCHEMES.has(target.protocol.toLowerCase())) return null;
  const error = target.searchParams.get('error');
  if (!accepted) return { kind: 'declined', url: target.href };
  if (error === null) return target.searchParams.has('code') ? { kind: 'connected', url: target.href } : null;
  if (error === 'temporarily_unavailable') return { kind: 'app-full', url: target.href };
  if (error === 'access_denied') return { kind: 'app-not-ready', url: target.href };
  return { kind: 'app-error', url: target.href };
}

/**
 * Answers the link, once. The backend spends it whichever way the climber
 * chose, then answers with the app's redirect: a code, `access_denied`, or the
 * cap's `temporarily_unavailable`.
 */
export async function sendConsentDecision(
  signedQuery: string,
  accept: boolean,
  fetchImpl: FetchLike = fetch,
): Promise<ConsentDecisionOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(PARTNER_CONSENT_URL, requestInit({ accept, oauth_query: signedQuery }));
  } catch {
    return { kind: 'problem', problem: 'failed' };
  }
  if (!response.ok) return { kind: 'problem', problem: await classifyConsentRefusal(response) };
  try {
    const parsed = consentDecisionSchema.safeParse(await response.json());
    const redirect = parsed.success ? readConsentRedirect(parsed.data.url, accept) : null;
    return redirect ? { kind: 'redirect', redirect } : { kind: 'problem', problem: 'failed' };
  } catch {
    return { kind: 'problem', problem: 'failed' };
  }
}

/** A link from the app's registration, shown only when it is an ordinary web address. */
export function safeAppLink(candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

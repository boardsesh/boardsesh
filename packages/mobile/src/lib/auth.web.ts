import { createTimeoutSignal } from './abort-timeout';
import {
  broadcastConfirmedSignOut,
  broadcastCredentialRotation,
  broadcastSignOutStarted,
  captureAuthCredentialGeneration,
  captureConfirmedWebAuthIdentity,
  clearTokens,
  isolateTokensForSignOut,
  isAuthCredentialGenerationCurrent,
  synchronizeWebSession,
  type WebAuthIdentity,
} from './auth-store.web';
import { withAuthCookieLock } from './auth-cookie-lock.web';
import { WEB_BASE_URL, webApiUrl } from './env';
import {
  createWebOAuthAttemptId,
  WEB_OAUTH_RETURN_ATTEMPT_PARAM,
  WEB_OAUTH_RETURN_PROVIDER_PARAM,
} from './oauth-return-marker';

export type AuthProvider = 'google' | 'apple';

type AuthFailure = { success: false; status: number | null; error: string };

export type OAuthSignInResult =
  | { success: true }
  | { success: false; cancelled: true }
  | { success: false; redirecting: true }
  | AuthFailure;
export type CredentialsSignInResult = { success: true } | AuthFailure;
export type RegistrationResult =
  | { success: true; authenticated?: true }
  | { success: true; authenticated: false; requiresVerification: true; emailSent: boolean }
  | { success: true; authenticated: false; requiresVerification: false; autoLoginUnavailable: true }
  | AuthFailure;
export type PasswordResetResult = { success: true } | AuthFailure;

type CsrfResult = { success: true; token: string } | AuthFailure;

const AUTH_COOKIE_LOCK_WAIT_TIMEOUT_MS = 15_000;

// The Expo web export's mount path: Expo CLI inlines EXPO_BASE_URL from
// `experiments.baseUrl` (app.config.ts derives it from BOARDSESH_WEB_BASE_URL)
// — '/app' on the www-mounted export, '/' on the standalone subdomain export.
// Deriving the callback from it keeps NextAuth's stored callback URL pointing
// at a route that actually exists on whichever export is running, instead of a
// hardcoded '/app' that is a 404 on app.boardsesh.com.
function appCallbackUrl(): string {
  const exportBasePath = process.env.EXPO_BASE_URL || '/';
  if (typeof window === 'undefined') return exportBasePath;
  return new URL(exportBasePath, window.location.origin).toString();
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const responseBody: unknown = await response.json();
  if (typeof responseBody !== 'object' || responseBody === null || Array.isArray(responseBody)) {
    throw new Error('Authentication endpoint returned an invalid response');
  }
  return responseBody as Record<string, unknown>;
}

function responseError(responseBody: Record<string, unknown>, fallback: string): string {
  return typeof responseBody.error === 'string' && responseBody.error ? responseBody.error : fallback;
}

type JsonFetchOutcome =
  | { ok: true; response: Response; body: Record<string, unknown> }
  | { ok: false; responseReceived: boolean; failure: AuthFailure };

/**
 * The fetch → JSON-object ladder shared by the auth endpoints that return an
 * `AuthFailure` on transport/parse errors: a rejected fetch is `network`
 * (`responseReceived: false`), a response that isn't a JSON object is
 * `invalid_response` (`responseReceived: true`). `onResponse` runs after the
 * response headers arrive but before the body is parsed — the credentials
 * callback uses it to fence the previous cookie owner the moment Set-Cookie
 * lands, even if the body is later truncated.
 */
async function fetchJsonObject(
  input: string,
  init: RequestInit,
  onResponse?: (response: Response) => Promise<void>,
): Promise<JsonFetchOutcome> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    return { ok: false, responseReceived: false, failure: { success: false, status: null, error: 'network' } };
  }

  if (onResponse) await onResponse(response);

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(response);
  } catch {
    return {
      ok: false,
      responseReceived: true,
      failure: { success: false, status: response.status, error: 'invalid_response' },
    };
  }

  return { ok: true, response, body };
}

async function getCsrfToken(): Promise<CsrfResult> {
  const outcome = await fetchJsonObject(webApiUrl('/api/auth/csrf'), {
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: createTimeoutSignal(15_000),
  });
  if (!outcome.ok) return outcome.failure;

  const { response, body } = outcome;
  if (!response.ok || typeof body.csrfToken !== 'string' || !body.csrfToken) {
    return {
      success: false,
      status: response.status,
      error: responseError(body, `HTTP ${response.status}`),
    };
  }

  return { success: true, token: body.csrfToken };
}

function callbackFailure(callbackUrl: unknown, responseStatus: number): AuthFailure | null {
  if (typeof callbackUrl !== 'string') {
    return { success: false, status: responseStatus, error: 'invalid_response' };
  }

  const parsingBaseUrl = typeof window === 'undefined' ? 'http://localhost/app' : window.location.origin;
  let parsedCallbackUrl: URL;
  try {
    parsedCallbackUrl = new URL(callbackUrl, parsingBaseUrl);
  } catch {
    return { success: false, status: responseStatus, error: 'invalid_response' };
  }
  const errorCode = parsedCallbackUrl.searchParams.get('error');
  if (!errorCode) return null;
  if (errorCode === 'EmailNotVerified') {
    return { success: false, status: 403, error: 'email_not_verified' };
  }
  return { success: false, status: responseStatus === 200 ? 401 : responseStatus, error: 'invalid_credentials' };
}

type CredentialsCallbackAttempt = {
  result: CredentialsSignInResult;
  responseReceived: boolean;
};

async function replaceCredentialsCookie(email: string, password: string): Promise<CredentialsCallbackAttempt> {
  const csrf = await getCsrfToken();
  if (!csrf.success) return { result: csrf, responseReceived: false };

  const outcome = await fetchJsonObject(
    webApiUrl('/api/auth/callback/credentials'),
    {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Auth-Return-Redirect': '1',
      },
      body: new URLSearchParams({
        csrfToken: csrf.token,
        email,
        password,
        callbackUrl: appCallbackUrl(),
        json: 'true',
      }).toString(),
      signal: createTimeoutSignal(15_000),
    },
    // Fence the previous cookie owner the moment Set-Cookie lands so a truncated
    // or malformed body cannot leave its JWE usable under another login.
    () => clearTokens(),
  );
  if (!outcome.ok) return { result: outcome.failure, responseReceived: outcome.responseReceived };

  const { response, body: responseBody } = outcome;
  const failure = callbackFailure(responseBody.url, response.status);
  if (failure) return { result: failure, responseReceived: true };
  if (!response.ok) {
    return {
      result: {
        success: false,
        status: response.status,
        error: responseError(responseBody, `HTTP ${response.status}`),
      },
      responseReceived: true,
    };
  }

  return { result: { success: true }, responseReceived: true };
}

export async function signInWithCredentials(email: string, password: string): Promise<CredentialsSignInResult> {
  const previousIdentity = captureConfirmedWebAuthIdentity();
  let callbackAttempt: CredentialsCallbackAttempt;
  try {
    callbackAttempt = await withAuthCookieLock(
      () => replaceCredentialsCookie(email, password),
      createTimeoutSignal(AUTH_COOKIE_LOCK_WAIT_TIMEOUT_MS),
    );
  } catch {
    return { success: false, status: null, error: 'network' };
  }
  if (!callbackAttempt.responseReceived) return callbackAttempt.result;

  const session = await synchronizeWebSession();
  if (session.status === 'authenticated') {
    if (callbackAttempt.result.success) return { success: true };
    const identityChanged =
      previousIdentity === null ||
      previousIdentity.userId !== session.userId ||
      previousIdentity.authSessionId !== session.authSessionId;
    return identityChanged ? { success: true } : callbackAttempt.result;
  }
  if (!callbackAttempt.result.success) return callbackAttempt.result;
  if (session.status === 'anonymous') {
    return { success: false, status: 401, error: 'invalid_credentials' };
  }
  return { success: false, status: null, error: 'network' };
}

export async function registerWithCredentials(
  email: string,
  password: string,
  name?: string,
): Promise<RegistrationResult> {
  const outcome = await fetchJsonObject(webApiUrl('/api/auth/register'), {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, ...(name ? { name } : {}) }),
    signal: createTimeoutSignal(15_000),
  });
  if (!outcome.ok) return outcome.failure;

  const { response, body: responseBody } = outcome;
  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      error: responseError(responseBody, `HTTP ${response.status}`),
    };
  }
  if (responseBody.requiresVerification === true) {
    return {
      success: true,
      authenticated: false,
      requiresVerification: true,
      emailSent: responseBody.emailSent === true,
    };
  }

  try {
    const signInResult = await signInWithCredentials(email, password);
    if (signInResult.success) return { success: true };
  } catch {
    // Account creation has already committed. Normalize an unexpected callback
    // parsing/runtime failure to the same sign-in-next outcome as transport
    // failures instead of misreporting the registration itself as failed.
  }

  // The account already exists at this point. A CSRF/network/session-bridge
  // failure affects only automatic login and must not invite the user to retry
  // registration (which would now report that the email is taken).
  return {
    success: true,
    authenticated: false,
    requiresVerification: false,
    autoLoginUnavailable: true,
  };
}

async function postPasswordEndpoint(path: string, body: Record<string, string>): Promise<PasswordResetResult> {
  let response: Response;
  try {
    response = await fetch(webApiUrl(path), {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    return { success: false, status: null, error: 'network' };
  }

  if (response.ok) return { success: true };

  try {
    const responseBody = await readJsonObject(response);
    return {
      success: false,
      status: response.status,
      error: responseError(responseBody, `HTTP ${response.status}`),
    };
  } catch {
    return { success: false, status: response.status, error: `HTTP ${response.status}` };
  }
}

export function requestPasswordReset(email: string): Promise<PasswordResetResult> {
  return postPasswordEndpoint('/api/auth/forgot-password', { email });
}

export function resetPassword(
  email: string,
  token: string,
  newPassword: string,
  confirmPassword: string,
): Promise<PasswordResetResult> {
  return postPasswordEndpoint('/api/auth/reset-password', {
    email,
    token,
    password: newPassword,
    confirmPassword,
  });
}

type CookieOwnership = 'owned' | 'anonymous' | 'changed';

async function resolveCookieOwnership(departingIdentity: WebAuthIdentity | null): Promise<CookieOwnership> {
  let response: Response;
  try {
    response = await fetch(webApiUrl('/api/auth/session'), {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: createTimeoutSignal(15_000),
    });
  } catch (error) {
    throw new Error('Could not verify the browser session to sign out', { cause: error });
  }
  if (!response.ok) throw new Error(`Could not verify the browser session to sign out: HTTP ${response.status}`);

  let responseBody: Record<string, unknown>;
  try {
    responseBody = await readJsonObject(response);
  } catch (error) {
    throw new Error('Could not verify the browser session to sign out', { cause: error });
  }
  if (responseBody.user === undefined || responseBody.user === null) return 'anonymous';
  if (
    typeof responseBody.user !== 'object' ||
    Array.isArray(responseBody.user) ||
    typeof responseBody.authSessionId !== 'string' ||
    !responseBody.authSessionId
  ) {
    throw new Error('Could not verify the browser session to sign out');
  }
  const sessionUser = responseBody.user as Record<string, unknown>;
  if (typeof sessionUser.id !== 'string' || !sessionUser.id) {
    throw new Error('Could not verify the browser session to sign out');
  }
  if (departingIdentity === null) return 'changed';
  return sessionUser.id === departingIdentity.userId && responseBody.authSessionId === departingIdentity.authSessionId
    ? 'owned'
    : 'changed';
}

async function revokeOwnedNextAuthCookie(
  isolatedGeneration: number,
  departingIdentity: WebAuthIdentity | null,
): Promise<'performed' | 'changed' | 'superseded'> {
  return withAuthCookieLock(async () => {
    if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return 'superseded';
    const ownership = await resolveCookieOwnership(departingIdentity);
    if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return 'superseded';
    if (ownership === 'changed') return 'changed';
    // A peer may already have deleted the shared cookie. That is still a
    // durable signed-out state owned by this generation, so callers must run
    // provider/cache cleanup even though no second sign-out POST is needed.
    if (ownership === 'anonymous') return 'performed';
    if (departingIdentity === null) return 'changed';

    // Peers immediately fence requests made with their in-memory JWE. Their
    // provider revalidation queues behind this operation; this lock owner does
    // not receive its own BroadcastChannel message and remains current.
    broadcastSignOutStarted(departingIdentity);

    const csrf = await getCsrfToken();
    if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return 'superseded';
    if (!csrf.success) throw new Error(`Could not start sign-out: ${csrf.error}`);

    let response: Response;
    try {
      response = await fetch(webApiUrl('/api/auth/signout'), {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Auth-Return-Redirect': '1',
        },
        body: new URLSearchParams({
          csrfToken: csrf.token,
          callbackUrl: appCallbackUrl(),
          json: 'true',
          ...(departingIdentity
            ? {
                expectedUserId: departingIdentity.userId,
                expectedAuthSessionId: departingIdentity.authSessionId,
              }
            : {}),
        }).toString(),
        signal: createTimeoutSignal(15_000),
      });
    } catch (error) {
      throw new Error('Could not reach Boardsesh to sign out', { cause: error });
    }
    if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return 'superseded';
    if (response.status === 409) {
      let conflictBody: Record<string, unknown>;
      try {
        conflictBody = await readJsonObject(response);
      } catch {
        throw new Error('Could not sign out: HTTP 409');
      }
      if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return 'superseded';
      if (conflictBody.error === 'signout_identity_changed') return 'changed';
      throw new Error('Could not sign out: HTTP 409');
    }
    if (!response.ok) throw new Error(`Could not sign out: HTTP ${response.status}`);

    let responseBody: Record<string, unknown>;
    try {
      responseBody = await readJsonObject(response);
    } catch (error) {
      throw new Error('Could not confirm sign-out', { cause: error });
    }
    if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return 'superseded';
    if (typeof responseBody.url !== 'string') throw new Error('Could not confirm sign-out');

    const parsingBaseUrl = typeof window === 'undefined' ? 'http://localhost/app' : window.location.origin;
    const returnedUrl = new URL(responseBody.url, parsingBaseUrl);
    const expectedUrl = new URL(appCallbackUrl(), parsingBaseUrl);
    if (returnedUrl.origin !== expectedUrl.origin || returnedUrl.pathname !== expectedUrl.pathname) {
      throw new Error('Could not confirm sign-out');
    }
    return 'performed';
  }, createTimeoutSignal(AUTH_COOKIE_LOCK_WAIT_TIMEOUT_MS));
}

export async function signOutForGeneration(signOutGeneration: number): Promise<boolean> {
  if (!isAuthCredentialGenerationCurrent(signOutGeneration)) return false;
  const departingIdentity = captureConfirmedWebAuthIdentity();

  // Stop exposing the backend JWE before either network phase. The HttpOnly
  // cookie can take longer to revoke (or be unreachable), but this browser
  // process must stop issuing authenticated requests as soon as sign-out owns
  // the current credential generation.
  const isolatedGeneration = signOutGeneration + 1;
  await isolateTokensForSignOut();
  if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return false;

  try {
    const durableSignOut = await revokeOwnedNextAuthCookie(isolatedGeneration, departingIdentity);
    if (durableSignOut === 'superseded') return false;
    if (durableSignOut === 'changed') {
      // Re-read after releasing the cookie lock. A changed owner belongs to a
      // newer login and does not permit this stale caller to post NextAuth
      // sign-out or clean the replacement owner's provider state.
      broadcastCredentialRotation();
      await synchronizeWebSession();
      return false;
    }
  } catch (error) {
    if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return false;
    // A same-login peer may have fenced its JWE on `signout-started`. This
    // non-authoritative hint restores the old session when durable revocation
    // failed, or confirms anonymous state if deletion headers already arrived.
    broadcastCredentialRotation();
    throw error;
  }

  if (!isAuthCredentialGenerationCurrent(isolatedGeneration)) return false;

  // Only a validated successful response proves the shared HttpOnly cookie is
  // gone. Peer tabs treat this as an authoritative logout instead of a login
  // rotation hint, so they can hide private state even if revalidation is down.
  broadcastConfirmedSignOut(departingIdentity);
  return true;
}

export async function signOut(): Promise<void> {
  await signOutForGeneration(captureAuthCredentialGeneration());
}

export function isGoogleSignInConfigured(): boolean {
  return false;
}

/**
 * Build the NextAuth start URL for the Expo browser app. OAuth itself always
 * runs on WEB_BASE_URL (www in production), while the callback returns to the
 * exact auth route that initiated it: `/app/auth/...` for the same-origin build
 * and `/auth/...` for app.boardsesh.com.
 */
export function buildWebOAuthStartUrl(
  provider: AuthProvider,
  appOrigin: string,
  attemptId: string,
  isRegistration = false,
  exportBasePath = process.env.EXPO_BASE_URL || '/',
): string {
  const normalizedBasePath = exportBasePath === '/' ? '' : exportBasePath.replace(/\/$/, '');
  const callbackUrl = new URL(`${normalizedBasePath}/auth/${isRegistration ? 'register' : 'login'}`, appOrigin);
  callbackUrl.searchParams.set(WEB_OAUTH_RETURN_PROVIDER_PARAM, provider);
  callbackUrl.searchParams.set(WEB_OAUTH_RETURN_ATTEMPT_PARAM, attemptId);
  const startUrl = new URL('/auth/native-start', WEB_BASE_URL);
  startUrl.searchParams.set('provider', provider);
  startUrl.searchParams.set('callbackUrl', callbackUrl.toString());
  return startUrl.toString();
}

function startWebOAuth(provider: AuthProvider, attemptId?: string, isRegistration = false): Promise<OAuthSignInResult> {
  if (typeof window === 'undefined') {
    return Promise.resolve({ success: false, status: null, error: 'browser_unavailable' });
  }

  try {
    const resolvedAttemptId = attemptId ?? createWebOAuthAttemptId();
    window.location.assign(buildWebOAuthStartUrl(provider, window.location.origin, resolvedAttemptId, isRegistration));
    // The document is about to unload. This distinct result prevents the
    // in-process native flow from reporting success or checking the old cookie
    // before the provider round-trip returns.
    return Promise.resolve({ success: false, redirecting: true });
  } catch {
    return Promise.resolve({ success: false, status: null, error: 'browser_unavailable' });
  }
}

export function signInWithApple(webAttemptId?: string, isRegistration = false): Promise<OAuthSignInResult> {
  return startWebOAuth('apple', webAttemptId, isRegistration);
}

export function signInWithGoogle(webAttemptId?: string, isRegistration = false): Promise<OAuthSignInResult> {
  return startWebOAuth('google', webAttemptId, isRegistration);
}

export function signInWithGoogleWeb(isRegistration = false): Promise<OAuthSignInResult> {
  return startWebOAuth('google', undefined, isRegistration);
}

export function signInWithAppleWeb(isRegistration = false): Promise<OAuthSignInResult> {
  return startWebOAuth('apple', undefined, isRegistration);
}

import { createTimeoutSignal } from './abort-timeout';
import {
  captureAuthCredentialGeneration,
  clearTokens,
  isAuthCredentialGenerationCurrent,
  synchronizeWebSession,
} from './auth-store.web';

export type AuthProvider = 'google' | 'apple';

type AuthFailure = { success: false; status: number | null; error: string };

export type OAuthSignInResult = { success: true } | { success: false; cancelled: true } | AuthFailure;
export type CredentialsSignInResult = { success: true } | AuthFailure;
export type RegistrationResult =
  | { success: true; authenticated?: true }
  | { success: true; authenticated: false; requiresVerification: true; emailSent: boolean }
  | { success: true; authenticated: false; requiresVerification: false; autoLoginUnavailable: true }
  | AuthFailure;
export type PasswordResetResult = { success: true } | AuthFailure;

type CsrfResult = { success: true; token: string } | AuthFailure;

function appCallbackUrl(): string {
  if (typeof window === 'undefined') return '/app';
  return new URL('/app', window.location.origin).toString();
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

async function getCsrfToken(): Promise<CsrfResult> {
  let response: Response;
  try {
    response = await fetch('/api/auth/csrf', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    return { success: false, status: null, error: 'network' };
  }

  let responseBody: Record<string, unknown>;
  try {
    responseBody = await readJsonObject(response);
  } catch {
    return { success: false, status: response.status, error: 'invalid_response' };
  }

  if (!response.ok || typeof responseBody.csrfToken !== 'string' || !responseBody.csrfToken) {
    return {
      success: false,
      status: response.status,
      error: responseError(responseBody, `HTTP ${response.status}`),
    };
  }

  return { success: true, token: responseBody.csrfToken };
}

function callbackFailure(callbackUrl: unknown, responseStatus: number): AuthFailure | null {
  if (typeof callbackUrl !== 'string') {
    return { success: false, status: responseStatus, error: 'invalid_response' };
  }

  const parsingBaseUrl = typeof window === 'undefined' ? 'http://localhost/app' : window.location.origin;
  const parsedCallbackUrl = new URL(callbackUrl, parsingBaseUrl);
  const errorCode = parsedCallbackUrl.searchParams.get('error');
  if (!errorCode) return null;
  if (errorCode === 'EmailNotVerified') {
    return { success: false, status: 403, error: 'email_not_verified' };
  }
  return { success: false, status: responseStatus === 200 ? 401 : responseStatus, error: 'invalid_credentials' };
}

export async function signInWithCredentials(email: string, password: string): Promise<CredentialsSignInResult> {
  const csrf = await getCsrfToken();
  if (!csrf.success) return csrf;

  let response: Response;
  try {
    response = await fetch('/api/auth/callback/credentials', {
      method: 'POST',
      credentials: 'same-origin',
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
    });
  } catch {
    return { success: false, status: null, error: 'network' };
  }

  let responseBody: Record<string, unknown>;
  try {
    responseBody = await readJsonObject(response);
  } catch {
    return { success: false, status: response.status, error: 'invalid_response' };
  }

  const failure = callbackFailure(responseBody.url, response.status);
  if (failure) return failure;
  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      error: responseError(responseBody, `HTTP ${response.status}`),
    };
  }

  // The callback replaced the browser's credential owner. Rotate the
  // process-memory generation before resolving its bridge token so stale
  // requests cannot join this login's synchronization or reuse its JWE.
  await clearTokens();
  const session = await synchronizeWebSession();
  if (session.status === 'authenticated') return { success: true };
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
  let response: Response;
  try {
    response = await fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, ...(name ? { name } : {}) }),
      signal: createTimeoutSignal(15_000),
    });
  } catch {
    return { success: false, status: null, error: 'network' };
  }

  let responseBody: Record<string, unknown>;
  try {
    responseBody = await readJsonObject(response);
  } catch {
    return { success: false, status: response.status, error: 'invalid_response' };
  }

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
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
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

export async function signOutForGeneration(signOutGeneration: number): Promise<boolean> {
  let durableSignOutError: unknown;
  let durableSignOutFailed = false;

  try {
    const csrf = await getCsrfToken();
    if (!isAuthCredentialGenerationCurrent(signOutGeneration)) return false;
    if (!csrf.success) {
      throw new Error(`Could not start sign-out: ${csrf.error}`);
    }

    let response: Response;
    try {
      response = await fetch('/api/auth/signout', {
        method: 'POST',
        credentials: 'same-origin',
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
        }).toString(),
        signal: createTimeoutSignal(15_000),
      });
    } catch (error) {
      throw new Error('Could not reach Boardsesh to sign out', { cause: error });
    }
    if (!isAuthCredentialGenerationCurrent(signOutGeneration)) return false;

    if (!response.ok) throw new Error(`Could not sign out: HTTP ${response.status}`);

    let responseBody: Record<string, unknown>;
    try {
      responseBody = await readJsonObject(response);
    } catch (error) {
      throw new Error('Could not confirm sign-out', { cause: error });
    }
    if (!isAuthCredentialGenerationCurrent(signOutGeneration)) return false;
    if (typeof responseBody.url !== 'string') throw new Error('Could not confirm sign-out');

    const parsingBaseUrl = typeof window === 'undefined' ? 'http://localhost/app' : window.location.origin;
    const returnedUrl = new URL(responseBody.url, parsingBaseUrl);
    const expectedUrl = new URL(appCallbackUrl(), parsingBaseUrl);
    if (returnedUrl.origin !== expectedUrl.origin || returnedUrl.pathname !== expectedUrl.pathname) {
      throw new Error('Could not confirm sign-out');
    }
  } catch (error) {
    durableSignOutFailed = true;
    durableSignOutError = error;
  }

  if (!isAuthCredentialGenerationCurrent(signOutGeneration)) return false;

  // The HttpOnly cookie may survive a network/CSRF failure, which the caller
  // must surface, but the browser process must never keep using its exposed
  // backend JWE after the user requested logout.
  await clearTokens();
  if (durableSignOutFailed) throw durableSignOutError;
  return true;
}

export async function signOut(): Promise<void> {
  await signOutForGeneration(captureAuthCredentialGeneration());
}

export function isGoogleSignInConfigured(): boolean {
  return false;
}

function unavailableOAuth(): Promise<OAuthSignInResult> {
  return Promise.resolve({ success: false, status: null, error: 'oauth_unavailable' });
}

export function signInWithApple(): Promise<OAuthSignInResult> {
  return unavailableOAuth();
}

export function signInWithGoogle(): Promise<OAuthSignInResult> {
  return unavailableOAuth();
}

export function signInWithGoogleWeb(): Promise<OAuthSignInResult> {
  return unavailableOAuth();
}

export function signInWithAppleWeb(): Promise<OAuthSignInResult> {
  return unavailableOAuth();
}

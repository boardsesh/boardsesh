import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { isAllowedAppOrigin } from './app-origin-allowlist';

const RETURN_PROVIDER_PARAM = 'boardseshOAuthProvider';
const RETURN_ATTEMPT_PARAM = 'boardseshOAuthAttempt';
const RETURN_ERROR_PARAM = 'boardseshOAuthError';
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RETURN_MAX_AGE_MS = 10 * 60 * 1000;
const COOKIE_PREFIX = 'boardsesh.oauth-return.';
const KNOWN_ERROR_CODES = new Set([
  'AccessDenied',
  'Callback',
  'Configuration',
  'OAuthAccountNotLinked',
  'OAuthCallback',
  'OAuthCreateAccount',
  'OAuthEmailRequired',
  'OAuthSignin',
  'SessionRequired',
  'Signin',
]);

export type ExpoWebOAuthProvider = 'apple' | 'google';

type ReturnDescriptor = {
  provider: ExpoWebOAuthProvider;
  returnUrl: string;
  createdAt: number;
};

function signingSecret(): string | null {
  return process.env.NEXTAUTH_SECRET?.trim() || null;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

function returnCookieName(state: string): string {
  const stateHash = createHash('sha256').update(state).digest('hex').slice(0, 32);
  return `${COOKIE_PREFIX}${stateHash}`;
}

function encodeDescriptor(descriptor: ReturnDescriptor): string {
  const secret = signingSecret();
  if (!secret) throw new Error('NEXTAUTH_SECRET is required to bind Expo web OAuth returns');
  const payload = Buffer.from(JSON.stringify(descriptor)).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

function decodeDescriptor(encoded: string): ReturnDescriptor | null {
  const secret = signingSecret();
  if (!secret) return null;
  const separatorIndex = encoded.lastIndexOf('.');
  if (separatorIndex <= 0) return null;
  const payload = encoded.slice(0, separatorIndex);
  const suppliedSignature = Buffer.from(encoded.slice(separatorIndex + 1), 'base64url');
  const expectedSignature = signature(payload, secret);
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    return null;
  }

  try {
    const candidate = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
    const descriptor = candidate as Record<string, unknown>;
    if (
      (descriptor.provider !== 'apple' && descriptor.provider !== 'google') ||
      typeof descriptor.returnUrl !== 'string' ||
      typeof descriptor.createdAt !== 'number' ||
      !Number.isFinite(descriptor.createdAt)
    ) {
      return null;
    }
    const age = Date.now() - descriptor.createdAt;
    if (age < 0 || age > RETURN_MAX_AGE_MS) return null;
    return descriptor as ReturnDescriptor;
  } catch {
    return null;
  }
}

export function validatedExpoReturnUrl(
  candidate: FormDataEntryValue | string | null,
  provider: ExpoWebOAuthProvider,
  authOrigin: string,
): string | null {
  if (typeof candidate !== 'string') return null;
  let returnUrl: URL;
  try {
    returnUrl = new URL(candidate);
  } catch {
    return null;
  }

  const isSameOriginExport = returnUrl.origin === authOrigin;
  if (!isSameOriginExport && !isAllowedAppOrigin(returnUrl.origin)) return null;
  if (
    (isSameOriginExport && !/^\/app\/auth\/(?:login|register)$/.test(returnUrl.pathname)) ||
    (!isSameOriginExport && !/^\/auth\/(?:login|register)$/.test(returnUrl.pathname))
  ) {
    return null;
  }
  if (returnUrl.username || returnUrl.password || returnUrl.hash) return null;
  if (returnUrl.searchParams.get(RETURN_PROVIDER_PARAM) !== provider) return null;
  const attemptId = returnUrl.searchParams.get(RETURN_ATTEMPT_PARAM);
  if (!attemptId || !ATTEMPT_ID_PATTERN.test(attemptId)) return null;
  if (returnUrl.searchParams.has(RETURN_ERROR_PARAM)) return null;
  const allowedParams = new Set([RETURN_PROVIDER_PARAM, RETURN_ATTEMPT_PARAM]);
  for (const key of returnUrl.searchParams.keys()) {
    if (!allowedParams.has(key)) return null;
  }
  return returnUrl.toString();
}

function cookieAttributes(request: NextRequest, maxAge: number): string {
  const secure = request.nextUrl.protocol === 'https:';
  return [
    'Path=/',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    secure ? 'Secure' : null,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join('; ');
}

export function bindExpoReturnToState(
  response: Response,
  request: NextRequest,
  state: string,
  provider: ExpoWebOAuthProvider,
  returnUrl: string,
): Response {
  const encoded = encodeDescriptor({ provider, returnUrl, createdAt: Date.now() });
  response.headers.append(
    'Set-Cookie',
    `${returnCookieName(state)}=${encoded}; ${cookieAttributes(request, Math.floor(RETURN_MAX_AGE_MS / 1000))}`,
  );
  return response;
}

export function readExpoReturnForState(
  request: NextRequest,
  state: string,
  provider: ExpoWebOAuthProvider,
): ReturnDescriptor | null {
  const encoded = request.cookies.get(returnCookieName(state))?.value;
  if (!encoded) return null;
  const descriptor = decodeDescriptor(encoded);
  if (!descriptor || descriptor.provider !== provider) return null;
  return validatedExpoReturnUrl(descriptor.returnUrl, provider, request.nextUrl.origin) ? descriptor : null;
}

function responseErrorCode(response: Response): string | null {
  const location = response.headers.get('Location');
  if (!location) return response.status >= 300 && response.status < 400 ? null : 'OAuthCallback';
  try {
    const candidate = new URL(location, 'https://auth.invalid');
    const error = candidate.searchParams.get('error');
    return error && KNOWN_ERROR_CODES.has(error) ? error : error ? 'OAuthCallback' : null;
  } catch {
    return null;
  }
}

export function redirectExpoOAuthResponse(
  response: Response,
  request: NextRequest,
  state: string | null,
  returnUrl: string,
): Response {
  const destination = new URL(returnUrl);
  const errorCode = responseErrorCode(response);
  if (errorCode) destination.searchParams.set(RETURN_ERROR_PARAM, errorCode);
  const headers = new Headers(response.headers);
  headers.set('Location', destination.toString());
  if (state) {
    headers.append('Set-Cookie', `${returnCookieName(state)}=; ${cookieAttributes(request, 0)}`);
  }
  const status = response.status >= 300 && response.status < 400 ? response.status : 302;
  return new Response(null, { status, headers });
}

const sanitizeRelativePath = (path: string): string => (path.startsWith('/') ? path : '/');

export const buildNativeOAuthSignInUrl = ({
  origin,
  provider,
  callbackPath,
}: {
  origin: string;
  provider: string;
  callbackPath: string;
}): string => {
  const nextPath = sanitizeRelativePath(callbackPath);
  const nativeCallbackUrl = `${origin}/api/auth/native/callback?next=${encodeURIComponent(nextPath)}`;
  const signInUrl = new URL(`/api/auth/signin/${provider}`, origin);
  signInUrl.searchParams.set('callbackUrl', nativeCallbackUrl);
  return signInUrl.toString();
};


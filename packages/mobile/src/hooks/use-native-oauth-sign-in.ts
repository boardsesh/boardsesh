import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useAuth } from '../providers/auth-provider';
import { track } from '../lib/analytics';
import { reportError } from '../lib/error-reporting';
import { classifyNativeAuthFailureReason, nativeSignInErrorCode } from '../lib/native-auth-analytics';
import type { OAuthSignInResult } from '../lib/auth';
import { useTranslation } from 'react-i18next';

type Provider = 'apple' | 'google';

type Options = {
  /** Tags the analytics funnel so signup OAuth is distinguishable from login OAuth. */
  isRegistration?: boolean;
  /** Where the caller surfaces a translated failure message (and `null` to clear it). */
  setError: (message: string | null) => void;
};

/**
 * The native Apple/Google sign-in flow, shared by the login and register screens
 * so the two can't drift (telemetry, error classification, Sentry tags, and the
 * double-tap guard all live here once). Apple/Google "sign up" is the same
 * find-or-create flow as sign-in, so the only difference between the two callers
 * is the `is_registration` analytics tag. `setError` is injected because login
 * shares one error region with credentials sign-in while register has its own.
 */
export function useNativeOAuthSignIn({ isRegistration = false, setError }: Options) {
  const { signInWithApple, signInWithGoogle, signInWithGoogleWeb, signInWithAppleWeb } = useAuth();
  const { t } = useTranslation('auth');
  const [inProgress, setInProgress] = useState(false);

  const signIn = useCallback(
    async (provider: Provider) => {
      // A rapid double-tap would open two concurrent native sheets.
      if (inProgress) return;
      setInProgress(true);
      setError(null);
      const registrationProps = isRegistration ? { is_registration: true } : {};
      track(SHARED_EVENTS.LoginAttempted, { auth_method: provider, flow: 'native', ...registrationProps });
      // duration_ms separates a human dismissing the system sheet (seconds) from
      // the flow dying programmatically (sub-second).
      const attemptStartedAt = Date.now();

      // Browser-OAuth fallback, iOS-only, for both Google and Apple. The native
      // SDK can fail before any network call — Google on iOS 26.5.1 (GIDSignIn
      // "Unable to open Safari"), Apple on ASAuthorizationError.unknown (code
      // 1000: device not signed into iCloud, 2FA disabled, transient Apple ID
      // issues) — and that failure isn't fatal: the web NextAuth handoff completes
      // sign-in without the native SDK. Reports its own telemetry under
      // flow: 'web_fallback' so we can measure how often it rescues a native
      // failure, and fully owns the outcome (success returns, a browser cancel
      // stays silent, a real failure reaches error tracking + the error region).
      // Not used on Android: the redirect to com.boardsesh.app://auth/callback
      // doesn't reliably return through openAuthSessionAsync there, an Android
      // native Google failure is almost always an unregistered signing-cert SHA-1
      // (a Google Cloud fix), and Apple sign-in isn't offered on Android at all —
      // so we surface the real error instead (see auth.ts).
      // Keyed by provider so the map is exhaustive: extending Provider without a
      // web fn here is a type error, rather than silently routing the new provider
      // to the Google flow.
      const webFallbackFor: Record<Provider, () => Promise<OAuthSignInResult>> = {
        apple: signInWithAppleWeb,
        google: signInWithGoogleWeb,
      };
      const runWebFallback = async (): Promise<void> => {
        const fallbackStartedAt = Date.now();
        track(SHARED_EVENTS.LoginAttempted, { auth_method: provider, flow: 'web_fallback', ...registrationProps });
        let fallback: OAuthSignInResult;
        try {
          fallback = await webFallbackFor[provider]();
        } catch (fallbackError) {
          track(SHARED_EVENTS.LoginFailed, {
            auth_method: provider,
            flow: 'web_fallback',
            failure_reason: 'exception',
            failure_detail: fallbackError instanceof Error ? fallbackError.message : undefined,
            duration_ms: Date.now() - fallbackStartedAt,
            ...registrationProps,
          });
          reportError(fallbackError, {
            tags: { source: 'native-auth', provider, flow: 'web_fallback', mechanism: 'exception' },
          });
          setError(t('nativeStart.oauthError'));
          return;
        }
        if (fallback.success) {
          track(SHARED_EVENTS.LoginSucceeded, { auth_method: provider, flow: 'web_fallback', ...registrationProps });
          setError(null);
          // AuthProvider flips isAuthenticated and the redirect handles navigation.
          return;
        }
        if ('cancelled' in fallback) {
          // The user dismissed the browser — intent, not a failure. A distinct
          // event keeps it out of the LoginFailed count.
          track(SHARED_EVENTS.LoginCancelled, {
            auth_method: provider,
            flow: 'web_fallback',
            duration_ms: Date.now() - fallbackStartedAt,
            ...registrationProps,
          });
          return;
        }
        const fallbackReason = classifyNativeAuthFailureReason(fallback, 'oauth');
        track(SHARED_EVENTS.LoginFailed, {
          auth_method: provider,
          flow: 'web_fallback',
          failure_reason: fallbackReason,
          failure_detail: fallback.error,
          duration_ms: Date.now() - fallbackStartedAt,
          ...registrationProps,
        });
        reportError(new Error(`Web-fallback ${provider} sign-in failed: ${fallback.error}`), {
          level: fallback.error === 'network' ? 'warning' : 'error',
          tags: { source: 'native-auth', provider, flow: 'web_fallback', failure_reason: fallbackReason },
          extra: { status: fallback.status, server_error: fallback.error },
        });
        setError(fallback.error === 'network' ? t('nativeStart.networkError') : t('nativeStart.oauthError'));
      };

      try {
        const result = provider === 'apple' ? await signInWithApple() : await signInWithGoogle();
        if (result.success) {
          track(SHARED_EVENTS.LoginSucceeded, { auth_method: provider, flow: 'native', ...registrationProps });
          // AuthProvider flips isAuthenticated and the redirect handles navigation.
          return;
        }
        if ('cancelled' in result) {
          // The user dismissed the provider sheet — intent, not a failure. A
          // distinct event keeps it out of the LoginFailed count.
          track(SHARED_EVENTS.LoginCancelled, {
            auth_method: provider,
            flow: 'native',
            duration_ms: Date.now() - attemptStartedAt,
            ...registrationProps,
          });
          return;
        }
        // A real backend/token failure carrying the server's status + error. On
        // iOS the browser fallback runs next, so this native failure is
        // recoverable and shouldn't count toward the terminal failure metric;
        // on Android it dead-ends and is terminal.
        const oauthFailureReason = classifyNativeAuthFailureReason(result, 'oauth');
        track(SHARED_EVENTS.LoginFailed, {
          auth_method: provider,
          flow: 'native',
          failure_reason: oauthFailureReason,
          failure_detail: result.error,
          recoverable: Platform.OS === 'ios',
          duration_ms: Date.now() - attemptStartedAt,
          ...registrationProps,
        });
        // On iOS, Google and Apple native failures are recoverable in the browser
        // — the fallback owns the user-facing outcome and error tracking from
        // here. Android has no working browser fallback and falls through to the
        // real-error path below.
        if (Platform.OS === 'ios') {
          await runWebFallback();
          return;
        }
        // Surface to error tracking too: an OAuth 401 / no_id_token is a config
        // bug (client-id audience mismatch, unconfigured backend) rather than a
        // user typo. Network blips downgrade to a warning.
        reportError(new Error(`Native ${provider} sign-in failed: ${result.error}`), {
          level: result.error === 'network' ? 'warning' : 'error',
          tags: { source: 'native-auth', provider, flow: 'native', failure_reason: oauthFailureReason },
          extra: { status: result.status, server_error: result.error },
        });
        setError(result.error === 'network' ? t('nativeStart.networkError') : t('nativeStart.oauthError'));
      } catch (oauthError) {
        // The native module threw (Play Services missing, no presenter, a
        // signing/client-id mismatch, …). Prefer the native `.code` for
        // failure_detail — far more actionable than the opaque message.
        const nativeErrorCode = nativeSignInErrorCode(oauthError);
        // On iOS the browser fallback runs next (recoverable); on Android the
        // native throw dead-ends and is terminal.
        track(SHARED_EVENTS.LoginFailed, {
          auth_method: provider,
          flow: 'native',
          failure_reason: 'exception',
          failure_detail: nativeErrorCode ?? (oauthError instanceof Error ? oauthError.message : undefined),
          recoverable: Platform.OS === 'ios',
          duration_ms: Date.now() - attemptStartedAt,
          ...registrationProps,
        });
        // Native throws land here — on iOS, recover via the browser flow instead
        // of reporting and dead-ending the user. Google's is the iOS 26.5.1
        // "Unable to open Safari" GIDSignIn throw; Apple's is
        // ASAuthorizationError.unknown (code 1000). On Android a Google throw is
        // almost always an unregistered signing-cert SHA-1 (DEVELOPER_ERROR) and
        // Apple isn't offered, so fall through and let reportError tag it with
        // native_error_code for PostHog rather than hide it behind a fallback that
        // can't complete.
        if (Platform.OS === 'ios') {
          await runWebFallback();
          return;
        }
        reportError(oauthError, {
          tags: {
            source: 'native-auth',
            provider,
            flow: 'native',
            mechanism: 'exception',
            native_error_code: nativeErrorCode,
          },
        });
        setError(t('nativeStart.oauthError'));
      } finally {
        setInProgress(false);
      }
    },
    [
      inProgress,
      isRegistration,
      setError,
      signInWithApple,
      signInWithGoogle,
      signInWithGoogleWeb,
      signInWithAppleWeb,
      t,
    ],
  );

  return { signIn, inProgress };
}

import { createHash } from 'node:crypto';
import { jwtVerify } from 'jose';
import { mobileSourceRoot, installNativeMobileHostBindings } from './native-mobile-host-io';

interface NativeResult {
  success: boolean;
  userId?: string;
  accountCreation?: { userId: string; accountCreated: boolean; provider: string; createdAt: string };
}
interface NativeAuth {
  signInWithGoogleWeb(): Promise<NativeResult>;
  signInWithAppleWeb(): Promise<NativeResult>;
}
interface NativeStore {
  getAuthToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
}
let listener: ((event: { url: string }) => void) | undefined;
const deadline = setTimeout(() => process.exit(2), 15_000);
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
function complete(report: object, code: number) {
  clearTimeout(deadline);
  if (process.send) process.send(report, () => process.exit(code));
  else process.exit(code);
}
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const input = message as Record<string, unknown>;
  if (input.type === 'callback' && typeof input.url === 'string') {
    listener?.({ url: input.url });
    return;
  }
  if (input.type !== 'initialize') return;
  let phase = 'input';
  void (async () => {
    if (
      typeof input.origin !== 'string' ||
      typeof input.issuerVerificationSecret !== 'string' ||
      (input.provider !== 'google' && input.provider !== 'apple') ||
      typeof input.expectedCreated !== 'boolean'
    )
      throw new Error('Invalid owned mobile probe');
    const origin = new URL(input.origin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      !origin.port ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('Owned loopback only');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      EXPO_OS: 'ios',
      EXPO_PUBLIC_BACKEND_URL: origin.origin,
      EXPO_PUBLIC_WEB_URL: 'https://www.native-provider.example.test',
      EXPO_PUBLIC_POSTHOG_KEY: '',
      EXPO_PUBLIC_SCREENSHOT_MODE: '1',
    });
    for (const key of [
      'NEXTAUTH_SECRET',
      'AUTH_SECRET',
      'CRON_SECRET',
      'CURRENT_STORE_AUTH_RPC_SECRET',
      'NATIVE_BROWSER_HANDOFF_SECRET',
      'BROWSER_DELEGATION_SECRET',
      'AUTH_IDENTITY_DATABASE_URL',
      'CREDENTIAL_WRITER_PROOF_DATABASE_URL',
      'AUTH_PROTOTYPE_DATABASE_URL',
      'DATABASE_URL',
      'DATABASE_URL_UNPOOLED',
    ])
      delete process.env[key];
    Object.assign(globalThis, { __DEV__: false });
    let opens = 0;
    let dismisses = 0;
    let settleBrowser: ((result: { type: 'dismiss' }) => void) | undefined;
    const host = installNativeMobileHostBindings('ios', {
      addUrlListener(current) {
        listener = current;
        return {
          remove() {
            listener = undefined;
          },
        };
      },
      openBrowser(url) {
        opens += 1;
        process.send?.({ type: 'open-browser', url });
        return new Promise((resolve) => {
          settleBrowser = resolve;
        });
      },
      dismissBrowser() {
        dismisses += 1;
        settleBrowser?.({ type: 'dismiss' });
      },
    });
    const realFetch = globalThis.fetch;
    let requests = 0;
    let receiptOnWire = false;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = async (target, settings) => {
      const address = new URL(typeof target === 'string' || target instanceof URL ? target : target.url);
      if (
        address.origin !== origin.origin ||
        address.pathname !== '/auth/native/exchange' ||
        settings?.method !== 'POST'
      )
        throw new Error('Unexpected native fetch');
      requests += 1;
      const response = await realFetch(target, { ...settings, redirect: 'error' });
      body = (await response.clone().json()) as Record<string, unknown>;
      receiptOnWire = Object.hasOwn(body, 'accountCreation');
      return response;
    };
    phase = 'load';
    const auth = (await import(new URL('src/lib/auth.ts', mobileSourceRoot).href)) as NativeAuth;
    const store = (await import(new URL('src/lib/auth-store.ts', mobileSourceRoot).href)) as NativeStore;
    phase = 'browser';
    const result = await (input.provider === 'google' ? auth.signInWithGoogleWeb() : auth.signInWithAppleWeb());
    phase = 'readback';
    const token = await store.getAuthToken();
    const refresh = await store.getRefreshToken();
    if (!token || !refresh) throw new Error('Native pair missing');
    const verified = await jwtVerify(token, new TextEncoder().encode(input.issuerVerificationSecret), {
      algorithms: ['HS256'],
      issuer: 'boardsesh',
      audience: 'boardsesh-mobile',
    });
    const receipt = result.accountCreation;
    complete(
      {
        type: 'result',
        success: result.success,
        receiptOnWire,
        requests,
        opens,
        dismisses,
        unexpectedHostCalls: host.unexpectedHostCalls,
        ownerMatches: result.userId === verified.payload.sub && receipt?.userId === verified.payload.sub,
        creationMatches: receipt?.accountCreated === input.expectedCreated && receipt.provider === input.provider,
        unknownAgePreserved: verified.payload.auth_time === undefined,
        storedActualWirePair: body?.jwt === token && body.refreshToken === refresh,
        ownerHash: typeof verified.payload.sub === 'string' ? hash(verified.payload.sub) : null,
      },
      0,
    );
  })().catch((error: unknown) =>
    complete(
      {
        type: 'failure',
        phase,
        code:
          typeof error === 'object' &&
          error &&
          'code' in error &&
          typeof error.code === 'string' &&
          /^ERR_[A-Z_]+$/.test(error.code)
            ? error.code
            : 'probe_failure',
      },
      1,
    ),
  );
});

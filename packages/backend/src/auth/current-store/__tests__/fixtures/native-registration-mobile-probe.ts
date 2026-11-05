import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { jwtVerify } from 'jose';

// Dynamic source URLs keep mobile out of the backend production import/type
// graph. Public Node module mocks replace native host bindings, not app logic.
interface NativeStore {
  storeTokens(jwt: string, refreshToken: string, expiresAt: string): Promise<void>;
  getAuthToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  getTokenExpiresAt(): Promise<Date | null>;
  captureAuthCredentialGeneration(): number;
}
interface NativeAuth {
  registerWithCredentials(
    this: void,
    email: string,
    password: string,
    name?: string,
  ): Promise<{
    success: boolean;
    status?: number | null;
    error?: string;
    userId?: string;
    accountCreation?: { userId: string; accountCreated: boolean; provider: string; createdAt: string };
  }>;
}
type StoreOptions = { keychainService?: string };
const mobileUrl = new URL('../../../../../../mobile/', import.meta.url);
const mobileRequire = createRequire(new URL('package.json', mobileUrl));
const secureValues = new Map<string, string>();
const secureWrites: { key: string; namespace: string }[] = [];
let unexpectedHostCalls = 0;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const namespace = (options?: StoreOptions) => options?.keychainService ?? 'legacy';
const secureKey = (key: string, options?: StoreOptions) => `${namespace(options)}\0${key}`;
function unusedHost(): never {
  unexpectedHostCalls += 1;
  throw new Error('Unused native host boundary invoked');
}
function nativeModule(name: string, namedExports: Record<string, unknown>, defaultExport?: unknown) {
  // Resolve through the actual mobile package; no backend/root fallback.
  mock.module(mobileRequire.resolve(name), {
    cache: true,
    namedExports,
    ...(defaultExport === undefined ? {} : { defaultExport }),
  });
}
function installHostBindings() {
  nativeModule('react-native', {
    Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Linking: {
      addEventListener: () => ({ remove() {} }),
      getInitialURL: async () => null,
      openURL: unusedHost,
      canOpenURL: async () => false,
    },
  });
  nativeModule('expo-secure-store', {
    AFTER_FIRST_UNLOCK: 0,
    getItemAsync: async (key: string, options?: StoreOptions) => secureValues.get(secureKey(key, options)) ?? null,
    setItemAsync: async (key: string, value: string, options?: StoreOptions) => {
      secureWrites.push({ key, namespace: namespace(options) });
      secureValues.set(secureKey(key, options), value);
    },
    deleteItemAsync: async (key: string, options?: StoreOptions) => {
      secureValues.delete(secureKey(key, options));
    },
  });
  nativeModule('expo-application', {
    nativeApplicationVersion: '0.0.0-proof',
    nativeBuildVersion: '1',
    getInstallationTimeAsync: async () => new Date('2026-01-01T00:00:00.000Z'),
  });
  nativeModule('expo-apple-authentication', {
    signInAsync: unusedHost,
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  });
  nativeModule('expo-web-browser', {
    openBrowserAsync: unusedHost,
    openAuthSessionAsync: unusedHost,
    dismissBrowser: unusedHost,
    maybeCompleteAuthSession: unusedHost,
  });
  nativeModule('expo-crypto', {
    getRandomBytes: (length: number) => randomBytes(length),
    digestStringAsync: async (_algorithm: string, text: string) => hash(text),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
  });
  nativeModule('@react-native-google-signin/google-signin', {
    GoogleSignin: { configure: unusedHost, signIn: unusedHost, hasPlayServices: unusedHost },
    statusCodes: { SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED' },
  });
  class DisabledNativePostHog {
    constructor() {
      unusedHost();
    }
  }
  nativeModule('posthog-react-native', { PostHog: DisabledNativePostHog, PostHogPersistedProperty: {} });
  nativeModule('posthog-react-native-session-replay', { setOptOut: unusedHost });
  class UnusedNativeFile {
    constructor() {
      unusedHost();
    }
  }
  nativeModule('expo-file-system', { File: UnusedNativeFile, Paths: { document: 'owned-native-proof' } });
  nativeModule(
    '@react-native-async-storage/async-storage',
    {},
    { getItem: unusedHost, setItem: unusedHost, removeItem: unusedHost },
  );
}

const deadline = setTimeout(() => process.exit(2), 15_000);
function complete(report: object, status: number) {
  clearTimeout(deadline);
  if (!process.send) {
    process.exit(status);
    return;
  }
  process.send(report, () => process.exit(status));
}

process.once('message', (message: unknown) => {
  let phase = 'input';
  void (async () => {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      throw new Error('Invalid owned mobile probe');
    const input = message as Record<string, unknown>;
    if (
      typeof input.origin !== 'string' ||
      typeof input.email !== 'string' ||
      typeof input.password !== 'string' ||
      typeof input.issuerVerificationSecret !== 'string'
    )
      throw new Error('Invalid owned mobile probe');
    const origin = new URL(input.origin);
    if (
      origin.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
      !origin.port ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('Probe requires exact owned loopback origin');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      EXPO_OS: 'ios',
      EXPO_PUBLIC_BACKEND_URL: origin.origin,
      EXPO_PUBLIC_WEB_URL: origin.origin,
      EXPO_PUBLIC_POSTHOG_KEY: '',
      EXPO_PUBLIC_SCREENSHOT_MODE: '1',
    });
    // The product client never receives server-side credentials. Only this test
    // oracle receives its synthetic verification key through IPC.
    for (const key of ['NEXTAUTH_SECRET', 'AUTH_SECRET', 'CRON_SECRET', 'CURRENT_STORE_AUTH_RPC_SECRET'])
      delete process.env[key];
    Object.assign(globalThis, { __DEV__: false });
    installHostBindings();
    const realFetch = globalThis.fetch;
    const observations: Promise<void>[] = [];
    let observedStatus: number | null = null;
    let requestStartedAt = 0;
    let requestFinishedAt = 0;
    let observedBody: Record<string, unknown> | undefined;
    let observedRequest: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    let requests = 0;
    let blockedRequests = 0;
    globalThis.fetch = async (url, options) => {
      const address = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
      // Guard before EVERY native fetch. Reject redirects at the I/O boundary
      // so even a redirect cannot send a probe request outside this listener.
      if (
        address.origin !== origin.origin ||
        address.pathname !== '/auth/native/register' ||
        address.username ||
        address.password ||
        address.search ||
        address.hash
      ) {
        blockedRequests += 1;
        throw new Error('Unowned probe fetch refused');
      }
      requests += 1;
      requestHeaders = new Headers(options?.headers);
      if (typeof options?.body !== 'string') throw new Error('Expected installed JSON request');
      observedRequest = JSON.parse(options.body) as Record<string, unknown>;
      requestStartedAt = Date.now();
      const response = await realFetch(url, { ...options, redirect: 'error' });
      requestFinishedAt = Date.now();
      observedStatus = response.status;
      // Never delay fetch resolution on a cloned body. Real auth.ts owns its
      // own body-read failure boundary; this observation settles afterward.
      observations.push(
        response
          .clone()
          .json()
          .then((body: unknown) => {
            if (body && typeof body === 'object' && !Array.isArray(body))
              observedBody = body as Record<string, unknown>;
          })
          .catch(() => undefined),
      );
      return response;
    };
    phase = 'load-store';
    const storeUrl = new URL('src/lib/auth-store.ts', mobileUrl).href;
    const store = (await import(storeUrl)) as NativeStore;
    phase = 'load-auth';
    const authUrl = new URL('src/lib/auth.ts', mobileUrl).href;
    const auth = (await import(authUrl)) as NativeAuth;
    phase = 'seed';
    const oldJwt = randomBytes(32).toString('base64url');
    const oldRefresh = randomBytes(32).toString('hex');
    const oldExpires = new Date(Date.now() + 86400_000).toISOString();
    await store.storeTokens(oldJwt, oldRefresh, oldExpires);
    await Promise.all([store.getAuthToken(), store.getRefreshToken(), store.getTokenExpiresAt()]);
    const oldGeneration = store.captureAuthCredentialGeneration();
    const beforeNamespaces = new Map(secureValues);
    secureWrites.length = 0;
    phase = 'register';
    let registrationThrew = false;
    let result: Awaited<ReturnType<NativeAuth['registerWithCredentials']>> = { success: false };
    try {
      result = (await Reflect.apply(auth.registerWithCredentials, undefined, [
        input.email,
        input.password,
        '  Native Climber  ',
        {
          userId: 'attacker-selected-owner',
          protocolVersion: 2,
          requestId: 'attacker-request',
          accountCreation: { userId: 'attacker-selected-owner', createdAt: '1900-01-01T00:00:00.000Z' },
          rpcSecret: 'must-not-forward',
        },
      ])) as Awaited<ReturnType<NativeAuth['registerWithCredentials']>>;
    } catch {
      registrationThrew = true;
    }
    phase = 'readback';
    await Promise.allSettled(observations);
    const [storedJwt, storedRefresh, storedExpires] = await Promise.all([
      store.getAuthToken(),
      store.getRefreshToken(),
      store.getTokenExpiresAt(),
    ]);
    const credentialKeys = ['boardsesh_refresh_token', 'boardsesh_token_expires_at', 'boardsesh_jwt'];
    const v2Writes = secureWrites
      .filter((entry) => entry.namespace === 'boardsesh.v2' && credentialKeys.includes(entry.key))
      .map((entry) => entry.key);
    const legacyWrites = secureWrites
      .filter((entry) => entry.namespace === 'legacy' && credentialKeys.includes(entry.key))
      .map((entry) => entry.key);
    const noAuthority =
      observedRequest !== undefined &&
      Object.keys(observedRequest).sort().join(',') === 'email,name,password' &&
      observedRequest.email === input.email &&
      observedRequest.password === input.password &&
      requestHeaders?.get('authorization') === null &&
      requestHeaders?.get('cookie') === null &&
      ![...requestHeaders!.keys()].some((key) => /secret|request-id|protocol|authority/i.test(key));
    const oldPreserved =
      storedJwt === oldJwt &&
      storedRefresh === oldRefresh &&
      storedExpires?.toISOString() === oldExpires &&
      secureValues.size === beforeNamespaces.size &&
      [...beforeNamespaces].every(([key, value]) => secureValues.get(key) === value);
    const flat =
      observedStatus === 201 &&
      typeof observedBody?.jwt === 'string' &&
      typeof observedBody.refreshToken === 'string' &&
      typeof observedBody.expiresAt === 'string' &&
      typeof observedBody.userId === 'string' &&
      !('protocolVersion' in observedBody) &&
      !('requiresVerification' in observedBody) &&
      !('tokenPair' in observedBody);
    let signatureValid = false;
    let lifetimeValid = false;
    let receiptMatches = false;
    if (flat && observedBody && typeof observedBody.jwt === 'string') {
      phase = 'verify';
      const verified = await jwtVerify(observedBody.jwt, new TextEncoder().encode(input.issuerVerificationSecret), {
        algorithms: ['HS256'],
        issuer: 'boardsesh',
        audience: 'boardsesh-mobile',
      });
      signatureValid = verified.payload.sub === observedBody.userId;
      lifetimeValid =
        typeof verified.payload.exp === 'number' &&
        typeof verified.payload.iat === 'number' &&
        verified.payload.iat >= Math.floor(requestStartedAt / 1000) &&
        verified.payload.iat <= Math.floor(requestFinishedAt / 1000) &&
        verified.payload.exp >= Math.floor(requestStartedAt / 1000) + 7 * 86400 &&
        verified.payload.exp <= Math.floor(requestFinishedAt / 1000) + 7 * 86400 &&
        typeof observedBody.expiresAt === 'string' &&
        new Date(observedBody.expiresAt).getTime() >= requestStartedAt + 7 * 86400_000 &&
        new Date(observedBody.expiresAt).getTime() <= requestFinishedAt + 7 * 86400_000;
      const receipt = observedBody.accountCreation;
      receiptMatches =
        !!receipt &&
        typeof receipt === 'object' &&
        !Array.isArray(receipt) &&
        (receipt as Record<string, unknown>).userId === observedBody.userId &&
        (receipt as Record<string, unknown>).provider === 'email' &&
        (receipt as Record<string, unknown>).accountCreated === true &&
        typeof (receipt as Record<string, unknown>).createdAt === 'string' &&
        result.userId === observedBody.userId &&
        result.accountCreation?.userId === observedBody.userId &&
        result.accountCreation?.createdAt === (receipt as Record<string, unknown>).createdAt;
    }
    const wireReceipt = observedBody?.accountCreation as Record<string, unknown> | undefined;
    complete(
      {
        ok: true,
        registrationThrew,
        success: result.success,
        failureStatus: result.success ? null : (result.status ?? null),
        networkFailure: !result.success && result.error === 'network',
        observed201: observedStatus === 201,
        flat,
        signatureValid,
        lifetimeValid,
        receiptMatches,
        noAuthority,
        exactlyOneRequest: requests === 1,
        noExternalCalls: blockedRequests === 0 && unexpectedHostCalls === 0,
        nativeClientIdentity: requestHeaders?.get('x-boardsesh-client')?.startsWith('boardsesh-mobile/') === true,
        storedPairMatches:
          flat &&
          storedJwt === observedBody?.jwt &&
          storedRefresh === observedBody?.refreshToken &&
          storedExpires?.toISOString() === observedBody?.expiresAt,
        writeOrder:
          v2Writes.join(',') === credentialKeys.join(',') && legacyWrites.join(',') === credentialKeys.join(','),
        newGeneration: store.captureAuthCredentialGeneration() === oldGeneration + 1,
        oldPreserved,
        noWritesOnFailure: secureWrites.length === 0,
        sameGeneration: store.captureAuthCredentialGeneration() === oldGeneration,
        ownerHash: typeof observedBody?.userId === 'string' ? hash(observedBody.userId) : null,
        refreshHash: typeof observedBody?.refreshToken === 'string' ? hash(observedBody.refreshToken) : null,
        createdAtHash: typeof wireReceipt?.createdAt === 'string' ? hash(wireReceipt.createdAt) : null,
      },
      0,
    );
  })().catch((error: unknown) => {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^ERR_[A-Z_]+$/.test(error.code)
        ? error.code
        : 'probe_failure';
    complete({ ok: false, phase, code }, 1);
  });
});

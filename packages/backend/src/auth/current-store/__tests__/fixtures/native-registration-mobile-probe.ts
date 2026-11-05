import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify } from 'jose';
import { mobileSourceRoot as mobileUrl, installNativeMobileHostBindings } from './native-mobile-host-io';

// Dynamic source URLs keep mobile out of the backend production import/type
// graph. Public Node module mocks replace native host bindings, not app logic.
interface NativeStore {
  storeTokens(jwt: string, refreshToken: string, expiresAt: string): Promise<void>;
  getAuthToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  getTokenExpiresAt(): Promise<Date | null>;
  captureAuthCredentialGeneration(): number;
}
type NativeAuthResult = {
  success: boolean;
  status?: number | null;
  error?: string;
  userId?: string;
  accountCreation?: { userId: string; accountCreated: boolean; provider: string; createdAt: string };
};
interface NativeAuth {
  registerWithCredentials(this: void, email: string, password: string, name?: string): Promise<NativeAuthResult>;
  oauthNativeSignIn(
    this: void,
    provider: 'apple' | 'google',
    identityToken: string,
    extra?: { nonce?: string; name?: { firstName?: string; lastName?: string } },
  ): Promise<NativeAuthResult>;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

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
    const operation = input.operation ?? 'register';
    if (
      typeof input.origin !== 'string' ||
      typeof input.issuerVerificationSecret !== 'string' ||
      (operation !== 'register' && operation !== 'oauth') ||
      (operation === 'register' && (typeof input.email !== 'string' || typeof input.password !== 'string')) ||
      (operation === 'oauth' &&
        ((input.provider !== 'apple' && input.provider !== 'google') || typeof input.identityToken !== 'string'))
    )
      throw new Error('Invalid owned mobile probe');
    const endpoint = operation === 'oauth' ? '/auth/native/oauth' : '/auth/native/register';
    const expectedStatus = operation === 'oauth' ? 200 : 201;
    const nonce = typeof input.nonce === 'string' ? input.nonce : undefined;
    const name =
      input.name && typeof input.name === 'object' && !Array.isArray(input.name)
        ? (input.name as { firstName?: string; lastName?: string })
        : undefined;
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
    const host = installNativeMobileHostBindings();
    const { secureValues, secureWrites } = host;
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
        address.pathname !== endpoint ||
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
    let result: NativeAuthResult = { success: false };
    try {
      const hostileMetadata = {
        userId: 'attacker-selected-owner',
        protocolVersion: 2,
        requestId: 'attacker-request',
        accountCreation: { userId: 'attacker-selected-owner', createdAt: '1900-01-01T00:00:00.000Z' },
        rpcSecret: 'must-not-forward',
      };
      result =
        operation === 'oauth'
          ? ((await Reflect.apply(auth.oauthNativeSignIn, undefined, [
              input.provider,
              input.identityToken,
              { ...hostileMetadata, nonce, name },
            ])) as NativeAuthResult)
          : ((await Reflect.apply(auth.registerWithCredentials, undefined, [
              input.email,
              input.password,
              '  Native Climber  ',
              hostileMetadata,
            ])) as NativeAuthResult);
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
    const payloadMatches =
      observedRequest !== undefined &&
      (operation === 'register'
        ? Object.keys(observedRequest).sort().join(',') === 'email,name,password' &&
          observedRequest.email === input.email &&
          observedRequest.password === input.password
        : Object.keys(observedRequest).sort().join(',') ===
            [
              'provider',
              'identityToken',
              ...(nonce !== undefined ? ['nonce'] : []),
              ...(name !== undefined ? ['name'] : []),
            ]
              .sort()
              .join(',') &&
          observedRequest.provider === input.provider &&
          observedRequest.identityToken === input.identityToken &&
          observedRequest.nonce === nonce &&
          JSON.stringify(observedRequest.name) === JSON.stringify(name));
    const noAuthority =
      payloadMatches &&
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
      observedStatus === expectedStatus &&
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
        (receipt as Record<string, unknown>).provider === (operation === 'oauth' ? input.provider : 'email') &&
        (receipt as Record<string, unknown>).accountCreated === (input.expectedCreated ?? true) &&
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
        observed200: observedStatus === 200,
        flat,
        signatureValid,
        lifetimeValid,
        receiptMatches,
        noAuthority,
        exactlyOneRequest: requests === 1,
        noExternalCalls: blockedRequests === 0 && host.unexpectedHostCalls === 0,
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

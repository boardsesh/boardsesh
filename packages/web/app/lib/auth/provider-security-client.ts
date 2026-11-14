import { z } from 'zod';
import { readBrowserBackendSessionScope } from '@boardsesh/auth-protocol/browser-backend-session';
import { browserBackendClient } from './browser-backend-client';
import { signInWithSessionIntent, requestWebSessionRefresh } from './web-session-events';
import { publicProviderSecurityReady } from './provider-security-readiness';
import {
  providerSecurityResumeSchema,
  providerSecurityResumeUrl,
  type ProviderSecurityResume,
} from './provider-security-resume';
import {
  providerSettingsViewFrame,
  PROVIDER_SETTINGS_VIEW_HEADER,
  PROVIDER_SETTINGS_OPERATION_HEADER,
} from './provider-security-view';
import type {
  ProviderMethodAction,
  ProviderMethodResult,
  ProviderReauthentication,
} from '@/app/components/account/provider-methods-section';
import type { Locale } from '@/app/lib/i18n/config';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const provider = z.enum(['google', 'apple']);
export const providerSettingsMethodsSchema = z
  .object({
    outcome: z.literal('available'),
    actorContextKey: digest,
    methods: z
      .array(z.object({ methodId: digest, provider, usable: z.boolean(), canUnlink: z.boolean() }).strict())
      .max(100),
    configuredProviders: z.array(provider).max(2),
    passwordUsable: z.boolean(),
    googleReauthenticationAvailable: z.boolean(),
  })
  .strict();
export type ProviderSettingsMethods = z.infer<typeof providerSettingsMethodsSchema>;
const intentSchema = z.object({ outcome: z.literal('reauthentication_required'), operationKey: digest }).strict();
const completedSchema = z.object({ outcome: z.literal('completed') }).strict();
const passwordCompletedSchema = z.object({ outcome: z.literal('completed'), operationKey: digest }).strict();
const refusalSchema = z.object({ outcome: z.string() }).strict();
const paths = {
  methods: '/api/internal/auth/provider-security/methods',
  resume: '/api/internal/auth/provider-security/resume',
  intent: '/api/internal/auth/provider-security/intent',
  password: '/api/internal/auth/provider-security/reauthenticate-password',
  unlink: '/api/internal/auth/provider-security/unlink',
  acknowledge: '/api/internal/auth/provider-security/acknowledge',
} as const;
class IdentityChanged extends Error {}
const changed = (): never => {
  throw new IdentityChanged();
};
const unavailable = (): never => {
  throw new Error('Provider settings unavailable');
};
function outcome(status: number, body: unknown): ProviderMethodResult {
  const parsed = refusalSchema.safeParse(body);
  if (status === 401 || (status === 409 && parsed.data?.outcome === 'identity_changed'))
    return { outcome: 'identity_changed' };
  switch (parsed.data?.outcome) {
    case 'reauthentication_required':
    case 'reauthentication_unavailable':
    case 'last_usable_method':
    case 'ownership_conflict':
      return { outcome: parsed.data.outcome };
    default:
      return { outcome: 'unavailable' };
  }
}

/** One accepted Session object owns this entire controller lifetime. It never
 * reloads an operation against a later session or stores a password/bearer. */
export function createProviderSettingsClient(options: {
  readonly session: unknown;
  readonly locale: Locale;
  readonly canonicalOrigin: string;
  readonly authority?: Pick<typeof browserBackendClient, 'getSnapshot' | 'isSessionCurrent' | 'subscribe'>;
  readonly fetch?: typeof fetch;
  readonly signIn?: typeof signInWithSessionIntent;
  readonly ready?: () => boolean;
  readonly refresh?: () => void;
  readonly invalidate?: () => void;
  readonly onOperation?: (operationKey: string | null) => void;
  readonly hash?: (frame: string) => Promise<string>;
}) {
  const session = options.session;
  const observed = readBrowserBackendSessionScope(session);
  const authority = options.authority ?? browserBackendClient;
  const revision = authority.getSnapshot().revision;
  const send = options.fetch ?? fetch;
  const signIn = options.signIn ?? signInWithSessionIntent;
  const ready = options.ready ?? publicProviderSecurityReady;
  const refresh = options.refresh ?? requestWebSessionRefresh;
  const invalidate = options.invalidate ?? (() => browserBackendClient.retire());
  const onOperation = options.onOperation ?? (() => {});
  const locale = options.locale;
  const canonicalOrigin = options.canonicalOrigin;
  const lifetime = new AbortController();
  let methods: ProviderSettingsMethods | null = null;
  let pending: { action: ProviderMethodAction; operationKey: string; reauthenticated: boolean } | null = null;
  const ownsAuthority = () =>
    observed.status === 'selected' &&
    authority.getSnapshot().revision === revision &&
    authority.isSessionCurrent(session);
  const owns = () => ready() && !lifetime.signal.aborted && ownsAuthority();
  function retireCapturedViewIfStillCurrent(): void {
    if (!ownsAuthority()) return;
    invalidate();
    refresh();
  }
  const assertCurrent = () => {
    if (!owns()) return changed();
  };
  const unsubscribe = authority.subscribe(() => {
    if (!owns()) lifetime.abort();
  });
  const hash =
    options.hash ??
    (async (frame: string) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(frame));
      return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    });
  async function awaitOwned<Result>(start: () => Promise<Result>, signal: AbortSignal): Promise<Result> {
    assertCurrent();
    if (signal.aborted) return unavailable();
    let rejectAborted: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAborted = () =>
        reject(ownsAuthority() ? new Error('Provider response unavailable') : new IdentityChanged());
    });
    signal.addEventListener('abort', rejectAborted, { once: true });
    try {
      if (signal.aborted) return unavailable();
      const response = await Promise.race([start(), cancelled]);
      assertCurrent();
      if (signal.aborted) return unavailable();
      return response;
    } finally {
      signal.removeEventListener('abort', rejectAborted);
    }
  }
  async function request(operation: keyof typeof paths, body?: unknown, operationKey?: string) {
    assertCurrent();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]);
    const headers = new Headers({ Accept: 'application/json' });
    const method = operation === 'methods' || operation === 'resume' ? 'GET' : 'POST';
    if (method === 'GET') {
      if (observed.status !== 'selected') return changed();
      const frame = providerSettingsViewFrame(observed.owner);
      const view = digest.parse(await awaitOwned(() => hash(frame), signal));
      assertCurrent();
      headers.set(PROVIDER_SETTINGS_VIEW_HEADER, view);
      if (operationKey !== undefined) headers.set(PROVIDER_SETTINGS_OPERATION_HEADER, digest.parse(operationKey));
    } else headers.set('Content-Type', 'application/json');
    const response = await awaitOwned(
      () =>
        send(paths[operation], {
          method,
          credentials: 'include',
          cache: 'no-store',
          signal,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      signal,
    );
    assertCurrent();
    if (signal.aborted) return unavailable();
    let contents: unknown;
    if (response.body) {
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '';
        let bytes = 0;
        while (true) {
          assertCurrent();
          if (signal.aborted) return unavailable();
          const chunk = await awaitOwned(() => reader.read(), signal);
          assertCurrent();
          if (signal.aborted) return unavailable();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65_536) return unavailable();
          text += decoder.decode(chunk.value, { stream: true });
        }
        contents = JSON.parse(text + decoder.decode()) as unknown;
      } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
      }
    } else {
      contents = await awaitOwned(() => response.json(), signal);
      assertCurrent();
      if (signal.aborted || new TextEncoder().encode(JSON.stringify(contents)).byteLength > 65_536)
        return unavailable();
    }
    assertCurrent();
    return { status: response.status, body: contents };
  }
  const result = async (run: () => Promise<ProviderMethodResult>): Promise<ProviderMethodResult> => {
    try {
      return await run();
    } catch (error) {
      return { outcome: error instanceof IdentityChanged ? 'identity_changed' : 'unavailable' };
    }
  };
  async function oauth(
    purpose: 'link' | 'reauthenticate-google',
    providerName: 'google' | 'apple',
    operationKey: string,
  ): Promise<ProviderMethodResult> {
    assertCurrent();
    const callbackUrl = providerSecurityResumeUrl(canonicalOrigin, operationKey, locale);
    const reply = await signIn(
      providerName,
      {
        callbackUrl,
        providerSecurityOperation: purpose,
        providerSecurityOperationKey: operationKey,
      },
      { signal: lifetime.signal },
    );
    assertCurrent();
    return { outcome: reply?.error ? 'unavailable' : 'redirecting' };
  }
  return Object.freeze({
    isCurrent: owns,
    dispose() {
      lifetime.abort();
      unsubscribe();
      methods = null;
      pending = null;
    },
    async readMethods(): Promise<ProviderSettingsMethods> {
      const response = await request('methods');
      assertCurrent();
      if (response.status !== 200) {
        if (response.status === 401 || response.status === 409) {
          retireCapturedViewIfStillCurrent();
          return changed();
        }
        return unavailable();
      }
      methods = providerSettingsMethodsSchema.parse(response.body);
      return methods;
    },
    async resume(
      operationKey: string,
    ): Promise<
      { readonly status: 'completed' } | { readonly status: 'resumable'; readonly metadata: ProviderSecurityResume }
    > {
      const selector = digest.parse(operationKey);
      const acknowledged = await request('acknowledge', { operationKey: selector });
      assertCurrent();
      if (acknowledged.status === 200 && completedSchema.safeParse(acknowledged.body).success) {
        onOperation(null);
        return { status: 'completed' };
      }
      if (acknowledged.status !== 400 && acknowledged.status !== 409) return unavailable();
      const response = await request('resume', undefined, selector);
      assertCurrent();
      if (response.status !== 200) {
        if (response.status === 401 || response.status === 409) return changed();
        return unavailable();
      }
      const metadata = providerSecurityResumeSchema.parse(response.body);
      if (
        metadata.operationKey !== selector ||
        methods === null ||
        metadata.actorContextKey !== methods.actorContextKey
      )
        return changed();
      pending = {
        operationKey: selector,
        action:
          metadata.action === 'link'
            ? { action: 'link', provider: metadata.provider }
            : { action: 'unlink', provider: metadata.provider, methodId: metadata.methodId },
        reauthenticated: metadata.reauthenticationReady,
      };
      return { status: 'resumable', metadata };
    },
    action(action: ProviderMethodAction): Promise<ProviderMethodResult> {
      // Capture the exact confirmed action before any asynchronous work.
      const confirmed = Object.freeze({ ...action });
      return result(async () => {
        assertCurrent();
        if (methods === null) return unavailable();
        if (confirmed.provider !== 'google' && confirmed.provider !== 'apple') return unavailable();
        if (pending === null || JSON.stringify(pending.action) !== JSON.stringify(confirmed)) {
          const response = await request('intent', { actorContextKey: methods.actorContextKey, ...confirmed });
          assertCurrent();
          if (response.status !== 200) return outcome(response.status, response.body);
          const reply = intentSchema.parse(response.body);
          pending = { action: confirmed, operationKey: reply.operationKey, reauthenticated: false };
          onOperation(reply.operationKey);
          return { outcome: 'reauthentication_required' };
        }
        if (!pending.reauthenticated) return { outcome: 'reauthentication_required' };
        const operation = pending;
        if (confirmed.action === 'link') return oauth('link', confirmed.provider, operation.operationKey);
        let response: Awaited<ReturnType<typeof request>>;
        try {
          response = await request('unlink', {
            actorContextKey: methods.actorContextKey,
            operationKey: operation.operationKey,
          });
        } catch (error) {
          // A response can be lost after the backend committed. Retire this
          // local view and observe primary; the URL retains the exact ACK key.
          retireCapturedViewIfStillCurrent();
          throw error;
        }
        assertCurrent();
        if (response.status !== 200) {
          const refused = outcome(response.status, response.body);
          if (response.status === 503 || response.status === 401 || response.status === 409) {
            retireCapturedViewIfStillCurrent();
          }
          return refused;
        }
        if (!completedSchema.safeParse(response.body).success) {
          retireCapturedViewIfStillCurrent();
          return unavailable();
        }
        pending = null;
        onOperation(null);
        retireCapturedViewIfStillCurrent();
        return { outcome: 'completed' };
      });
    },
    reauthenticate(input: ProviderReauthentication): Promise<ProviderMethodResult> {
      const proof = { ...input };
      return result(async () => {
        assertCurrent();
        if (pending === null || methods === null) return unavailable();
        const operation = pending;
        if (proof.method === 'google') {
          if (!methods.googleReauthenticationAvailable) return { outcome: 'reauthentication_unavailable' };
          return oauth('reauthenticate-google', 'google', operation.operationKey);
        }
        if (!methods.passwordUsable) return { outcome: 'reauthentication_unavailable' };
        const response = await request('password', {
          actorContextKey: methods.actorContextKey,
          operationKey: operation.operationKey,
          password: proof.password,
        });
        assertCurrent();
        if (response.status !== 200) return outcome(response.status, response.body);
        const reply = passwordCompletedSchema.parse(response.body);
        if (reply.operationKey !== operation.operationKey || pending !== operation) return changed();
        operation.reauthenticated = true;
        return { outcome: 'completed' };
      });
    },
  });
}

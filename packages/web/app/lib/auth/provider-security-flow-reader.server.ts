import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import { NextRequest } from 'next/server';
import { providerSecurityMode, type ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { readProviderSecurityAuthBody } from './provider-security-auth-body.server';
import {
  assertProviderSecurityFlowSecret,
  openProviderSecurityFlow,
  providerSecurityFlowCookieName,
  type ProviderSecurityFlow,
} from './provider-security-flow.server';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { providerSecurityResumeUrl } from './provider-security-resume';
import {
  captureProviderBrowserContext,
  requireProviderSecurityFlowActor,
  ProviderSecurityIdentityChangedError,
  type ProviderBrowserContext,
} from './provider-security-selection.server';
import { findWebOAuthCallbackScope, resumeAppleOAuthCallback, webOAuthFlowHash } from './web-oauth-continuation.server';

const prefix = '__Host-boardsesh.provider-security.';
const selector = /^[a-f0-9]{64}$/;
type Purpose = 'link' | 'reauthenticate-google';
interface Located {
  readonly operationKey: string;
  readonly locale: 'en-US' | 'es' | 'fr' | 'de' | 'it';
}
export type ProviderSecurityOAuthFlowRead =
  | {
      readonly status: 'explicit';
      readonly purpose: Purpose;
      readonly provider: ProviderSecurityProvider;
      readonly flow: ProviderSecurityFlow;
      readonly actor: ProviderBrowserContext;
      readonly returnUrl: string;
      readonly flowHash: string | null;
    }
  | { readonly status: 'ordinary-unqualified' }
  | { readonly status: 'refused'; readonly reason: 'invalid_request' | 'identity_changed' | 'unavailable' };

class InvalidRequest extends Error {}
const invalid = (): never => {
  throw new InvalidRequest();
};
function cookies(header: string | null) {
  if (Buffer.byteLength(header ?? '') > 32_768) return invalid();
  const parts = (header ?? '').split(';');
  if (parts.length > 128) return invalid();
  return parts
    .filter((part) => part.trim())
    .map((part) => {
      const pair = part.trim();
      const separator = pair.indexOf('=');
      if (separator <= 0) return invalid();
      return Object.freeze({ name: pair.slice(0, separator).trim(), content: pair.slice(separator + 1).trim() });
    });
}
function locateReturn(raw: string, origin: string): Located | null {
  const url = new URL(raw, origin);
  const keys = url.searchParams.getAll('providerSecurityResume');
  if (keys.length === 0) return null;
  if (
    keys.length !== 1 ||
    !selector.test(keys[0]) ||
    url.origin !== origin ||
    url.hash ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].length !== 1
  )
    return invalid();
  const path = url.pathname.match(/^\/(?:(es|fr|de|it)\/)?settings$/);
  if (!path) return invalid();
  const locale = (path[1] ?? 'en-US') as Located['locale'];
  if (providerSecurityResumeUrl(origin, keys[0], locale) !== url.href) return invalid();
  return { operationKey: keys[0], locale };
}
function single(fields: URLSearchParams, key: string): string {
  const matches = fields.getAll(key);
  if (matches.length !== 1 || !matches[0]) return invalid();
  return matches[0];
}

/** A dispatch locator only. `ordinary-unqualified` never authorizes legacy
 * resolve, implicit linking or a login: the outer provider delegate must prove
 * that flow's distinct private ordinary-start receipt before any command. */
export function createProviderSecurityOAuthFlowReader(
  dependencies: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (header: string | null) => Promise<PresentedBrowserSelection>;
  } = {},
) {
  const environment = Object.freeze({ ...(dependencies.environment ?? process.env) });
  const ready = dependencies.ready ?? publicProviderSecurityReady;
  const readSelection =
    dependencies.readSelection ?? ((header) => readPresentedBrowserSelection(header, { environment }));
  return Object.freeze({
    async read(
      request: NextRequest,
      base: NextAuthOptions,
      route: { readonly action: string; readonly provider: string },
    ): Promise<ProviderSecurityOAuthFlowRead> {
      const action = route.action;
      const provider = route.provider;
      const method = request.method;
      const path = request.nextUrl.pathname;
      const header = request.headers.get('cookie');
      const signal = request.signal;
      const origin = resolvePublicAuthOrigin(environment);
      const options: NextAuthOptions = {
        ...base,
        secret: base.secret ?? environment.NEXTAUTH_SECRET,
        cookies: Object.fromEntries(
          Object.entries(base.cookies ?? {}).map(([name, cookie]) => [
            name,
            { ...cookie, options: { ...cookie.options } },
          ]),
        ),
      };
      try {
        if (providerSecurityMode(environment) === 'legacy') return { status: 'ordinary-unqualified' };
        if (
          !ready() ||
          browserBindingMode(environment) !== 'backend-staging' ||
          environment.CURRENT_STORE_WEB_OAUTH_MODE !== 'backend-staging'
        )
          return { status: 'refused', reason: 'unavailable' };
        if (
          (provider !== 'google' && provider !== 'apple') ||
          !['signin', 'callback'].includes(action) ||
          path !== `/api/auth/${action}/${provider}`
        )
          return invalid();
        if (
          !origin ||
          new URL(origin).protocol !== 'https:' ||
          request.headers.get('host') !== new URL(origin).host ||
          signal.aborted
        )
          return invalid();
        const observed = cookies(header);
        const carriers = observed.filter((cookie) => cookie.name.startsWith(prefix));
        if (carriers.length > 0) assertProviderSecurityFlowSecret(environment.NEXTAUTH_SECRET ?? '');
        if (
          carriers.length > 4 ||
          carriers.some((cookie) => !selector.test(cookie.name.slice(prefix.length))) ||
          new Set(carriers.map((cookie) => cookie.name)).size !== carriers.length
        )
          return invalid();
        // Preserve actual source headers even if a retaining wrapper mutates its
        // Request while body/state cryptography or primary admission is pending.
        const captured = new NextRequest(request.clone(), { headers: new Headers(request.headers) });
        let located: Located | null = null;
        let purpose: Purpose | undefined;
        let hash: string | null = null;
        if (action === 'signin') {
          if (method !== 'POST') return { status: 'ordinary-unqualified' };
          if (
            captured.headers.get('origin') !== origin ||
            captured.headers.has('content-encoding') ||
            captured.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
              'application/x-www-form-urlencoded'
          )
            return invalid();
          const body = await readProviderSecurityAuthBody(new Response(captured.body, { headers: captured.headers }));
          if (body === null || body.byteLength > 16_384 || signal.aborted) return invalid();
          const fields = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body));
          const hasOperation = fields.has('providerSecurityOperation');
          const hasKey = fields.has('providerSecurityOperationKey');
          if (!hasOperation && !hasKey) return { status: 'ordinary-unqualified' };
          const key = single(fields, 'providerSecurityOperationKey');
          const operation = single(fields, 'providerSecurityOperation');
          if (
            !selector.test(key) ||
            (operation !== 'link' && operation !== 'reauthenticate-google') ||
            [...fields.keys()].length > 8 ||
            [...fields.keys()].some(
              (key) =>
                ![
                  'csrfToken',
                  'callbackUrl',
                  'json',
                  'providerSecurityOperation',
                  'providerSecurityOperationKey',
                ].includes(key),
            )
          )
            return invalid();
          purpose = operation;
          located = locateReturn(single(fields, 'callbackUrl'), origin);
          if (!located || located.operationKey !== key) return invalid();
        } else {
          let state: string;
          let scope: string;
          if (provider === 'apple' && method === 'GET' && captured.nextUrl.searchParams.has('boardseshOAuthContinue')) {
            if ([...captured.nextUrl.searchParams.keys()].some((key) => key !== 'boardseshOAuthContinue'))
              return invalid();
            const marker = single(captured.nextUrl.searchParams, 'boardseshOAuthContinue');
            const resumed = await resumeAppleOAuthCallback(captured, options, marker);
            state = resumed.state;
            scope = marker;
          } else {
            if (method !== 'GET') return invalid(); // raw Apple POST must first normalize transport.
            state = single(captured.nextUrl.searchParams, 'state');
            scope = await findWebOAuthCallbackScope(captured, options, provider, state);
          }
          hash = webOAuthFlowHash(provider, state);
          const callbackName = options.cookies?.callbackUrl?.name;
          if (!callbackName) return invalid();
          const callbackCookies = observed.filter((cookie) => cookie.name === `${callbackName}.${scope}`);
          if (callbackCookies.length !== 1 || Buffer.byteLength(callbackCookies[0].content) > 4096) return invalid();
          located = locateReturn(decodeURIComponent(callbackCookies[0].content), origin);
          const matching: { readonly key: string; readonly flow: ProviderSecurityFlow }[] = [];
          for (const carrier of carriers) {
            try {
              const key = carrier.name.slice(prefix.length);
              const flow = await openProviderSecurityFlow(carrier.content, key, environment.NEXTAUTH_SECRET ?? '');
              if (flow.providerFlowHash === hash || flow.googleFlowHash === hash) matching.push({ key, flow });
            } catch {
              /* unrelated expired/invalid carriers supply no dispatch authority */
            }
          }
          if (matching.length > 1) return invalid();
          if (!located) return matching.length === 0 ? { status: 'ordinary-unqualified' } : invalid();
          if (matching.length !== 1 || matching[0].key !== located.operationKey) return invalid();
        }
        const carrier = observed.filter(
          (cookie) => cookie.name === providerSecurityFlowCookieName(located.operationKey, true),
        );
        if (carrier.length !== 1) return invalid();
        const flow = await openProviderSecurityFlow(
          carrier[0].content,
          located.operationKey,
          environment.NEXTAUTH_SECRET ?? '',
        );
        if (action === 'callback') {
          const google = provider === 'google' && flow.googleFlowHash === hash;
          const link = flow.provider === provider && flow.providerFlowHash === hash;
          if (google === link) return invalid();
          purpose = google ? 'reauthenticate-google' : 'link';
        }
        if (purpose === 'reauthenticate-google') {
          if (
            provider !== 'google' ||
            flow.providerFlowHash !== null ||
            (action === 'signin' && flow.googleFlowHash !== null)
          )
            return invalid();
        } else if (purpose === 'link') {
          if (
            flow.action !== 'link' ||
            flow.provider !== provider ||
            flow.reauthenticationToken === null ||
            flow.reauthenticationExpiresAt === null ||
            Date.parse(flow.reauthenticationExpiresAt) <= Date.now() ||
            (action === 'signin' && flow.providerFlowHash !== null)
          )
            return invalid();
        } else return invalid();
        if (signal.aborted) return invalid();
        const selected = await readSelection(header);
        if (selected.status === 'unavailable') return { status: 'refused', reason: 'unavailable' };
        if (selected.status !== 'admitted') return { status: 'refused', reason: 'identity_changed' };
        const actor = captureProviderBrowserContext(selected);
        requireProviderSecurityFlowActor(flow, actor);
        if (
          signal.aborted ||
          Date.parse(flow.expiresAt) <= Date.now() ||
          (purpose === 'link' && Date.parse(flow.reauthenticationExpiresAt!) <= Date.now())
        )
          return invalid();
        return Object.freeze({
          status: 'explicit',
          purpose,
          provider,
          flow,
          actor,
          flowHash: hash,
          returnUrl: providerSecurityResumeUrl(origin, located.operationKey, located.locale),
        });
      } catch (error) {
        return {
          status: 'refused',
          reason:
            error instanceof ProviderSecurityIdentityChangedError
              ? 'identity_changed'
              : error instanceof InvalidRequest
                ? 'invalid_request'
                : 'unavailable',
        };
      }
    },
  });
}

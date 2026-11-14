import { vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import { createBrowserHttpClientFacade } from '../../http-client-facade.web';
import { createBrowserHttpOperations } from '../../http-operation-client.web';
import { createHttpQueryScope } from '../../http-query-scope';

let namespace = 0;

/** Real HTTP decoder, facade, lease manager and original-delivery operations.
 * Only the owned lease issuer and GraphQL endpoint are injected. */
export function createScopedHttpFixture() {
  let clock = 0;
  let generation = 0;
  let anonymous = false;
  let owner: BrowserBackendLeaseOwner = {
    userId: 'owned-A',
    authSessionId: 'owned-SID-A',
    generation: 1,
    cursor: { bindingId: 'a'.repeat(64), version: 2 },
  };
  const issueLease = vi.fn(async () =>
    Response.json({ status: 'admitted', token: 'bsbd1_OWNED_TEST_ONLY', usableForMs: 120_000, owner }),
  );
  const backend = createBrowserBackendClient({
    ready: () => true,
    endpoint: '/owned-lease',
    fetch: issueLease,
    now: () => clock,
    schedule: () => () => {},
  });
  const accept = () =>
    backend.acceptSession({
      user: { id: owner.userId },
      authSessionId: owner.authSessionId,
      authGeneration: owner.generation,
      expires: '2099-01-01T00:00:00.000Z',
      browserSelection: owner,
    });
  accept();
  const performFetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({ data: { viewer: { id: owner.userId } } }),
  );
  const facade = createBrowserHttpClientFacade({
    backendClient: backend,
    captureGeneration: () => generation,
    isGenerationCurrent: (expected) => expected === generation,
    captureIdentity: () =>
      anonymous
        ? null
        : {
            userId: owner.userId,
            authSessionId: owner.authSessionId,
            browserSelection: owner,
          },
    confirmedAnonymous: () => anonymous,
    required: () => true,
    namespace: () => `owned_query_fixture_${++namespace}`,
    url: 'https://backend.owned.test/graphql',
    fetch: performFetch,
    legacyFetch: performFetch,
    timeoutMs: () => 20_000,
    clientIdentity: () => 'owned-query-fixture',
    legacy: {
      get: () => {
        throw new Error('Legacy fallback must not run');
      },
      reset: () => {},
    },
  });
  const operations = createBrowserHttpOperations({
    captureScope: facade.captureRequestView,
    isCurrentView: facade.isCurrentView,
    captureResult: facade.captureResult,
    resolveClient: (scope) => facade.getHttpClient(scope),
  });
  return {
    backend,
    issueLease,
    performFetch,
    scope() {
      const scope = facade.captureRequestView();
      return createHttpQueryScope({
        scope,
        scoped: true,
        prefix: facade.queryKey([], scope),
        isCurrentView: facade.isCurrentView,
        createOperation: (options) => operations.create(scope, options),
      });
    },
    clock(next: number) {
      clock = next;
    },
    switchAccount(userId: string) {
      owner = { ...owner, userId };
      anonymous = false;
      accept();
    },
    confirmAnonymous() {
      anonymous = true;
      backend.acceptSession({});
    },
    nextGeneration() {
      generation += 1;
    },
    dispose() {
      facade.dispose();
      backend.dispose();
    },
  };
}

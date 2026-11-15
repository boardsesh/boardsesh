// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
vi.mock('server-only', () => ({}));
import {
  buildBrowserProofCookieCandidate,
  browserProofCookieName,
  readBrowserProofCookie,
} from '../browser-proof-cookies.server';
import {
  browserPasswordCustodySchema,
  buildBrowserPasswordCustodyCookies,
  sealBrowserPasswordCustody,
} from '../browser-password-custody.server';
import {
  preparePasswordConfirmationResponse,
  preparePasswordTargetResponse,
} from '../browser-password-publication.server';
import { browserPasswordFixture, passwordTestEnvironment } from './fixtures/browser-password';

function fixture() {
  const current = browserPasswordFixture();
  const custody = browserPasswordCustodySchema.parse({
    version: 1,
    purpose: 'boardsesh-browser-password-candidate-custody-v1',
    operationKey: current.preparation.nonceHash,
    canonicalOrigin: passwordTestEnvironment.NEXTAUTH_URL,
    source: current.source,
    operationToken: current.operationToken,
    browserIntentToken: current.browserIntentToken,
    preparation: current.preparation,
    candidate: current.candidate,
    destination: 'https://www.boardsesh.test/settings',
  });
  if (current.source.state !== 'selected') throw new Error('Expected selected source');
  const sourceHeaders = buildBrowserProofCookieCandidate({
    cursor: { bindingId: custody.preparation.browserCursor.bindingId, version: 7 },
    proof: {
      kind: 'canonical-token',
      rawCredential:
        current.source.actor.credential.kind === 'canonical-token'
          ? current.source.actor.credential.token
          : current.source.actor.credential.credential,
    },
    proofMaxAgeSeconds: 3_600,
    observedCookieHeader: null,
    retainObservedProofCookies: true,
  }).headers;
  const custodyHeaders = buildBrowserPasswordCustodyCookies(
    custody,
    sealBrowserPasswordCustody(custody, passwordTestEnvironment.NEXTAUTH_SECRET),
    null,
  );
  const observed = ['unrelated=preserved', ...sourceHeaders, ...custodyHeaders]
    .map((header) => header.split(';', 1)[0])
    .join('; ');
  return { current, custody, observed, sourceHeaders, custodyHeaders };
}
describe('prebuilt whole-response password publication', () => {
  it('prebuilds the exact target proof while preserving original source and custody', async () => {
    const current = fixture();
    const prepared = preparePasswordTargetResponse(current.custody, current.observed);
    const target = { bindingId: current.custody.preparation.futureBrowserCursor.bindingId, version: 8 };
    expect(await prepared.response.json()).toEqual({
      status: 'committed',
      operationKey: current.custody.operationKey,
      cursor: target,
    });
    expect(prepared.response.headers.get('cache-control')).toBe('private, no-store');
    expect(prepared.response.headers.get('x-robots-tag')).toBe('noindex, follow');
    expect(readBrowserProofCookie(prepared.projectedCookieHeader, target)).toEqual({
      status: 'present',
      proof: { kind: 'canonical-token', rawCredential: current.current.proposedCanonicalToken },
    });
    expect(prepared.projectedCookieHeader).toContain('unrelated=preserved');
    for (const header of [...current.sourceHeaders, ...current.custodyHeaders])
      expect(prepared.projectedCookieHeader).toContain(header.split(';', 1)[0]);
    expect(
      prepared.response.headers.getSetCookie().every((header) => header.startsWith(browserProofCookieName(target))),
    ).toBe(true);
  });
  it('refuses whole-request capacity before an irreversible finalizer can run', () => {
    const current = fixture();
    expect(() =>
      preparePasswordTargetResponse(current.custody, current.observed + '; padding=' + 'a'.repeat(8_192)),
    ).toThrow();
  });
  it('budgets observed complete custody clearing without deleting old proof families', async () => {
    const current = fixture();
    const response = preparePasswordConfirmationResponse(
      current.custody,
      current.observed + '; padding=' + 'a'.repeat(4_000),
    );
    expect((await response.json()).status).toBe('confirmed');
    expect(response.headers.getSetCookie()).toEqual(
      current.custodyHeaders.map(
        (header) => header.split('=', 1)[0] + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      ),
    );
    expect(response.headers.getSetCookie().join('; ')).not.toContain('browser-proof');
  });
});

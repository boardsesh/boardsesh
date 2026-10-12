import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CONSENT_REGION_EDGE_HEADER_NAME } from '@boardsesh/consent';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import type * as GraphQLModule from 'graphql';
import { schema } from '../graphql';
import { buildHttpConnectionContext } from '../graphql/yoga';
import { resolveConsentRegion } from '../graphql/resolvers/users/analytics-consent';

// A static `import { graphql }` gets the ESM copy, while the schema was built
// with the CJS copy `@graphql-tools/schema` loaded ("Cannot use GraphQLSchema
// from another module"). Reach the backend's copy, as spray-visibility-sweep does.
const { graphql } = createRequire(import.meta.url)('graphql') as typeof GraphQLModule;

/**
 * The analytics prompt is shown only where GDPR (or a copy of it) applies, and
 * the backend is the one place that can tell: it reads Cloudflare's country
 * from a trusted edge hop. Anything it cannot trust must come back "ask".
 */

const CLOUDFLARE_PEER = '173.245.48.10';
const RAILWAY_INGRESS_PEER = '10.0.0.5';
const PUBLIC_PEER = '203.0.113.7';

function nodeRequest(remoteAddress: string, headers: Record<string, string>): IncomingMessage {
  return { headers, url: '/graphql', socket: { remoteAddress } } as unknown as IncomingMessage;
}

async function askRegion(remoteAddress: string | null, headers: Record<string, string>) {
  const context = await buildHttpConnectionContext({
    request: new Request('http://backend.test/graphql', { method: 'POST', headers }),
    req: remoteAddress === null ? undefined : nodeRequest(remoteAddress, headers),
  });
  const result = await graphql({
    schema,
    source: 'query { consentRegion { countryCode promptRequired } }',
    contextValue: context,
  });
  expect(result.errors).toBeUndefined();
  return (result.data as { consentRegion: { countryCode: string | null; promptRequired: boolean } }).consentRegion;
}

describe('consentRegion', () => {
  beforeEach(() => vi.stubEnv('BOARDSESH_TRUST_EDGE_REGION_HEADER', 'false'));
  afterEach(() => vi.unstubAllEnvs());

  it('ignores caller-written custom province before the edge rule is enabled', async () => {
    await expect(
      askRegion(CLOUDFLARE_PEER, {
        host: 'ws.boardsesh.com',
        'cf-ipcountry': 'CA',
        [CONSENT_REGION_EDGE_HEADER_NAME]: 'ON',
      }),
    ).resolves.toEqual({ countryCode: 'CA', promptRequired: true });
  });

  it.each([
    [CLOUDFLARE_PEER, 'ws.boardsesh.com', 'ON', 'CA', false],
    [CLOUDFLARE_PEER, 'ws.boardsesh.com', 'QC', 'CA', true],
    [CLOUDFLARE_PEER, 'ws.boardsesh.com', '', 'CA', true],
    [CLOUDFLARE_PEER, 'other.example.com', 'ON', 'CA', true],
    [PUBLIC_PEER, 'ws.boardsesh.com', 'ON', null, true],
  ])(
    'uses the configured custom header only on the trusted GraphQL host (%s, %s, %s)',
    async (peer, host, regionCode, countryCode, promptRequired) => {
      vi.stubEnv('BOARDSESH_TRUST_EDGE_REGION_HEADER', 'true');
      await expect(
        askRegion(peer, {
          host,
          'cf-ipcountry': 'CA',
          [CONSENT_REGION_EDGE_HEADER_NAME]: regionCode,
        }),
      ).resolves.toEqual({ countryCode, promptRequired });
    },
  );

  it('ignores the configured custom header outside the exact GraphQL route', async () => {
    vi.stubEnv('BOARDSESH_TRUST_EDGE_REGION_HEADER', 'true');
    const headers = {
      host: 'ws.boardsesh.com',
      'cf-ipcountry': 'CA',
      [CONSENT_REGION_EDGE_HEADER_NAME]: 'ON',
    };
    const request = nodeRequest(CLOUDFLARE_PEER, headers);
    request.url = '/flags/';
    const context = await buildHttpConnectionContext({
      request: new Request('http://backend.test/flags/', { method: 'POST', headers }),
      req: request,
    });
    expect(context.edgeRegionCode).toBeUndefined();
    expect(resolveConsentRegion(context).promptRequired).toBe(true);
  });

  it.each(['false', 'true'])(
    'ignores a forged native province when the custom header is absent (gate %s)',
    async (gate) => {
      vi.stubEnv('BOARDSESH_TRUST_EDGE_REGION_HEADER', gate);
      await expect(
        askRegion(CLOUDFLARE_PEER, {
          host: 'ws.boardsesh.com',
          'cf-ipcountry': 'CA',
          'cf-region-code': 'ON',
        }),
      ).resolves.toEqual({ countryCode: 'CA', promptRequired: true });
    },
  );

  it.each([
    ['false', 'ON', 'ON', true],
    ['true', 'ON', 'QC', true],
    ['true', 'QC', 'ON', false],
  ])(
    'uses only the gated custom province when a native header is forged (gate %s, native %s, custom %s)',
    async (gate, nativeRegion, customRegion, promptRequired) => {
      vi.stubEnv('BOARDSESH_TRUST_EDGE_REGION_HEADER', gate);
      await expect(
        askRegion(CLOUDFLARE_PEER, {
          host: 'ws.boardsesh.com',
          'cf-ipcountry': 'CA',
          'cf-region-code': nativeRegion,
          [CONSENT_REGION_EDGE_HEADER_NAME]: customRegion,
        }),
      ).resolves.toEqual({ countryCode: 'CA', promptRequired });
    },
  );

  it('skips the prompt for a US visitor arriving through Cloudflare, signed out', async () => {
    await expect(askRegion(CLOUDFLARE_PEER, { 'cf-ipcountry': 'US' })).resolves.toEqual({
      countryCode: 'US',
      promptRequired: false,
    });
  });

  it('asks a German visitor arriving through Cloudflare', async () => {
    await expect(askRegion(CLOUDFLARE_PEER, { 'cf-ipcountry': 'DE' })).resolves.toEqual({
      countryCode: 'DE',
      promptRequired: true,
    });
  });

  it.each([
    ['QC', true],
    ['ON', false],
    ['BC', false],
    ['', true],
    ['qc', true],
    ['ZZ', true],
  ])('uses a trusted Canadian province %j to decide the prompt: %s', async (regionCode, promptRequired) => {
    vi.stubEnv('BOARDSESH_TRUST_EDGE_REGION_HEADER', 'true');
    await expect(
      askRegion(CLOUDFLARE_PEER, {
        host: 'ws.boardsesh.com',
        'cf-ipcountry': 'CA',
        [CONSENT_REGION_EDGE_HEADER_NAME]: regionCode,
      }),
    ).resolves.toEqual({ countryCode: 'CA', promptRequired });
  });

  it('asks Canadian visitors when the trusted province is missing', async () => {
    await expect(askRegion(CLOUDFLARE_PEER, { 'cf-ipcountry': 'CA' })).resolves.toEqual({
      countryCode: 'CA',
      promptRequired: true,
    });
  });

  it('accepts Quebec only behind the same trusted private ingress as the country', async () => {
    vi.stubEnv('BOARDSESH_TRUST_EDGE_REGION_HEADER', 'true');
    await expect(
      askRegion(RAILWAY_INGRESS_PEER, {
        host: 'ws.boardsesh.com',
        'cf-ipcountry': 'CA',
        [CONSENT_REGION_EDGE_HEADER_NAME]: 'QC',
        'x-forwarded-for': `198.51.100.4, ${CLOUDFLARE_PEER}`,
      }),
    ).resolves.toEqual({ countryCode: 'CA', promptRequired: true });
  });

  it.each([
    [PUBLIC_PEER, {}],
    [RAILWAY_INGRESS_PEER, { 'x-forwarded-for': `${CLOUDFLARE_PEER}, ${PUBLIC_PEER}` }],
  ])('does not trust a caller-authored Canadian province through %s', async (peer, forwarded) => {
    const headers = { 'cf-ipcountry': 'CA', 'cf-region-code': 'ON', ...forwarded };
    const context = await buildHttpConnectionContext({
      request: new Request('http://backend.test/graphql', { method: 'POST', headers }),
      req: nodeRequest(peer, headers),
    });
    expect(context.edgeRegionCode).toBeUndefined();
    expect(resolveConsentRegion(context)).toEqual({
      countryCode: null,
      promptRequired: true,
      globalPrivacyControl: false,
    });
  });

  it.each(['AD', 'MC', 'SM', 'VA', 'FO'])('asks in added jurisdiction %s', async (country) => {
    await expect(askRegion(CLOUDFLARE_PEER, { 'cf-ipcountry': country })).resolves.toEqual({
      countryCode: country,
      promptRequired: true,
    });
  });

  it('trusts the country behind our private ingress when its last hop is Cloudflare', async () => {
    await expect(
      askRegion(RAILWAY_INGRESS_PEER, { 'cf-ipcountry': 'AU', 'x-forwarded-for': `198.51.100.4, ${CLOUDFLARE_PEER}` }),
    ).resolves.toEqual({ countryCode: 'AU', promptRequired: false });
  });

  it('asks when a direct-origin caller forges a non-GDPR country', async () => {
    await expect(askRegion(PUBLIC_PEER, { 'cf-ipcountry': 'US' })).resolves.toEqual({
      countryCode: null,
      promptRequired: true,
    });
  });

  it('asks when only a client-authored forwarded hop claims to be Cloudflare', async () => {
    await expect(
      askRegion(RAILWAY_INGRESS_PEER, {
        'cf-ipcountry': 'US',
        'x-forwarded-for': `${CLOUDFLARE_PEER}, ${PUBLIC_PEER}`,
      }),
    ).resolves.toEqual({ countryCode: null, promptRequired: true });
  });

  it.each(['XX', 'T1', 'AB', 'AP', 'us', ''])('asks when Cloudflare reports %j', async (country) => {
    await expect(askRegion(CLOUDFLARE_PEER, { 'cf-ipcountry': country })).resolves.toEqual({
      countryCode: null,
      promptRequired: true,
    });
  });

  it('asks when Cloudflare sends no country at all', async () => {
    await expect(askRegion(CLOUDFLARE_PEER, {})).resolves.toEqual({ countryCode: null, promptRequired: true });
  });

  it('asks when there is no Node request to trust (yoga.fetch)', async () => {
    await expect(askRegion(null, { 'cf-ipcountry': 'US' })).resolves.toEqual({
      countryCode: null,
      promptRequired: true,
    });
  });

  it('asks on a context with no edge country, such as a WebSocket operation', () => {
    expect(resolveConsentRegion({})).toEqual({ countryCode: null, promptRequired: true, globalPrivacyControl: false });
  });

  it.each([
    [{ 'sec-gpc': '1' }, true],
    [{ 'sec-gpc': '0' }, false],
    [{}, false],
  ])('echoes the Global Privacy Control header %j as %s', async (gpcHeader, expected) => {
    const headers = { 'cf-ipcountry': 'US', ...gpcHeader };
    const context = await buildHttpConnectionContext({
      request: new Request('http://backend.test/graphql', { method: 'POST', headers }),
      req: nodeRequest(CLOUDFLARE_PEER, headers),
    });
    const result = await graphql({
      schema,
      source: 'query { consentRegion { promptRequired globalPrivacyControl } }',
      contextValue: context,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ consentRegion: { promptRequired: false, globalPrivacyControl: expected } });
  });
});

import { describe, expect, it, vi } from 'vite-plus/test';
import type { IncomingMessage } from 'node:http';
import { createYogaInstance } from '../graphql/yoga';

const countryLookup = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Consent must not look up a location');
  }),
);
vi.mock('../utils/flag-country', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/flag-country')>()),
  resolveFlagCountry: countryLookup,
}));

// The exact operation sent by released native/browser bundles. Keep all three
// response fields until embedded and rollback bundles no longer depend on it.
const RELEASED_CONSENT_REGION_QUERY = `
  query GetConsentRegion {
    consentRegion {
      countryCode
      promptRequired
      globalPrivacyControl
    }
  }
`;

describe('consentRegion compatibility for installed app bundles', () => {
  it.each<Record<string, string>>([
    {},
    { 'cf-ipcountry': 'US' },
    { 'cf-ipcountry': 'DE' },
    { 'cf-ipcountry': 'CA', 'x-boardsesh-region-code': 'ON' },
    { 'cf-ipcountry': 'CA', 'x-boardsesh-region-code': 'QC' },
    { 'cf-ipcountry': 'XX' },
    { 'cf-ipcountry': 'US', 'sec-gpc': '1' },
  ])('validates the anonymous released query and always asks, ignoring %j', async (headers) => {
    // Supply a trusted Node peer as well as Fetch headers. Without it, the old
    // country-based implementation would also ask because its location was unknown.
    const nodeRequest = {
      headers: { host: 'ws.boardsesh.com', ...headers },
      url: '/graphql',
      socket: { remoteAddress: '173.245.48.10' },
    } as unknown as IncomingMessage;
    const response = await createYogaInstance().fetch(
      'http://localhost/graphql',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ query: RELEASED_CONSENT_REGION_QUERY }),
      },
      { req: nodeRequest },
    );

    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    expect(payload).toEqual({
      data: { consentRegion: { countryCode: null, promptRequired: true, globalPrivacyControl: false } },
    });
    // A successful true is what clears the stored default in old clients. A
    // failed/unknown lookup would leave them unprompted; false would grant it.
    expect(countryLookup).not.toHaveBeenCalled();
  });
});

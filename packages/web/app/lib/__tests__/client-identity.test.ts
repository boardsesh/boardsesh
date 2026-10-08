import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { parseClientIdentity } from '@boardsesh/shared-schema/client-identity';
import {
  getWebClientIdentity,
  WEB_CLIENT_VERSION,
  webClientIdentityConnectionParams,
  webClientIdentityHeaders,
} from '../client-identity';

describe('web client identity', () => {
  it('pins the version to packages/web/package.json', () => {
    const packageJson = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../package.json'), 'utf8')) as {
      version: string;
    };

    expect(WEB_CLIENT_VERSION).toBe(packageJson.version);
  });

  it('identifies browser calls without a platform', () => {
    // The default test environment is jsdom, so `window` exists here.
    expect(getWebClientIdentity()).toBe(`boardsesh-web/${WEB_CLIENT_VERSION}`);
    expect(parseClientIdentity(getWebClientIdentity())).toEqual({ name: 'boardsesh-web', version: WEB_CLIENT_VERSION });
  });

  it('marks calls made from the Next server', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(getWebClientIdentity()).toBe(`boardsesh-web/${WEB_CLIENT_VERSION} (server)`);
      expect(parseClientIdentity(getWebClientIdentity())?.platform).toBe('server');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('exposes the header and connectionParams shapes', () => {
    expect(webClientIdentityHeaders()).toEqual({ 'x-boardsesh-client': `boardsesh-web/${WEB_CLIENT_VERSION}` });
    expect(webClientIdentityConnectionParams()).toEqual({ clientIdentity: `boardsesh-web/${WEB_CLIENT_VERSION}` });
  });
});

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { DEVICE_TOKEN_SECRET_ENV, verifyDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { logger } from '../../utils/logger';
import {
  __resetDeviceTokenStateForTests,
  mintNativeDeviceToken,
  verifyPresentedDeviceToken,
  withNativeDeviceToken,
} from '../device-token';

const secret = randomBytes(32).toString('hex');
const environment = { [DEVICE_TOKEN_SECRET_ENV]: secret };
const reply = { userId: 'user-a', jwt: 'jwt', refreshToken: 'refresh', expiresAt: '2099-01-01T00:00:00.000Z' };

describe('native device tokens (#7656)', () => {
  beforeEach(() => __resetDeviceTokenStateForTests());
  afterEach(() => vi.restoreAllMocks());

  it('adds a token for the reply user and leaves every other field as it was', async () => {
    const withToken = await withNativeDeviceToken(reply, environment);
    const { deviceToken, ...rest } = withToken;
    expect(rest).toEqual(reply);
    expect(await verifyDeviceToken(deviceToken, { userId: 'user-a', secret })).not.toBeNull();
    expect(await verifyPresentedDeviceToken(deviceToken, 'user-a', environment)).not.toBeNull();
    // A token for account A gives nothing for account B.
    expect(await verifyPresentedDeviceToken(deviceToken, 'user-b', environment)).toBeNull();
  });

  it('adds nothing while the secret is unset, and reads every token as absent', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    expect(await withNativeDeviceToken(reply, {})).toBe(reply);
    expect(await mintNativeDeviceToken('user-a', {})).toBeUndefined();
    const minted = await mintNativeDeviceToken('user-a', environment);
    expect(await verifyPresentedDeviceToken(minted, 'user-a', {})).toBeNull();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('treats a short or reused secret as off, logging its name once and never its value', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const reused = { [DEVICE_TOKEN_SECRET_ENV]: secret, NEXTAUTH_SECRET: secret };
    expect(await withNativeDeviceToken(reply, reused)).toBe(reply);
    expect(await withNativeDeviceToken(reply, { [DEVICE_TOKEN_SECRET_ENV]: 'short' })).toBe(reply);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0][0]).toContain(DEVICE_TOKEN_SECRET_ENV);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
  });

  it('reads forged and malformed presented tokens as absent', async () => {
    for (const presented of [undefined, '', 'v1.forged', `v1.${'A'.repeat(22)}.1795000000.${'B'.repeat(43)}`])
      expect(await verifyPresentedDeviceToken(presented, 'user-a', environment)).toBeNull();
  });
});

describe('device token codec boundary', () => {
  const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const deviceTokenCodecModule = /['"`][^'"`]*\/device-token(?:\.[cm]?[jt]sx?)?(?:[?#][^'"`]*)?['"`]/;

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx|js|jsx)$/.test(entry.name) ? [path] : [];
    });
  }

  it('stays a server-only subpath: not in the protocol index, never imported by the app', () => {
    const protocolIndex = readFileSync(join(repositoryRoot, 'packages/shared/auth-protocol/src/index.ts'), 'utf8');
    expect(protocolIndex).not.toMatch(deviceTokenCodecModule);
    // The phone stores and returns the string; minting and verifying stay with the web and backend.
    const importers = ['src', 'app']
      .flatMap((folder) => sourceFiles(join(repositoryRoot, 'packages/mobile', folder)))
      .filter((path) => readFileSync(path, 'utf8').includes('auth-protocol/device-token'));
    expect(importers).toEqual([]);
  });

  it.each([
    "export * from './device-token';",
    "export { verifyDeviceToken } from './device-token.js';",
    "import { mintDeviceToken } from '@boardsesh/auth-protocol/device-token';",
    "import('./device-token');",
    "require('./device-token.cjs');",
    'import(`./device-token`);',
    "export * from './device-token.ts?raw';",
    "import('./device-token.js#codec');",
    "export * from './device-token.tsx';",
  ])('rejects a codec module reference: %s', (source) => {
    expect(source).toMatch(deviceTokenCodecModule);
  });

  it('allows an HTTP capability name without exposing the codec', () => {
    expect("export const header = 'x-boardsesh-reset-device-token';").not.toMatch(deviceTokenCodecModule);
  });
});

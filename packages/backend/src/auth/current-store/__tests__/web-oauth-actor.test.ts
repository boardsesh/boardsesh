import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vite-plus/test';
import { decryptLegacyWebJwe } from '../../legacy-web-jwe';
import { readNegativeWebOAuthActor } from '../web-oauth-actor';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(options: { token: Record<string, unknown>; secret: string; maxAge?: number }): Promise<string>;
  decode(options: { token: string; secret: string }): Promise<Record<string, unknown> | null>;
};
const secret = randomBytes(32).toString('base64url');
const encode = (claims: Record<string, unknown>, maxAge = 3600) => jwt.encode({ token: claims, secret, maxAge });

describe('negative web OAuth actor from the actual public NextAuth encoder', () => {
  it('accepts explicit absence only and never derives fresh authentication age', async () => {
    expect(await readNegativeWebOAuthActor(null, secret)).toBe(null);
    const actor = await readNegativeWebOAuthActor(
      await encode({ sub: 'owner', authSessionId: 'sid', auth_time: Date.now() }),
      secret,
    );
    expect(actor?.userId).toBe('owner');
    expect(Object.keys(actor ?? {}).sort()).toEqual(['expiresAtSeconds', 'lineageHash', 'userId']);
  });
  it('accepts nonce-changing rotations of one signed session lineage', async () => {
    const first = await encode({ sub: 'owner', authSessionId: 'sid' });
    const second = await encode({ sub: 'owner', authSessionId: 'sid' });
    expect(first !== second).toBe(true);
    expect((await readNegativeWebOAuthActor(first, secret))?.lineageHash).toBe(
      (await readNegativeWebOAuthActor(second, secret))?.lineageHash,
    );
    expect(
      (await readNegativeWebOAuthActor(first, secret))?.lineageHash !==
        (await readNegativeWebOAuthActor(await encode({ sub: 'owner', authSessionId: 'other' }), secret))?.lineageHash,
    ).toBe(true);
  });
  it('matches signed original jti with a rotation carrying that same explicit lineage', async () => {
    const first = await encode({ sub: 'owner' });
    const original = await jwt.decode({ token: first, secret });
    const second = await encode({ sub: 'owner', authSessionId: original?.jti });
    expect((await readNegativeWebOAuthActor(first, secret))?.lineageHash).toBe(
      (await readNegativeWebOAuthActor(second, secret))?.lineageHash,
    );
    // Shipping jwt-callback transition is separately exercised by AppRouter tests.
  });
  it('matches actual NextAuth15s expiry grace without changing middleware60s', async () => {
    const within = await encode({ sub: 'owner', authSessionId: 'sid' }, -5);
    expect((await jwt.decode({ token: within, secret }))?.sub).toBe('owner');
    expect((await readNegativeWebOAuthActor(within, secret))?.userId).toBe('owner');
    const older = await encode({ sub: 'owner', authSessionId: 'sid' }, -30);
    await expect(readNegativeWebOAuthActor(older, secret)).rejects.toThrow('Invalid web OAuth actor');
    expect((await decryptLegacyWebJwe(older, secret, 60)).payload.sub).toBe('owner');
  });
  it('never accepts a valid native JWS as a browser actor', async () => {
    const token = await new SignJWT({ sub: 'owner' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(new TextEncoder().encode(secret));
    await expect(readNegativeWebOAuthActor(token, secret)).rejects.toThrow('Invalid web OAuth actor');
  });
  it('rejects wrong key and modified ciphertext without anonymous fallback', async () => {
    const token = await encode({ sub: 'owner', authSessionId: 'sid' });
    await expect(readNegativeWebOAuthActor(token, randomBytes(32).toString('base64url'))).rejects.toThrow(
      'Invalid web OAuth actor',
    );
    const parts = token.split('.');
    parts[3] = `${parts[3].startsWith('A') ? 'B' : 'A'}${parts[3].slice(1)}`;
    await expect(readNegativeWebOAuthActor(parts.join('.'), secret)).rejects.toThrow('Invalid web OAuth actor');
  });
  it.each([undefined, '', ' ', 42, '\ud800'])('rejects malformed signed subject %s', async (sub) => {
    await expect(readNegativeWebOAuthActor(await encode({ sub, authSessionId: 'sid' }), secret)).rejects.toThrow(
      'Invalid web OAuth actor',
    );
  });
  it.each([null, '', 42, '\ud800'])(
    'rejects malformed present session ID %s rather than using jti',
    async (authSessionId) => {
      await expect(readNegativeWebOAuthActor(await encode({ sub: 'owner', authSessionId }), secret)).rejects.toThrow(
        'Invalid web OAuth actor',
      );
    },
  );
  it.each(['sourceProof', 'currentStoreWebSource', 'authPublication', 'webSessionSource'])(
    'rejects reserved source marker %s',
    async (marker) => {
      await expect(
        readNegativeWebOAuthActor(await encode({ sub: 'owner', authSessionId: 'sid', [marker]: {} }), secret),
      ).rejects.toThrow('Invalid web OAuth actor');
    },
  );
});

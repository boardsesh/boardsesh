import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { oauthConnections, oauthRefreshToken, oauthVerification } from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { disconnectPartnerConnection } from '../connection';
import {
  clientCredentials,
  createPartnerTestEnvironment,
  postForm,
  TEST_CONFIGURATION,
  TEST_ISSUER,
  TEST_OAUTH_OPTIONS,
  TEST_RESOURCE,
  TEST_SESSION_HEADER,
  type PartnerTestEnvironment,
  type TestClient,
} from './partner-fixture';

const hashOf = (value: string) => createHash('sha256').update(value).digest('base64url');

/**
 * Hooks read the request before the provider parses it. Every test here is a
 * value the two could read differently, and the guards must decide on what the
 * provider will act on.
 */
describe('guards decide on the value the provider acts on', () => {
  let environment: PartnerTestEnvironment;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
  });

  afterAll(async () => {
    await environment?.close();
  });

  const tokenForm = (client: TestClient, fields: Record<string, string>) =>
    new URLSearchParams({ ...fields, ...clientCredentials(client) });

  const postToken = (fields: Record<string, string> | URLSearchParams) =>
    postForm(environment.instance, '/oauth2/token', fields);

  const codeOf = (location: string | null) => {
    const code = new URL(location!).searchParams.get('code');
    if (!code) throw new Error(`Expected a code in ${location}`);
    return code;
  };

  async function revokeConnection(client: TestClient) {
    await db
      .update(oauthConnections)
      .set({ revokedAt: new Date() })
      .where(eq(oauthConnections.clientId, client.clientId));
  }

  async function pendingCodeRows(code: string) {
    return db
      .select()
      .from(oauthVerification)
      .where(eq(oauthVerification.identifier, hashOf(code)));
  }

  describe('grant_type whitespace, which the provider trims after hooks run', () => {
    it.each(['refresh_token ', ' refresh_token', 'refresh_token\t', 'refresh_token\n', ' refresh_token'])(
      'refuses %j on a revoked connection instead of issuing',
      async (grantType) => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        await revokeConnection(client);
        const refused = await postToken(
          tokenForm(client, { grant_type: grantType, refresh_token: issued.refresh_token! }),
        );
        expect(refused.response.status).toBe(400);
        expect(refused.body.error).toBe('invalid_request');
        expect(refused.body.access_token).toBeUndefined();
      },
    );

    it.each(['authorization_code ', ' authorization_code', 'authorization_code\t'])(
      'refuses %j on a revoked connection and leaves the code unconsumed',
      async (grantType) => {
        const client = await environment.createClient();
        const authorization = await environment.authorize(client);
        await revokeConnection(client);
        const refused = await postToken(
          tokenForm(client, {
            grant_type: grantType,
            code: codeOf(authorization.location),
            code_verifier: authorization.verifier,
            redirect_uri: client.redirectUri,
          }),
        );
        expect(refused.body.error).toBe('invalid_request');
        expect(refused.body.access_token).toBeUndefined();
        expect(await pendingCodeRows(codeOf(authorization.location))).toHaveLength(1);
      },
    );

    it('a spaced replay of a consumed token closes no family', async () => {
      const client = await environment.createClient();
      const firstGrant = await environment.issueTokens(client);
      const independentGrant = await environment.issueTokens(client);
      const rotated = await environment.refresh(client, firstGrant.refresh_token!);
      expect(rotated.response.status).toBe(200);
      const replay = await postToken(
        tokenForm(client, { grant_type: 'refresh_token\t', refresh_token: firstGrant.refresh_token! }),
      );
      expect(replay.body.error).toBe('invalid_request');
      expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(true);
      expect((await environment.introspect(client, independentGrant.access_token)).body.active).toBe(true);
    });

    it('another app cannot burn a code with a spaced grant_type', async () => {
      const client = await environment.createClient();
      const otherClient = await environment.createClient();
      const authorization = await environment.authorize(client);
      const burned = await postToken(
        tokenForm(otherClient, {
          grant_type: 'authorization_code ',
          code: codeOf(authorization.location),
          code_verifier: authorization.verifier,
          redirect_uri: client.redirectUri,
        }),
      );
      expect(burned.body.error).toBe('invalid_request');
      expect((await environment.exchange(client, authorization)).response.status).toBe(200);
    });

    it.each([
      ['GRANT_TYPE', 'refresh_token'],
      ['Grant_Type', 'refresh_token'],
      ['grant_type', 'REFRESH_TOKEN'],
    ])('a case variant %s=%s issues nothing and leaves the token current', async (name, grantValue) => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const refused = await postToken(tokenForm(client, { [name]: grantValue, refresh_token: issued.refresh_token! }));
      expect(refused.response.status).toBe(400);
      expect(refused.body.access_token).toBeUndefined();
      expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
    });
  });

  describe('repeated form parameters', () => {
    it.each(['grant_type', 'refresh_token', 'scope', 'client_id'])('refuses a repeated %s', async (name) => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const form = tokenForm(client, {
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token!,
        scope: 'profile:read offline_access',
      });
      form.append(name, form.get(name)!);
      const refused = await postToken(form);
      expect(refused.response.status).toBe(400);
      expect(refused.body.error).toBe('invalid_request');
      expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
    });

    it('refuses a repeated code before it can be consumed', async () => {
      const client = await environment.createClient();
      const authorization = await environment.authorize(client);
      const code = codeOf(authorization.location);
      const form = tokenForm(client, {
        grant_type: 'authorization_code',
        code,
        code_verifier: authorization.verifier,
        redirect_uri: client.redirectUri,
      });
      form.append('code', code);
      expect((await postToken(form)).body.error).toBe('invalid_request');
      expect(await pendingCodeRows(code)).toHaveLength(1);
    });

    it.each(['token', 'token_type_hint'])('refuses a repeated %s on revoke and revokes nothing', async (name) => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const form = new URLSearchParams({
        token: issued.refresh_token!,
        token_type_hint: 'refresh_token',
        ...clientCredentials(client),
      });
      form.append(name, form.get(name)!);
      const refused = await postForm(environment.instance, '/oauth2/revoke', form);
      expect(refused.body.error).toBe('invalid_request');
      expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
    });

    it('still accepts a repeated resource, which RFC 8707 allows', async () => {
      const client = await environment.createClient();
      const authorization = await environment.authorize(client);
      const form = tokenForm(client, {
        grant_type: 'authorization_code',
        code: codeOf(authorization.location),
        code_verifier: authorization.verifier,
        redirect_uri: client.redirectUri,
        resource: TEST_RESOURCE,
      });
      form.append('resource', TEST_RESOURCE);
      expect((await postToken(form)).response.status).toBe(200);
    });
  });

  describe('body encodings', () => {
    const encodings = [
      ['application/json', () => JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'x' })],
      ['multipart/form-data; boundary=x', () => '--x--'],
      ['text/plain', () => 'grant_type=refresh_token'],
    ] as const;

    it.each(encodings)('token and revoke refuse %s before any guard runs', async (contentType, makeBody) => {
      for (const path of ['/oauth2/token', '/oauth2/revoke']) {
        const response = await environment.instance.handler(
          new Request(`${TEST_ISSUER}${path}`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: makeBody(),
          }),
        );
        expect(response.status).toBe(415);
      }
    });

    it('consent takes JSON only', async () => {
      const client = await environment.createClient({ skipConsent: false });
      const response = await environment.instance.handler(
        new Request(`${TEST_ISSUER}/oauth2/consent`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: TEST_CONFIGURATION.webOrigin,
            [TEST_SESSION_HEADER]: client.owner.sessionToken,
          },
          body: new URLSearchParams({ accept: 'true', oauth_query: 'client_id=x' }),
        }),
      );
      expect(response.status).toBe(415);
    });
  });

  describe('values the provider leaves untouched', () => {
    it('a spaced code is a different code, and the real one survives', async () => {
      const client = await environment.createClient();
      const authorization = await environment.authorize(client);
      const code = codeOf(authorization.location);
      const refused = await postToken(
        tokenForm(client, {
          grant_type: 'authorization_code',
          code: `${code} `,
          code_verifier: authorization.verifier,
          redirect_uri: client.redirectUri,
        }),
      );
      expect(refused.body.error).toBe('invalid_grant');
      expect(await pendingCodeRows(code)).toHaveLength(1);
    });

    it('a spaced refresh token is a different token, and the real one survives', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const refused = await postToken(
        tokenForm(client, { grant_type: 'refresh_token', refresh_token: `${issued.refresh_token!} ` }),
      );
      expect(refused.body.error).toBe('invalid_grant');
      expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
    });

    it('a spaced client_id is a different client', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const refused = await postToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token!,
          client_id: `${client.clientId} `,
          client_secret: client.clientSecret!,
        }),
      );
      expect(refused.body.error).toBe('invalid_client');
      expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
    });

    it.each(['REFRESH_TOKEN', ' refresh_token', 'nonsense'])(
      'token_type_hint %j does not change which family a consumed token closes',
      async (hint) => {
        const client = await environment.createClient();
        const firstGrant = await environment.issueTokens(client);
        const independentGrant = await environment.issueTokens(client);
        const rotated = await environment.refresh(client, firstGrant.refresh_token!);
        const revoked = await environment.revoke(client, {
          token: firstGrant.refresh_token!,
          token_type_hint: hint,
        });
        expect(revoked.response.status).toBe(200);
        expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(false);
        expect((await environment.introspect(client, independentGrant.access_token)).body.active).toBe(true);
      },
    );

    it.each(['ACCESS_TOKEN', ' access_token'])('token_type_hint %j still revokes an access token', async (hint) => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const revoked = await environment.revoke(client, { token: issued.access_token, token_type_hint: hint });
      expect(revoked.response.status).toBe(200);
      expect((await environment.introspect(client, issued.access_token)).body.active).toBe(false);
      expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
    });
  });

  describe('authorize parameters', () => {
    const formAuthorize = (client: TestClient, query = '') => {
      const verifier = randomBytes(32).toString('base64url');
      return environment.instance.handler(
        new Request(`${TEST_ISSUER}/oauth2/authorize${query}`, {
          method: 'POST',
          headers: {
            [TEST_SESSION_HEADER]: client.owner.sessionToken,
            origin: TEST_CONFIGURATION.webOrigin,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            response_type: 'code',
            client_id: client.clientId,
            redirect_uri: client.redirectUri,
            scope: 'profile:read offline_access',
            resource: TEST_RESOURCE,
            state: randomUUID(),
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
          }),
        }),
      );
    };

    async function disconnectedClient(owner?: TestClient['owner']) {
      const client = await environment.createClient(owner ? { owner } : {});
      await environment.issueTokens(client);
      await disconnectPartnerConnection(environment.database, {
        userId: client.owner.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      return client;
    }

    it('a form POST is decided by its body, never by a query parameter', async () => {
      const disconnected = await disconnectedClient();
      const connected = await environment.createClient({ owner: disconnected.owner });

      // Body names the live app, query names the disconnected one: the live app wins.
      const live = await formAuthorize(connected, `?client_id=${encodeURIComponent(disconnected.clientId)}`);
      expect(new URL(live.headers.get('location')!).searchParams.has('code')).toBe(true);

      // And the reverse: the fence must see the disconnected app in the body.
      const forced = await formAuthorize(disconnected, `?client_id=${encodeURIComponent(connected.clientId)}`);
      expect(forced.headers.get('location')).toContain(TEST_OAUTH_OPTIONS.consentPage);
      expect(new URL(forced.headers.get('location')!).searchParams.has('code')).toBe(false);
    });

    it('a repeated client_id on a GET is refused and leaves nothing behind', async () => {
      const client = await environment.createClient();
      const stranger = await environment.createClimber();
      const url = new URL(`${TEST_ISSUER}/oauth2/authorize`);
      url.searchParams.append('client_id', client.clientId);
      url.searchParams.append('client_id', client.clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', client.redirectUri);
      const response = await environment.instance.handler(
        new Request(url, { headers: { [TEST_SESSION_HEADER]: stranger.sessionToken } }),
      );
      expect(new URL(response.headers.get('location')!).searchParams.has('code')).toBe(false);
      expect(
        await db
          .select()
          .from(oauthConnections)
          .where(and(eq(oauthConnections.clientId, client.clientId), eq(oauthConnections.userId, stranger.userId))),
      ).toHaveLength(0);
    });

    it('a spaced client_id on authorize finds no app and leaves nothing behind', async () => {
      const client = await environment.createClient();
      const stranger = await environment.createClimber();
      const url = new URL(`${TEST_ISSUER}/oauth2/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: `${client.clientId} `,
        redirect_uri: client.redirectUri,
        scope: 'profile:read',
      }).toString();
      const response = await environment.instance.handler(
        new Request(url, { headers: { [TEST_SESSION_HEADER]: stranger.sessionToken } }),
      );
      expect(new URL(response.headers.get('location')!).searchParams.has('code')).toBe(false);
      expect(await db.select().from(oauthConnections).where(eq(oauthConnections.userId, stranger.userId))).toEqual([]);
    });

    it('prompt=none on a disconnected connection answers consent_required, not a malformed prompt', async () => {
      const client = await environment.createClient({ skipConsent: false });
      const atConsent = await environment.authorize(client);
      const accepted = await environment.consent(client.owner, {
        accept: true,
        oauth_query: new URL(atConsent.location!).searchParams.toString(),
      });
      await environment.exchange(client, { location: accepted.body.url!, verifier: atConsent.verifier });
      await disconnectPartnerConnection(environment.database, {
        userId: client.owner.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      for (const prompt of ['none', 'none\t']) {
        const silent = await environment.authorize(client, { prompt });
        const redirect = new URL(silent.location!);
        expect(redirect.searchParams.get('error')).toBe('consent_required');
        expect(redirect.searchParams.has('code')).toBe(false);
      }
    });
  });
});

describe('a refresh that narrows scope', () => {
  let environment: PartnerTestEnvironment;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
  });

  afterAll(async () => {
    await environment?.close();
  });

  it('is refused when it drops offline_access, and the token stays current', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    for (const scope of ['profile:read', 'profile:read  offline_access_extra', '']) {
      const narrowed = await postForm(environment.secondaryInstance, '/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token!,
        scope,
        ...clientCredentials(client),
      });
      expect(narrowed.response.status).toBe(400);
      expect(narrowed.body.error).toBe('invalid_scope');
    }
    const [row] = await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, client.clientId));
    expect(row.revoked).toBeNull();
    expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
  });

  it('is allowed while it keeps offline_access, and the result still rotates', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    const narrowed = await environment.refresh(client, issued.refresh_token!, undefined, 'offline_access');
    expect(narrowed.response.status).toBe(200);
    expect(narrowed.body.scope).toBe('offline_access');
    const next = await environment.refresh(client, narrowed.body.refresh_token!);
    expect(next.response.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(narrowed.body.refresh_token);
    // Rotation really happened: replaying the used token ends the family.
    expect((await environment.refresh(client, narrowed.body.refresh_token!)).body.error).toBe('invalid_grant');
    expect((await environment.introspect(client, next.body.access_token!)).body.active).toBe(false);
  });

  it('cannot hide a replay: a consumed token with a narrowed scope still closes its family', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    const rotated = await environment.refresh(client, issued.refresh_token!);
    const replay = await environment.refresh(client, issued.refresh_token!, undefined, 'profile:read');
    expect(replay.body.error).toBe('invalid_grant');
    expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(false);
  });
});

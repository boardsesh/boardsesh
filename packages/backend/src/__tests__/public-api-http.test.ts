import { describe, expect, it } from 'vite-plus/test';
import { ApiErrorResponseSchema, MeResponseSchema } from '@boardsesh/public-api';
import { createPartnerAdmissionGate } from '../auth/partner/admission';
import { mintPartnerSubject } from '../auth/partner/api-access';
import { judgePartnerBearer, type PartnerBearerRefusal } from '../auth/partner/bearer';
import {
  apiErrorBody,
  matchPublicApiPreflight,
  matchPublicApiRoute,
  parseBearerAuthorization,
  presentMe,
  publicAvatarUrl,
} from '../handlers/public-api/http';

const MEDIA = 'https://media.boardsesh.test';

describe('public API routes', () => {
  it.each([
    ['GET', '/v1/me', 'me'],
    ['GET', '/v1/me?fields=all', 'me'],
    ['DELETE', '/v1/connection', 'connection'],
    ['GET', '/v1/logbook/changes', 'logbook-changes'],
    ['GET', '/v1/logbook/changes?cursor=c3.expired&limit=5', 'logbook-changes'],
    ['GET', '/v1/logbook/ticks/0d6c4a2e-8f1b-4b7e-9c3a-5e2f1d0a9b77', 'logbook-tick'],
    ['GET', '/v1/openapi.json', 'openapi'],
  ])('matches %s %s', (method, target, kind) => {
    expect(matchPublicApiRoute(method, target)?.kind).toBe(kind);
  });

  it('hands the tick route its raw id segment', () => {
    expect(matchPublicApiRoute('GET', '/v1/logbook/ticks/abc-123?x=1')?.tickId).toBe('abc-123');
    expect(matchPublicApiRoute('GET', '/v1/logbook/ticks/not%20an%20id')?.tickId).toBe('not%20an%20id');
  });

  it.each([
    ['HEAD', '/v1/me'],
    ['POST', '/v1/me'],
    ['GET', '/v1/me/'],
    ['GET', '/V1/me'],
    ['GET', '/v1//me'],
    ['GET', '/v1/%6De'],
    ['GET', '/v1/./me'],
    ['GET', '/v1/connection'],
    ['POST', '/v1/connection'],
    ['POST', '/v1/openapi.json'],
    ['POST', '/v1/logbook/changes'],
    ['GET', '/v1/logbook/changes/'],
    ['GET', '/v1/logbook/ticks/'],
    ['GET', '/v1/logbook/ticks/a/b'],
    ['DELETE', '/v1/logbook/ticks/a'],
    ['GET', '/v1/logbook/tick/a'],
    ['GET', '/api/v1/me'],
  ])('refuses %s %s', (method, target) => {
    expect(matchPublicApiRoute(method, target)).toBeUndefined();
  });

  it('answers a preflight only for a route it serves', () => {
    expect(matchPublicApiPreflight('OPTIONS', '/v1/me')?.kind).toBe('me');
    expect(matchPublicApiPreflight('OPTIONS', '/v1/connection')?.kind).toBe('connection');
    expect(matchPublicApiPreflight('OPTIONS', '/v1/logbook/changes')?.kind).toBe('logbook-changes');
    expect(matchPublicApiPreflight('OPTIONS', '/v1/logbook/ticks/abc')?.kind).toBe('logbook-tick');
    // A plain GET needs no preflight, so the public document answers none.
    expect(matchPublicApiPreflight('OPTIONS', '/v1/openapi.json')).toBeUndefined();
    expect(matchPublicApiPreflight('OPTIONS', '/v1/logbook/ticks/')).toBeUndefined();
    expect(matchPublicApiPreflight('OPTIONS', '/v1/workouts')).toBeUndefined();
    expect(matchPublicApiPreflight('GET', '/v1/me')).toBeUndefined();
  });
});

describe('the bearer header', () => {
  it.each([
    ['Bearer abcDEF123', 'abcDEF123'],
    ['bearer abcDEF123', 'abcDEF123'],
    ['Bearer  abc-._~+/=', 'abc-._~+/='],
  ])('reads %j', (header, token) => {
    expect(parseBearerAuthorization(header)).toEqual({ token });
  });

  it.each([[undefined], ['']])('treats %j as no token', (header) => {
    expect(parseBearerAuthorization(header)).toEqual({ problem: 'missing' });
  });

  it.each([
    ['Basic dXNlcjpwYXNz'],
    ['Bearer'],
    ['Bearer '],
    ['Bearer one two'],
    ['Bearer to"ken'],
    ['DPoP abcDEF123'],
    [`Bearer ${'a'.repeat(513)}`],
  ])('refuses %j', (header) => {
    expect(parseBearerAuthorization(header)).toEqual({ problem: 'malformed' });
  });
});

describe('avatar URLs', () => {
  const GOOGLE_PICTURE = 'https://lh3.googleusercontent.com/a/ACg8ocKxYz=s96-c';
  const FACEBOOK_PICTURE = 'https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1&height=50&width=50';

  it.each([
    ['/static/avatars/abc.webp?v=3', `${MEDIA}/avatars/abc.webp?v=3`],
    ['/static/avatars/abc.webp', `${MEDIA}/avatars/abc.webp`],
    [`${MEDIA}/avatars/abc.webp?v=3`, `${MEDIA}/avatars/abc.webp?v=3`],
    [GOOGLE_PICTURE, GOOGLE_PICTURE],
    ['https://lh5.googleusercontent.com/-abc/photo.jpg', 'https://lh5.googleusercontent.com/-abc/photo.jpg'],
    [FACEBOOK_PICTURE, FACEBOOK_PICTURE],
    [
      'https://scontent-lhr8-1.xx.fbcdn.net/v/t1.30497-1/p50x50.jpg',
      'https://scontent-lhr8-1.xx.fbcdn.net/v/t1.30497-1/p50x50.jpg',
    ],
    [`  ${GOOGLE_PICTURE}  `, GOOGLE_PICTURE],
  ])('keeps or resolves %j', (stored, expected) => {
    expect(publicAvatarUrl(stored, MEDIA)).toBe(expected);
  });

  it.each([
    // Hosts a server-side fetch must never be sent to.
    ['http://boardsesh-backend.railway.internal/x'],
    ['http://instance-data.ec2.internal/latest/meta-data/'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['https://metadata.google.internal/computeMetadata/v1/'],
    ['https://localhost/avatar.png'],
    ['https://127.0.0.1/avatar.png'],
    // Any other host a climber typed.
    ['https://cdn.example.test/alex.webp'],
    ['https://evil.example/x.png'],
    ['https://user:pass@evil.example/x.png'],
    // The allowed hosts, but not over https, with credentials, a port, or as a suffix.
    ['http://lh3.googleusercontent.com/a/ACg8ocKxYz'],
    ['https://user:pass@lh3.googleusercontent.com/a/ACg8ocKxYz'],
    ['https://lh3.googleusercontent.com:8443/a/ACg8ocKxYz'],
    ['https://lh3.googleusercontent.com.evil.example/a'],
    ['https://drive.googleusercontent.com/a'],
    ['https://evilfbcdn.net/x.jpg'],
    ['https://scontent.fbcdn.net.evil.example/x.jpg'],
    ['http://platform-lookaside.fbsbx.com/platform/profilepic/'],
    ['http://media.boardsesh.test/avatars/abc.webp'],
    ['https://media.boardsesh.test:8443/avatars/abc.webp'],
    ['https://media.boardsesh.test.evil.example/avatars/abc.webp'],
    ['javascript:alert(1)'],
    ['JAVASCRIPT:alert(1)'],
    ['data:image/png;base64,iVBORw0KGgo='],
    ['ftp://files.example.test/alex.png'],
    ['file:///etc/passwd'],
    ['blob:https://www.boardsesh.com/1234'],
    ['//cdn.example.test/alex.webp'],
    ['avatars/abc.webp'],
    ['/static/avatars/../../secret'],
    ['/static/unknown/abc.webp'],
    ['not a url'],
    [''],
    ['   '],
    [null],
  ])('maps %j to null', (stored) => {
    expect(publicAvatarUrl(stored, MEDIA)).toBeNull();
  });

  it('maps an uploaded avatar to null when no media host is configured', () => {
    expect(publicAvatarUrl('/static/avatars/abc.webp?v=3', null)).toBeNull();
  });

  it('sends the URL as it was checked, so curl and Python read the same host', () => {
    // WHATWG reads lh3.googleusercontent.com here; curl and Python's urllib read 169.254.169.254.
    expect(publicAvatarUrl('https://lh3.googleusercontent.com\\@169.254.169.254/latest/meta-data/', MEDIA)).toBe(
      'https://lh3.googleusercontent.com/@169.254.169.254/latest/meta-data/',
    );
  });

  const ALLOWED_HOSTS =
    /^(lh\d+\.googleusercontent\.com|platform-lookaside\.fbsbx\.com|.+\.fbcdn\.net|media\.boardsesh\.test)$/;
  const hosts = [
    'lh3.googleusercontent.com',
    'scontent.xx.fbcdn.net',
    'media.boardsesh.test',
    '169.254.169.254',
    'evil.example',
  ];
  const separators = ['\\', '\\\\', '@', '\\@', '@\\', '%5C', '%40', '%5C@', '/\\@', ':@', '#@', '?@'];
  const sweep = hosts.flatMap((first) =>
    hosts.flatMap((second) => separators.map((separator) => `https://${first}${separator}${second}/x.png`)),
  );

  it.each(sweep)('never sends an ambiguous URL for %j', (stored) => {
    const sent = publicAvatarUrl(stored, MEDIA);
    if (sent === null) return;
    expect(sent).not.toContain('\\');
    expect(new URL(sent).href).toBe(sent);
    // No userinfo: everything between `//` and the first `/` is the host.
    const authority = sent.slice('https://'.length).split('/')[0];
    expect(authority).not.toContain('@');
    expect(authority).toBe(new URL(sent).hostname);
    expect(new URL(sent).hostname).toMatch(ALLOWED_HOSTS);
  });
});

describe('the /v1/me body', () => {
  it('is only the id without profile:read', () => {
    expect(presentMe({ subject: 'usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6' }, MEDIA)).toEqual({ id: 'usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6' });
  });

  it('carries nulls for a climber with no name or avatar', () => {
    expect(
      presentMe({ subject: 'usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6', profile: { displayName: null, avatarUrl: null } }, MEDIA),
    ).toEqual({ id: 'usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6', displayName: null, avatarUrl: null });
  });

  it('never carries an unsafe avatar', () => {
    const body = presentMe(
      { subject: 'usr_7Qk3Vb9Xh2Lm4Np8Rs1Tw6', profile: { displayName: 'Alex', avatarUrl: 'javascript:alert(1)' } },
      MEDIA,
    );
    expect(body.avatarUrl).toBeNull();
    expect(MeResponseSchema.parse(body)).toEqual(body);
  });

  it('refuses an internal id behind the prefix', () => {
    expect(() => presentMe({ subject: 'usr_602c83bf-e090-4c90-9f7e-08ca0b6b5dad' }, MEDIA)).toThrow();
  });
});

describe('errors', () => {
  it('match the documented shape', () => {
    const body = apiErrorBody('invalid_token', 'The access token is missing.', 'req_abc');
    expect(ApiErrorResponseSchema.parse(body)).toEqual(body);
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'requestId']);
  });
});

describe('partner subjects', () => {
  it('are usr_ and 22 base-62 characters, and never repeat', () => {
    const minted = new Set(Array.from({ length: 1000 }, () => mintPartnerSubject()));
    expect(minted.size).toBe(1000);
    for (const subject of minted) {
      expect(subject).toMatch(/^usr_[0-9A-Za-z]{22}$/);
      expect(MeResponseSchema.shape.id.safeParse(subject).success).toBe(true);
    }
  });
});

type BearerRow = NonNullable<Parameters<typeof judgePartnerBearer>[0]>;

describe('the bearer verdict', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const resource = 'https://api.boardsesh.test/v1';
  const valid: BearerRow = {
    clientId: 'client-a',
    userId: 'user-a',
    scopes: ['profile:read'],
    resources: [resource],
    expiresAt: new Date(now.getTime() + 60_000),
    revoked: null,
    confirmation: null,
    sessionId: null,
    sessionExpiresAt: null,
    grantGeneration: 2,
    connectionId: 'connection-a',
    connectionUserId: 'user-a',
    connectionClientId: 'client-a',
    connectionGeneration: 2,
    connectionRevokedAt: null,
    clientDisabled: false,
  };
  const judge = (overrides: Partial<BearerRow> | undefined) =>
    judgePartnerBearer(overrides === undefined ? undefined : { ...valid, ...overrides }, {
      accessTokenHash: 'hash',
      resource,
      now,
    });

  it('accepts a current token on a live connection', () => {
    expect(judge({}).principal).toEqual({
      clientId: 'client-a',
      userId: 'user-a',
      connectionId: 'connection-a',
      connectionGeneration: 2,
      scopes: ['profile:read'],
      accessTokenHash: 'hash',
    });
    expect(judge({ clientDisabled: null }).principal).toBeDefined();
    expect(judge({ sessionId: 'session', sessionExpiresAt: new Date(now.getTime() + 1) }).principal).toBeDefined();
  });

  const refusals: Array<[string, Partial<BearerRow> | undefined, PartnerBearerRefusal]> = [
    ['no row', undefined, 'unknown'],
    ['no climber on the token', { userId: null }, 'unknown'],
    ['expiry now', { expiresAt: now }, 'expired'],
    ['revoked', { revoked: now }, 'revoked'],
    ['a DPoP binding', { confirmation: { jkt: 'thumbprint' } }, 'sender_constrained'],
    ['no audience', { resources: null }, 'wrong_audience'],
    ['an empty audience', { resources: [] }, 'wrong_audience'],
    ['another audience', { resources: ['https://api.boardsesh.test/v1/'] }, 'wrong_audience'],
    ['a disabled app', { clientDisabled: true }, 'client_disabled'],
    ['a deleted session', { sessionId: 'session', sessionExpiresAt: null }, 'session_ended'],
    ['an expired session', { sessionId: 'session', sessionExpiresAt: now }, 'session_ended'],
    ['another climber on the connection', { connectionUserId: 'user-b' }, 'connection_mismatch'],
    ['another app on the connection', { connectionClientId: 'client-b' }, 'connection_mismatch'],
    ['a disconnected connection', { connectionRevokedAt: now }, 'connection_revoked'],
    ['an older generation', { grantGeneration: 1 }, 'stale_generation'],
  ];

  it.each(refusals)('refuses %s', (_label, overrides, refusal) => {
    expect(judge(overrides)).toEqual({ refusal });
  });
});

describe('the admission gate', () => {
  const limits = {
    permits: 3,
    authorizePermits: 1,
    apiPermits: 2,
    flaggedApiPermits: 1,
    flaggedApiQueueLimit: 4,
    queueLimitPerLane: 16,
    queueDeadlineMs: 1000,
  };

  const settledFlag = (pending: Promise<unknown>) => {
    const state = { settled: false };
    void pending.then(() => {
      state.settled = true;
    });
    return state;
  };

  it('gives a flagged address one permit and a queue of four, then refuses at once', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const running = await gate.acquire('api-flagged');
    expect(running).not.toBeNull();
    const queued = Array.from({ length: 4 }, () => gate.acquire('api-flagged'));
    // Refused at once, not after the 1 s deadline.
    const sixth = gate.acquire('api-flagged');
    const sixthState = settledFlag(sixth);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sixthState.settled).toBe(true);
    expect(await sixth).toBeNull();
    // The shared /v1 lane still has its other permit.
    const shared = await gate.acquire('api');
    expect(shared).not.toBeNull();
    shared?.release();
    running?.release();
    for (const permit of await Promise.all(queued)) permit?.release();
  });

  it('counts flagged work against the two /v1 permits, so token work keeps the third', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const flagged = await gate.acquire('api-flagged');
    const shared = await gate.acquire('api');
    const secondShared = gate.acquire('api');
    const waiting = settledFlag(secondShared);
    const token = await gate.acquire('token');
    expect(token).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waiting.settled).toBe(false);
    token?.release();
    flagged?.release();
    (await secondShared)?.release();
    shared?.release();
  });

  it('gives a freed /v1 permit to the shared lane before a flagged address', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const held = await Promise.all([gate.acquire('api'), gate.acquire('api')]);
    const queuedFlagged = gate.acquire('api-flagged');
    const queuedShared = gate.acquire('api');
    const flaggedState = settledFlag(queuedFlagged);
    held[0]?.release();
    const sharedPermit = await queuedShared;
    expect(sharedPermit).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flaggedState.settled).toBe(false);
    held[1]?.release();
    (await queuedFlagged)?.release();
    sharedPermit?.release();
  });

  it('keeps one permit free of /v1 work, for a refresh', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const api = await Promise.all([gate.acquire('api'), gate.acquire('api')]);
    let thirdApiSettled = false;
    const thirdApi = gate.acquire('api').then((permit) => {
      thirdApiSettled = true;
      return permit;
    });
    const token = await gate.acquire('token');
    expect(token).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdApiSettled).toBe(false);
    token?.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdApiSettled).toBe(false);
    api[0]?.release();
    (await thirdApi)?.release();
    api[1]?.release();
  });

  it('gives a freed permit to waiting token work before waiting /v1 work', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const held = await Promise.all([gate.acquire('token'), gate.acquire('token'), gate.acquire('token')]);
    const queuedApi = gate.acquire('api');
    const queuedToken = gate.acquire('token');
    held[0]?.release();
    const tokenPermit = await queuedToken;
    expect(tokenPermit).not.toBeNull();
    held[1]?.release();
    const apiPermit = await queuedApi;
    expect(apiPermit).not.toBeNull();
    apiPermit?.release();
    tokenPermit?.release();
    held[2]?.release();
  });

  it('refuses /v1 work at once when its own queue is full, leaving the token queue alone', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const running = await Promise.all([gate.acquire('api'), gate.acquire('api')]);
    const queued = Array.from({ length: 16 }, () => gate.acquire('api'));
    expect(await gate.acquire('api')).toBeNull();
    const token = await gate.acquire('token');
    expect(token).not.toBeNull();
    token?.release();
    for (const permit of running) permit?.release();
    for (const permit of await Promise.all(queued)) permit?.release();
  });
});

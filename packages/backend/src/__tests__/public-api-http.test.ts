import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ApiErrorResponseSchema, MeResponseSchema } from '@boardsesh/public-api';
import { createPartnerAdmissionGate } from '../auth/partner/admission';
import { PARTNER_ADMISSION_LIMITS } from '../auth/partner/authority';
import {
  createPartnerApiAccess,
  mintPartnerSubject,
  PARTNER_LAST_USED_RESOLUTION_MS,
  partnerLastUseIsStale,
} from '../auth/partner/api-access';
import { judgePartnerBearer, type PartnerBearerRefusal } from '../auth/partner/bearer';
import {
  apiErrorBody,
  matchPublicApiPreflight,
  matchPublicApiRoute,
  parseBearerAuthorization,
  presentMe,
  publicAvatarUrl,
} from '../handlers/public-api/http';
import { apiLaneGroup, getTrustedClientIp } from '../utils/client-ip';

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

describe("Connected apps' last-use throttle", () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it.each([
    ['never stamped', null, true],
    ['stamped just now', now, false],
    ['stamped 59 minutes ago', minutesAgo(59), false],
    ['stamped an hour ago', minutesAgo(60), true],
    ['stamped a day ago', minutesAgo(24 * 60), true],
    // A clock behind the database's: never a write per request.
    ['stamped a minute in the future', minutesAgo(-1), false],
  ])('writes when %s: %s', (_label, lastUsedAt, stale) => {
    expect(partnerLastUseIsStale(lastUsedAt, now)).toBe(stale);
  });

  it('is one hour', () => {
    expect(PARTNER_LAST_USED_RESOLUTION_MS).toBe(3_600_000);
  });

  // A busy app's requests must cost nothing: no transaction, no round trip.
  it('opens no transaction for a fresh stamp, and one for a stale one', async () => {
    const transaction = vi.fn(async () => {
      throw new Error('the fake database writes nothing');
    });
    const access = createPartnerApiAccess({
      database: { transaction } as unknown as Parameters<typeof createPartnerApiAccess>[0]['database'],
      resource: 'https://api.boardsesh.test/v1',
      hashAccessToken: async (token) => token,
    });
    const principal = {
      clientId: 'client-a',
      userId: 'user-a',
      connectionId: 'connection-a',
      connectionGeneration: 0,
      scopes: [],
      accessTokenHash: 'hash',
    };
    const fresh = new Date(Date.now() - 5 * 60_000);
    expect(await access.recordUse({ ...principal, connectionLastUsedAt: fresh })).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    // A failed stamp is swallowed: the request it rides on still answers.
    expect(await access.recordUse({ ...principal, connectionLastUsedAt: null })).toBe(false);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

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
    connectionLastUsedAt: null,
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
      connectionLastUsedAt: null,
    });
    const lastUsedAt = new Date(now.getTime() - 5 * 60_000);
    expect(judge({ connectionLastUsedAt: lastUsedAt }).principal?.connectionLastUsedAt).toBe(lastUsedAt);
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
    apiPerAddressLimit: 8,
    overflowApiPermits: 1,
    overflowApiQueueLimit: 12,
    overflowApiPerAddressLimit: 8,
    apiPerEgressLimit: 12,
    overflowApiPerEgressLimit: 8,
    queueLimitPerLane: 16,
    queueDeadlineMs: 1000,
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  const WORKER_EGRESS = '2a06:98c0:3600:0::/64';
  /** Enough permits that nothing waits, so each lane decision shows at once. */
  const roomyLimits = { ...limits, permits: 40, apiPermits: 40 };

  const settledFlag = (pending: Promise<unknown>) => {
    const state = { settled: false };
    void pending.then(() => {
      state.settled = true;
    });
    return state;
  };

  type Permit = Awaited<ReturnType<ReturnType<typeof createPartnerAdmissionGate>['acquire']>>;
  const releaseAll = async (permits: Array<Promise<Permit> | Permit>) => {
    for (const permit of await Promise.all(permits)) permit?.release();
  };
  /** Waiting work that hands its permit straight back, so a queue drains on its own. */
  const releaseOnGrant = (pending: Promise<Permit>) =>
    pending.then((permit) => {
      permit?.release();
      return permit;
    });

  it('gives one address group 8 places in the shared lane and sends its 9th to overflow', async () => {
    const gate = createPartnerAdmissionGate(roomyLimits);
    const shared = await Promise.all(Array.from({ length: 8 }, () => gate.acquire('api', '203.0.113.7')));
    expect(shared.map((permit) => permit?.lane)).toEqual(Array(8).fill('api'));
    const ninth = await gate.acquire('api', '203.0.113.7');
    expect(ninth?.lane).toBe('api-overflow');
    // Another group is unaffected.
    const neighbour = await gate.acquire('api', '203.0.113.8');
    expect(neighbour?.lane).toBe('api');
    await releaseAll([...shared, ninth, neighbour]);
  });

  it("lets one address group hold at most 8 of the shared lane's 18 places", async () => {
    const gate = createPartnerAdmissionGate(limits);
    // A burst of 30 from one group: 2 run, 6 wait, 8 wait in overflow, 14 are refused at once.
    const burst = Array.from({ length: 30 }, () => gate.acquire('api', '203.0.113.7'));
    const refusedAtOnce = (await Promise.all(burst.slice(16))).filter((permit) => permit === null);
    expect(refusedAtOnce).toHaveLength(14);
    const waitingBurst = burst.slice(2, 16).map(releaseOnGrant);
    // The other 10 places of the shared lane are still open to everyone else.
    const others = [
      ...Array.from({ length: 8 }, () => gate.acquire('api', '198.51.100.1')),
      ...Array.from({ length: 2 }, () => gate.acquire('api', '198.51.100.2')),
    ].map(releaseOnGrant);
    const othersState = others.map(settledFlag);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(othersState.every((state) => !state.settled)).toBe(true);
    // Now the shared lane is full: 2 running and 16 waiting. A group with
    // nothing in flight still gets a place: the newest waiter of a group holding
    // 8 gives its place up and waits in overflow instead.
    const newcomer = releaseOnGrant(gate.acquire('api', '198.51.100.3'));
    const newcomerState = settledFlag(newcomer);
    await pause();
    expect(newcomerState.settled).toBe(false);
    const firstTwo = await Promise.all(burst.slice(0, 2));
    for (const permit of firstTwo) permit?.release();
    const granted = await Promise.all([...waitingBurst, ...others, newcomer]);
    expect(granted.every((permit) => permit !== null)).toBe(true);
    expect((await newcomer)?.lane).toBe('api');
    expect((await others[7])?.lane).toBe('api-overflow');
  });

  it('gives a released shared place back to its group', async () => {
    const gate = createPartnerAdmissionGate(roomyLimits);
    const shared = await Promise.all(Array.from({ length: 8 }, () => gate.acquire('api', '203.0.113.7')));
    shared[0]?.release();
    // A second release of the same permit gives nothing back twice.
    shared[0]?.release();
    const next = await gate.acquire('api', '203.0.113.7');
    expect(next?.lane).toBe('api');
    const after = await gate.acquire('api', '203.0.113.7');
    expect(after?.lane).toBe('api-overflow');
    await releaseAll([...shared.slice(1), next, after]);
  });

  it('gives a place back when its wait passes the deadline', async () => {
    const gate = createPartnerAdmissionGate({ ...limits, queueDeadlineMs: 30 });
    const running = await Promise.all([gate.acquire('api', '203.0.113.7'), gate.acquire('api', '203.0.113.7')]);
    const timedOut = await Promise.all(Array.from({ length: 6 }, () => gate.acquire('api', '203.0.113.7')));
    expect(timedOut.every((permit) => permit === null)).toBe(true);
    // The group holds 2 places again, so its next request waits in the shared lane.
    const next = gate.acquire('api', '203.0.113.7');
    running[0]?.release();
    expect((await next)?.lane).toBe('api');
    running[1]?.release();
    (await next)?.release();
  });

  it('takes no place for a request refused because the shared queue is full', async () => {
    const gate = createPartnerAdmissionGate(limits);
    // Requests that name no group fill the shared lane without counting against anyone.
    const fillers = Array.from({ length: 18 }, () => gate.acquire('api'));
    const waitingFillers = fillers.slice(2).map(releaseOnGrant);
    const refused = await Promise.all(Array.from({ length: 8 }, () => gate.acquire('api', '203.0.113.7')));
    expect(refused.every((permit) => permit === null)).toBe(true);
    const firstTwo = await Promise.all(fillers.slice(0, 2));
    for (const permit of firstTwo) permit?.release();
    await Promise.all(waitingFillers);
    const next = await gate.acquire('api', '203.0.113.7');
    expect(next?.lane).toBe('api');
    next?.release();
  });

  it('gives overflow one permit and a queue of 12, then refuses at once', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const running = await gate.acquire('api-overflow');
    expect(running).not.toBeNull();
    const queued = Array.from({ length: 12 }, () => releaseOnGrant(gate.acquire('api-overflow')));
    // Refused at once, not after the 1 s deadline.
    const fourteenth = gate.acquire('api-overflow');
    const fourteenthState = settledFlag(fourteenth);
    await pause();
    expect(fourteenthState.settled).toBe(true);
    expect(await fourteenth).toBeNull();
    // The shared /v1 lane still has its other permit.
    const shared = await gate.acquire('api', '198.51.100.1');
    expect(shared?.lane).toBe('api');
    shared?.release();
    running?.release();
    expect((await Promise.all(queued)).every((permit) => permit !== null)).toBe(true);
  });

  it('counts overflow work against the two /v1 permits, so token work keeps the third', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const overflow = await gate.acquire('api-overflow');
    const shared = await gate.acquire('api');
    const secondShared = gate.acquire('api');
    const waiting = settledFlag(secondShared);
    const token = await gate.acquire('token');
    expect(token).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waiting.settled).toBe(false);
    token?.release();
    overflow?.release();
    (await secondShared)?.release();
    shared?.release();
  });

  it('gives a freed /v1 permit to the shared lane before overflow', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const held = await Promise.all([gate.acquire('api'), gate.acquire('api')]);
    const queuedOverflow = gate.acquire('api-overflow');
    const queuedShared = gate.acquire('api');
    const overflowState = settledFlag(queuedOverflow);
    held[0]?.release();
    const sharedPermit = await queuedShared;
    expect(sharedPermit).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(overflowState.settled).toBe(false);
    held[1]?.release();
    (await queuedOverflow)?.release();
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

  describe('when a few groups fill a lane between them', () => {
    /** Three groups that each keep 8 requests waiting, with the first two running and held. */
    function threeFloodingGroups(gate: ReturnType<typeof createPartnerAdmissionGate>) {
      const groups = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];
      const requests = groups.flatMap((group) => Array.from({ length: 8 }, () => gate.acquire('api', group)));
      return { held: requests.slice(0, 2), waiting: requests.slice(2).map(releaseOnGrant), requests };
    }

    it('keeps a place for a fourth group while three groups hold 8 each (production limits)', async () => {
      const gate = createPartnerAdmissionGate(PARTNER_ADMISSION_LIMITS);
      const flood = threeFloodingGroups(gate);
      // 24 requests for 18 places. Each time the queue was full, the newest waiter
      // of a larger group moved to overflow, until the three held 6 each; the
      // third group's last two found no larger group and were refused.
      const honest = releaseOnGrant(gate.acquire('api', '203.0.113.50'));
      const honestState = settledFlag(honest);
      await pause();
      expect(honestState.settled).toBe(false);
      await releaseAll(flood.held);
      expect((await honest)?.lane).toBe('api');
      const lanes = (await Promise.all(flood.waiting)).map((permit) => permit?.lane);
      // Four moves while the flood arrived, and one for the honest group.
      expect(lanes.filter((lane) => lane === 'api-overflow')).toHaveLength(5);
      expect(lanes.filter((lane) => lane === undefined)).toHaveLength(2);
    });

    it('takes a place only from a group that would still hold more, so equal groups never trade', async () => {
      const gate = createPartnerAdmissionGate(limits);
      // 7, 6 and 5 places: the shared lane's 18, with nobody evicted on the way.
      const requests = [
        ...Array.from({ length: 7 }, () => gate.acquire('api', '198.51.100.1')),
        ...Array.from({ length: 6 }, () => gate.acquire('api', '198.51.100.2')),
        ...Array.from({ length: 5 }, () => gate.acquire('api', '198.51.100.3')),
      ];
      const waiting = requests.slice(2).map(releaseOnGrant);
      // The group with 6 would hold 7, as many as the largest: refused, nobody moves.
      expect(await gate.acquire('api', '198.51.100.2')).toBeNull();
      // The group with 5 would hold 6, fewer than 7: the largest group's newest waiter moves.
      const smaller = releaseOnGrant(gate.acquire('api', '198.51.100.3'));
      await releaseAll(requests.slice(0, 2));
      const lanes = (await Promise.all(waiting)).map((permit) => permit?.lane);
      expect(lanes.filter((lane) => lane === 'api-overflow')).toHaveLength(1);
      expect(lanes[4]).toBe('api-overflow');
      expect((await smaller)?.lane).toBe('api');
    });

    it("refuses the waiter that gives its place up when its group's overflow places are full", async () => {
      const gate = createPartnerAdmissionGate(limits);
      // One group at both of its shares: 8 shared (2 running) and 8 overflow.
      const flooder = Array.from({ length: 16 }, () => gate.acquire('api', '198.51.100.1'));
      const others = [
        ...Array.from({ length: 5 }, () => gate.acquire('api', '198.51.100.2')),
        ...Array.from({ length: 5 }, () => gate.acquire('api', '198.51.100.3')),
      ].map(releaseOnGrant);
      const newestSharedOfFlooder = settledFlag(flooder[7]);
      const honest = releaseOnGrant(gate.acquire('api', '203.0.113.50'));
      await pause();
      expect(newestSharedOfFlooder.settled).toBe(true);
      expect(await flooder[7]).toBeNull();
      const waitingFlooder = [...flooder.slice(2, 7), ...flooder.slice(8)].map(releaseOnGrant);
      await releaseAll(flooder.slice(0, 2));
      expect((await honest)?.lane).toBe('api');
      expect((await Promise.all([...waitingFlooder, ...others])).every((permit) => permit !== null)).toBe(true);
    });

    it('gives a place up in a full overflow queue the same way', async () => {
      // No shared share at all, so every request goes straight to overflow.
      const gate = createPartnerAdmissionGate({ ...limits, apiPerAddressLimit: 0 });
      const flooder = Array.from({ length: 8 }, () => gate.acquire('api', '198.51.100.1'));
      // The group's ninth overflow place is refused at once.
      expect(await gate.acquire('api', '198.51.100.1')).toBeNull();
      const second = Array.from({ length: 5 }, () => gate.acquire('api', '198.51.100.2')).map(releaseOnGrant);
      // 1 running and 12 waiting: full. A third group takes the flooder's newest place.
      const newestOfFlooder = settledFlag(flooder[7]);
      const third = releaseOnGrant(gate.acquire('api', '198.51.100.3'));
      await pause();
      expect(newestOfFlooder.settled).toBe(true);
      expect(await flooder[7]).toBeNull();
      const waitingFlooder = flooder.slice(1, 7).map(releaseOnGrant);
      await releaseAll(flooder.slice(0, 1));
      expect((await third)?.lane).toBe('api-overflow');
      expect((await Promise.all([...waitingFlooder, ...second])).every((permit) => permit !== null)).toBe(true);
    });

    it('gives every place back after a move, so a group can use both of its shares again', async () => {
      const gate = createPartnerAdmissionGate(PARTNER_ADMISSION_LIMITS);
      const flood = threeFloodingGroups(gate);
      const honest = releaseOnGrant(gate.acquire('api', '203.0.113.50'));
      await releaseAll(flood.held);
      await Promise.all([...flood.waiting, honest]);
      // Everything drained: each flooding group holds nothing in either lane.
      const roomy = Array.from({ length: 16 }, () => gate.acquire('api', '198.51.100.1'));
      const roomyWaiting = roomy.slice(2).map(releaseOnGrant);
      await pause();
      await releaseAll(roomy.slice(0, 2));
      const lanes = (await Promise.all(roomyWaiting)).map((permit) => permit?.lane);
      expect(lanes.filter((lane) => lane === 'api')).toHaveLength(6);
      expect(lanes.filter((lane) => lane === 'api-overflow')).toHaveLength(8);
    });
  });

  describe('Cloudflare Worker zones', () => {
    it('gives each zone its own share, and every zone together 12 shared places', async () => {
      const gate = createPartnerAdmissionGate({ ...roomyLimits, overflowApiPermits: 40 });
      const zones = Array.from({ length: 13 }, (_, index) =>
        gate.acquire('api', `cf-worker:app-${index}.example`, WORKER_EGRESS),
      );
      const lanes = (await Promise.all(zones)).map((permit) => permit?.lane);
      expect(lanes.slice(0, 12)).toEqual(Array(12).fill('api'));
      expect(lanes[12]).toBe('api-overflow');
      // Another group is not held to the Worker ceiling.
      const neighbour = await gate.acquire('api', '203.0.113.7');
      expect(neighbour?.lane).toBe('api');
      // Every zone together holds at most 8 overflow places too.
      const moreZones = await Promise.all(
        Array.from({ length: 8 }, (_, index) => gate.acquire('api', `cf-worker:more-${index}.example`, WORKER_EGRESS)),
      );
      expect(moreZones.slice(0, 7).every((permit) => permit?.lane === 'api-overflow')).toBe(true);
      expect(moreZones[7]).toBeNull();
      await releaseAll([...zones, neighbour, ...moreZones]);
    });

    it('holds every Worker zone together to 12 shared places (production limits)', async () => {
      const gate = createPartnerAdmissionGate(PARTNER_ADMISSION_LIMITS);
      const zones = Array.from({ length: 13 }, (_, index) =>
        gate.acquire('api', `cf-worker:pin-${index}.example`, WORKER_EGRESS),
      );
      const waiting = zones.slice(2).map(releaseOnGrant);
      await releaseAll(zones.slice(0, 2));
      const lanes = (await Promise.all(waiting)).map((permit) => permit?.lane);
      // Twelve zones in the shared lane; the thirteenth, as large as each of them, overflows.
      expect(lanes.slice(0, 10)).toEqual(Array(10).fill('api'));
      expect(lanes[10]).toBe('api-overflow');
    });

    it('lets a zone in when two junk zones hold every Worker place (production limits)', async () => {
      const gate = createPartnerAdmissionGate(PARTNER_ADMISSION_LIMITS);
      const zone = (name: string) => `cf-worker:${name}.example`;
      // 16 from one zone (8 shared, 8 overflow) and 4 from another: the Worker
      // share's 12 shared and 8 overflow places, all of them junk.
      const junk = [
        ...Array.from({ length: 16 }, () => gate.acquire('api', zone('junk-a'), WORKER_EGRESS)),
        ...Array.from({ length: 4 }, () => gate.acquire('api', zone('junk-b'), WORKER_EGRESS)),
      ];
      const newestSharedOfBusiest = settledFlag(junk[7]);
      const honest = releaseOnGrant(gate.acquire('api', zone('honest'), WORKER_EGRESS));
      const honestState = settledFlag(honest);
      await pause();
      expect(honestState.settled).toBe(false);
      // The zone holding the most Worker places gave its newest shared place up;
      // with its overflow places full too, that waiter was refused.
      expect(newestSharedOfBusiest.settled).toBe(true);
      expect(await junk[7]).toBeNull();
      const waiting = [...junk.slice(2, 7), ...junk.slice(8)].map(releaseOnGrant);
      await releaseAll(junk.slice(0, 2));
      expect((await honest)?.lane).toBe('api');
      expect((await Promise.all(waiting)).every((permit) => permit !== null)).toBe(true);
    });

    it('never moves a zone out for one that would hold as many', async () => {
      const gate = createPartnerAdmissionGate(PARTNER_ADMISSION_LIMITS);
      // Twelve zones at one place each fill the Worker share; a thirteenth would
      // hold one too, so it overflows and nobody gives a place up.
      const zones = Array.from({ length: 12 }, (_, index) =>
        gate.acquire('api', `cf-worker:even-${index}.example`, WORKER_EGRESS),
      );
      const states = zones.map(settledFlag);
      const thirteenth = releaseOnGrant(gate.acquire('api', 'cf-worker:even-12.example', WORKER_EGRESS));
      await pause();
      expect(states.slice(2).every((state) => !state.settled)).toBe(true);
      const waiting = zones.slice(2).map(releaseOnGrant);
      await releaseAll(zones.slice(0, 2));
      expect((await thirteenth)?.lane).toBe('api-overflow');
      expect((await Promise.all(waiting)).every((permit) => permit?.lane === 'api')).toBe(true);
    });

    it('weighs a Worker request by every zone together, so forged zones give a place up first', async () => {
      const gate = createPartnerAdmissionGate(limits);
      // 12 zones at one place each, and 6 ordinary groups at one: the shared lane's 18.
      const requests = [
        ...Array.from({ length: 12 }, (_, index) =>
          gate.acquire('api', `cf-worker:forged-${index}.example`, WORKER_EGRESS),
        ),
        ...Array.from({ length: 6 }, (_, index) => gate.acquire('api', `198.51.100.${index + 1}`)),
      ];
      const waiting = requests.slice(2).map(releaseOnGrant);
      const honest = releaseOnGrant(gate.acquire('api', '203.0.113.50'));
      const honestState = settledFlag(honest);
      await pause();
      expect(honestState.settled).toBe(false);
      await releaseAll(requests.slice(0, 2));
      expect((await honest)?.lane).toBe('api');
      const lanes = (await Promise.all(waiting)).map((permit) => permit?.lane);
      // The newest zone moved to overflow; every ordinary group kept its place.
      expect(lanes[9]).toBe('api-overflow');
      expect(lanes.slice(10)).toEqual(Array(6).fill('api'));
    });
  });

  it('refuses /v1 work at once when its own queue is full, leaving the token queue alone', async () => {
    const gate = createPartnerAdmissionGate(limits);
    const running = await Promise.all([gate.acquire('api'), gate.acquire('api')]);
    const queued = Array.from({ length: 16 }, () => releaseOnGrant(gate.acquire('api')));
    expect(await gate.acquire('api')).toBeNull();
    const token = await gate.acquire('token');
    expect(token).not.toBeNull();
    token?.release();
    for (const permit of running) permit?.release();
    await Promise.all(queued);
  });
});

describe('the /v1 lane group', () => {
  it.each([
    ['2001:db8:aa:1::/64', '2001:db8:aa::/48'],
    ['2001:db8:aa:ffff::/64', '2001:db8:aa::/48'],
    ['2001:db8:ab:1::/64', '2001:db8:ab::/48'],
    ['203.0.113.7', '203.0.113.7'],
    ['unknown', 'unknown'],
    ['cf-worker:partner.example', 'cf-worker:partner.example'],
    ['not-an-address::/64', 'not-an-address::/64'],
  ])('groups %s as %s', (limitKey, group) => {
    expect(apiLaneGroup(limitKey)).toBe(group);
  });

  it('groups fresh /64s inside one /48 together, and the /48 next door apart', () => {
    const groupOf = (address: string) =>
      apiLaneGroup(
        getTrustedClientIp({
          headers: { 'x-forwarded-for': address },
          socket: { remoteAddress: '127.0.0.1' },
        } as unknown as IncomingMessage),
      );
    expect(groupOf('2001:db8:aa:1::1')).toBe(groupOf('2001:db8:aa:9f3e:1234::99'));
    expect(groupOf('2001:db8:aa:1::1')).not.toBe(groupOf('2001:db8:ab:1::1'));
    expect(groupOf('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
});

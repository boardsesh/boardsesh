import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';
import { roomManager } from '../services/room-manager';
import { db } from '../db/client';
import { createMockRedis } from './helpers/mock-redis';

// #7018: a signed-in climber's phone holds two sockets in one session, the
// app's and the iOS Live Activity's. Both land on the same participant row.
// The Live Activity socket joins without a name or avatar, and that join used
// to write its per-connection `User-xxxxxx` placeholder over the profile the
// app's socket had sent, so the crew saw a changing alias with no avatar.

const BOARD_PATH = '/kilter/1/10/1,2,3/40';
const PROFILED = randomUUID();
const PROFILED_NAME = 'Marco Profile';
const PROFILED_AVATAR = 'https://example.com/marco.png';
const ACCOUNT_ONLY = randomUUID();
const ACCOUNT_ONLY_NAME = 'Account Name';
const ACCOUNT_ONLY_IMAGE = 'https://example.com/account.png';

beforeAll(async () => {
  await db.insert(dbSchema.users).values([
    { id: PROFILED, email: `${PROFILED}@test.com`, name: 'Old Account Name' },
    { id: ACCOUNT_ONLY, email: `${ACCOUNT_ONLY}@test.com`, name: ACCOUNT_ONLY_NAME, image: ACCOUNT_ONLY_IMAGE },
  ]);
  await db
    .insert(dbSchema.userProfiles)
    .values({ userId: PROFILED, displayName: PROFILED_NAME, avatarUrl: PROFILED_AVATAR });
});

afterEach(() => {
  roomManager.reset();
});

async function join(
  connectionId: string,
  sessionId: string,
  userId?: string,
  identity: { username?: string; avatarUrl?: string } = {},
) {
  await roomManager.registerClient(connectionId, undefined, userId);
  return roomManager.joinSession(connectionId, sessionId, BOARD_PATH, identity.username, identity.avatarUrl);
}

describe.each([
  ['with Redis', true],
  ['without Redis', false],
])('a signed-in join that sends no identity (%s)', (_label, withRedis) => {
  async function start() {
    roomManager.reset();
    await roomManager.initialize(withRedis ? createMockRedis() : undefined);
  }

  it('keeps the profile the app sent when the Live Activity socket joins after it', async () => {
    await start();
    const sessionId = randomUUID();
    await join('app-socket', sessionId, PROFILED, { username: PROFILED_NAME, avatarUrl: PROFILED_AVATAR });
    const nativeJoin = await join('live-activity-socket', sessionId, PROFILED);

    const roster = await roomManager.getSessionUsers(sessionId);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ username: PROFILED_NAME, avatarUrl: PROFILED_AVATAR });
    expect(nativeJoin.users.find((user) => user.id === nativeJoin.participantId)).toMatchObject({
      username: PROFILED_NAME,
      avatarUrl: PROFILED_AVATAR,
    });
  });

  it('shows the profile when the Live Activity socket is the only one in the session', async () => {
    await start();
    const sessionId = randomUUID();
    await join('live-activity-socket', sessionId, PROFILED);

    const roster = await roomManager.getSessionUsers(sessionId);
    expect(roster[0]).toMatchObject({ username: PROFILED_NAME, avatarUrl: PROFILED_AVATAR });
  });

  it('falls back to the account name and image when there is no profile row', async () => {
    await start();
    const sessionId = randomUUID();
    await join('live-activity-socket', sessionId, ACCOUNT_ONLY);

    const roster = await roomManager.getSessionUsers(sessionId);
    expect(roster[0]).toMatchObject({ username: ACCOUNT_ONLY_NAME, avatarUrl: ACCOUNT_ONLY_IMAGE });
  });

  it('lets a name the app sends win over the stored profile', async () => {
    await start();
    const sessionId = randomUUID();
    await join('app-socket', sessionId, PROFILED, { username: 'Fresh Edit' });

    const roster = await roomManager.getSessionUsers(sessionId);
    expect(roster[0].username).toBe('Fresh Edit');
  });

  it('keeps the placeholder for a signed-out join', async () => {
    await start();
    const sessionId = randomUUID();
    await join('anon-socket', sessionId);

    const roster = await roomManager.getSessionUsers(sessionId);
    expect(roster[0].username).toBe('User-anon-s');
  });
});

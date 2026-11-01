import { describe, expect, it } from 'vitest';
import { requirePhysicalDelivery, requireSessionIdentity } from './confirmation';
import type { CatalogClimb } from './config';
import type { FixtureBoard } from './fixture';

const commands = [{ position: 17, r: 0, g: 252, b: 255 }];
const climb: CatalogClimb = { name: 'fixture', uuid: 'climb', frames: 'p1r12', commands, packetBytes: 40 };
const before: FixtureBoard = {
  uuid: 'board',
  connections: 1,
  handles: [8],
  writes: 10,
  updates: 4,
  rejected: 0,
  sequence: 4,
  connectionHandle: 8,
  connectionGeneration: 2,
  commands: [],
  angle: 40,
};
const complete: FixtureBoard = { ...before, writes: 12, updates: 5, sequence: 5, commands };
describe('physical confirmation requirements', () => {
  it('rejects changing User aliases even when the signed-in user ID survives', () => {
    const expected = { userId: 'signed-in-user', displayName: 'Climber', avatarUrl: 'https://example.com/avatar.jpg' };
    const member = {
      userId: expected.userId,
      username: expected.displayName,
      avatarUrl: expected.avatarUrl,
      connectionState: 'CONNECTED',
    };
    expect(() => requireSessionIdentity([member], expected)).not.toThrow();
    expect(() => requireSessionIdentity([{ ...member, username: 'User-12345' }], expected)).toThrow('profile identity');
    expect(() => requireSessionIdentity([{ ...member, avatarUrl: null }], expected)).toThrow('profile identity');
  });
  it('accepts a complete exact command and a separately proven new connection', () => {
    expect(() => requirePhysicalDelivery(before, complete, climb, false, true)).not.toThrow();
    expect(() =>
      requirePhysicalDelivery(
        before,
        { ...complete, handles: [9], connectionHandle: 9, connectionGeneration: 3 },
        climb,
        true,
        true,
      ),
    ).not.toThrow();
  });
  it.each([
    ['old completed frame', { sequence: 4, updates: 4 }],
    ['only the first ATT chunk', { sequence: 4, updates: 4, writes: 11 }],
    ['equal LED count with wrong holds', { commands: [{ ...commands[0], position: 18 }] }],
    ['wrong quantized color', { commands: [{ ...commands[0], g: 255 }] }],
    ['wrong wall', { uuid: 'another-board' }],
    ['superseded writer', { handles: [9], connectionHandle: 8 }],
    ['unreported reconnect', { connectionGeneration: 3 }],
    ['parser rejected part of the packet', { rejected: 1 }],
    ['multiple active centrals', { connections: 2, handles: [8, 9] }],
    ['one write in a multi-chunk test', { writes: 11 }],
  ] satisfies Array<[string, Partial<FixtureBoard>]>)('rejects %s', (_label, override) => {
    expect(() => requirePhysicalDelivery(before, { ...complete, ...override }, climb, false, true)).toThrow();
  });
});

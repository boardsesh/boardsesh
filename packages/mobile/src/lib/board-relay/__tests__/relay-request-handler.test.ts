// Relay mode (#7220), the holder's side: light a relayed climb over this
// phone's link and report it with the request's id.
import { describe, expect, it, vi } from 'vitest';
import type { BoardClimbRelayRequested } from '@boardsesh/shared-schema';
import {
  createRelayRequestHandler,
  RELAYER_LINE_QUIET_MS,
  type RelayRequestHandlerDeps,
} from '../relay-request-handler';

function request(overrides: Partial<BoardClimbRelayRequested> = {}): BoardClimbRelayRequested {
  return {
    __typename: 'BoardClimbRelayRequested',
    relayRequestId: 'relay-1',
    climb: { climbUuid: 'c1', queueItemUuid: 'q1', name: 'Crimp Ladder', grade: '6B+', frames: 'p1r42' },
    angle: 40,
    mirrored: false,
    relayer: { userId: 'kim', displayName: 'Kim', avatarUrl: null, anonymous: false },
    requestedAt: '2026-11-03T12:00:00.000Z',
    ...overrides,
  };
}

function deps(overrides: Partial<RelayRequestHandlerDeps> = {}) {
  let now = 0;
  const value: RelayRequestHandlerDeps & { advance: (ms: number) => void } = {
    canLight: () => true,
    boardId: () => 5,
    fence: () => () => true,
    write: vi.fn(async () => true),
    report: vi.fn(async () => true),
    showRelayerLine: vi.fn(),
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    ...overrides,
  };
  return value;
}

describe('createRelayRequestHandler', () => {
  it('writes the climb over Bluetooth, then reports it with the request id as received', async () => {
    const handlerDeps = deps();
    const handle = createRelayRequestHandler(() => handlerDeps);
    await expect(handle(request())).resolves.toBe('lit');
    expect(handlerDeps.write).toHaveBeenCalledWith('p1r42', false, 'c1');
    expect(handlerDeps.report).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        uuid: 'q1',
        climb: expect.objectContaining({ uuid: 'c1', frames: 'p1r42', angle: 40 }),
      }),
      40,
      'relay-1',
      expect.any(Function),
    );
  });

  it('answers a fast run of one relayer with the newest climb only', async () => {
    let releaseFirst: (written: boolean) => void = () => {};
    const write = vi
      .fn<RelayRequestHandlerDeps['write']>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(true);
    const handlerDeps = deps({ write });
    const handle = createRelayRequestHandler(() => handlerDeps);
    const first = handle(request());
    await Promise.resolve();
    const second = handle(request({ relayRequestId: 'relay-2', climb: { climbUuid: 'c2', frames: 'p2r42' } }));
    const third = handle(request({ relayRequestId: 'relay-3', climb: { climbUuid: 'c3', frames: 'p3r42' } }));
    releaseFirst(true);
    await expect(first).resolves.toBe('lit');
    await expect(second).resolves.toBe('superseded');
    await expect(third).resolves.toBe('lit');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('p3r42', false, 'c3');
  });

  it('a clear or reconnect during the write sends no report', async () => {
    const handlerDeps = deps({ fence: () => () => false });
    await expect(createRelayRequestHandler(() => handlerDeps)(request())).resolves.toBe('ignored');
    expect(handlerDeps.report).not.toHaveBeenCalled();
  });

  it('ignores a request when this phone has no link, the setting is off or the flag is off', async () => {
    const handlerDeps = deps({ canLight: () => false });
    const handle = createRelayRequestHandler(() => handlerDeps);
    await expect(handle(request())).resolves.toBe('ignored');
    expect(handlerDeps.write).not.toHaveBeenCalled();
    expect(handlerDeps.report).not.toHaveBeenCalled();
    expect(handlerDeps.showRelayerLine).not.toHaveBeenCalled();
  });

  it('ignores a request with no bound board or no frames', async () => {
    const unbound = deps({ boardId: () => null });
    await expect(createRelayRequestHandler(() => unbound)(request())).resolves.toBe('ignored');
    const empty = deps();
    const noFrames = request({ climb: { climbUuid: 'c1', frames: null } });
    await expect(createRelayRequestHandler(() => empty)(noFrames)).resolves.toBe('ignored');
    expect(empty.write).not.toHaveBeenCalled();
  });

  it('reports nothing when the write fails', async () => {
    const handlerDeps = deps({ write: vi.fn(async () => false) });
    await expect(createRelayRequestHandler(() => handlerDeps)(request())).resolves.toBe('write_failed');
    expect(handlerDeps.report).not.toHaveBeenCalled();
  });

  it('says "{name} is driving" once per relayer per run of relays', async () => {
    const handlerDeps = deps();
    const handle = createRelayRequestHandler(() => handlerDeps);
    await handle(request());
    handlerDeps.advance(30_000);
    await handle(request({ relayRequestId: 'relay-2' }));
    expect(handlerDeps.showRelayerLine).toHaveBeenCalledTimes(1);
    expect(handlerDeps.showRelayerLine).toHaveBeenCalledWith('Kim');
    handlerDeps.advance(RELAYER_LINE_QUIET_MS + 1);
    await handle(request({ relayRequestId: 'relay-3' }));
    expect(handlerDeps.showRelayerLine).toHaveBeenCalledTimes(2);
  });

  it('names an anonymous relayer as someone on this board', async () => {
    const handlerDeps = deps();
    await createRelayRequestHandler(() => handlerDeps)(
      request({ relayer: { userId: null, displayName: 'Hidden', avatarUrl: null, anonymous: true } }),
    );
    expect(handlerDeps.showRelayerLine).toHaveBeenCalledWith(null);
  });
});

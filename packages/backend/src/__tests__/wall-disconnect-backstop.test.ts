/**
 * Tests for the room manager's WS-close crash backstop publishing a
 * session-scoped `WallDisconnected` event.
 *
 * When a connection that held a board-writer slot closes (crash / unclean
 * disconnect) without first calling `reportWallDisconnect`, the backstop
 * (`clearBoardWriterForConnection`) frees the wall AND — when that connection
 * was bound to a session — tells the session's members the wall connection
 * dropped via `WallDisconnected { disconnectedByParticipantId: null }`, so their
 * "climb is lit" lightbulb clears even though the device couldn't send the
 * mutation. `null` flags it as a system/crash backstop, not an explicit report.
 *
 * The board-writer slot lives in Redis (clearBoardWriterIf). We spy on the
 * pubsub singleton's Redis-backed methods so the test runs without Redis and
 * focuses on the room-manager fan-out logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { roomManager } from '../services/room-manager';
import { pubsub } from '../pubsub/index';

describe('room manager WallDisconnected crash backstop', () => {
  let clearBoardWriterIfSpy: ReturnType<typeof vi.spyOn>;
  let nextBoardSeqSpy: ReturnType<typeof vi.spyOn>;
  let publishBoardPresenceSpy: ReturnType<typeof vi.spyOn>;
  let publishSessionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    roomManager.reset();
    // Spy on the singleton pubsub directly — the room manager grabs the
    // `pubsub` reference at import time, so module-mocking can race the
    // singleton; spying on existing methods avoids that ordering hazard.
    nextBoardSeqSpy = vi.spyOn(pubsub, 'nextBoardSeq').mockResolvedValue(7);
    publishBoardPresenceSpy = vi.spyOn(pubsub, 'publishBoardPresenceEvent').mockImplementation(() => {});
    publishSessionSpy = vi.spyOn(pubsub, 'publishSessionEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    roomManager.reset();
  });

  it('publishes WallDisconnected to the session when a board-writer connection in a session closes', async () => {
    // The compare-and-delete cleared a real hold (this connection still held it).
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(true);

    const connectionId = 'conn-backstop-1';
    await roomManager.registerClient(connectionId);
    // Bind the connection to a session (the in-memory client record is what the
    // backstop reads sessionId from).
    const client = roomManager.getClient(connectionId);
    expect(client).toBeDefined();
    client!.sessionId = 'session-backstop-1';
    roomManager.noteBoardWriter(connectionId, 4242, 'emitter-1');

    await roomManager.clearBoardWriterForConnection(connectionId);

    // Board-presence "wall went free" event still fires.
    expect(clearBoardWriterIfSpy).toHaveBeenCalledWith('4242', 'emitter-1');
    expect(publishBoardPresenceSpy).toHaveBeenCalledWith('4242', {
      __typename: 'BoardConnectionChanged',
      holder: null,
      seq: 7,
    });
    // And the session-scoped wall-disconnect signal fires with null (crash backstop).
    expect(publishSessionSpy).toHaveBeenCalledWith('session-backstop-1', {
      __typename: 'WallDisconnected',
      disconnectedByParticipantId: null,
    });

    await roomManager.removeClient(connectionId);
  });

  it('does NOT publish WallDisconnected when the dropped board-writer connection has no session', async () => {
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(true);

    const connectionId = 'conn-backstop-2';
    await roomManager.registerClient(connectionId);
    // No sessionId set (sessionId stays null) — board-only connection.
    roomManager.noteBoardWriter(connectionId, 5555, 'emitter-2');

    await roomManager.clearBoardWriterForConnection(connectionId);

    // Board-presence event still fires, but no session-scoped event.
    expect(publishBoardPresenceSpy).toHaveBeenCalledOnce();
    expect(publishSessionSpy).not.toHaveBeenCalled();

    await roomManager.removeClient(connectionId);
  });

  it('does NOT publish WallDisconnected when the connection no longer held the board (always-take hand-off)', async () => {
    // Compare-and-delete returns false: another emitter has taken over, so this
    // connection's drop must not fire either the board or the session event.
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(false);

    const connectionId = 'conn-backstop-3';
    await roomManager.registerClient(connectionId);
    const client = roomManager.getClient(connectionId);
    client!.sessionId = 'session-backstop-3';
    roomManager.noteBoardWriter(connectionId, 6666, 'emitter-3');

    await roomManager.clearBoardWriterForConnection(connectionId);

    expect(clearBoardWriterIfSpy).toHaveBeenCalledWith('6666', 'emitter-3');
    expect(nextBoardSeqSpy).not.toHaveBeenCalled();
    expect(publishBoardPresenceSpy).not.toHaveBeenCalled();
    expect(publishSessionSpy).not.toHaveBeenCalled();

    await roomManager.removeClient(connectionId);
  });

  it('is a safe no-op when the connection never held a board', async () => {
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(true);

    const connectionId = 'conn-backstop-4';
    await roomManager.registerClient(connectionId);
    const client = roomManager.getClient(connectionId);
    client!.sessionId = 'session-backstop-4';
    // No noteBoardWriter call — no hold recorded.

    await roomManager.clearBoardWriterForConnection(connectionId);

    expect(clearBoardWriterIfSpy).not.toHaveBeenCalled();
    expect(publishBoardPresenceSpy).not.toHaveBeenCalled();
    expect(publishSessionSpy).not.toHaveBeenCalled();

    await roomManager.removeClient(connectionId);
  });
});
